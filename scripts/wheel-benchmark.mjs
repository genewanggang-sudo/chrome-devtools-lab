#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  analyzeCompositorFps,
  findTraceWindow,
} from "./frame-rate.mjs";
import { analyzeTrace } from "./analyze-trace.mjs";
import { acquireTraceLock } from "./trace-lock.mjs";
import { runPowerShellNativeWheel } from "./windows-native-wheel.mjs";
import { buildHumanWheelSequence } from "./wheel-sequence.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CDP_SCRIPT = path.join(SCRIPT_DIRECTORY, "cdp.mjs");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_COUNT = 120;
const DEFAULT_DURATION_MS = 2000;
const DEFAULT_SETTLE_MS = 500;
const DEFAULT_POST_FRAMES = 12;
const DEFAULT_TIMEOUT_MS = 60000;
const TRACE_STREAM_CHUNK_BYTES = 1024 * 1024;
const POINTER_SETTLE_MS = 100;
const WHEEL_DELIVERY_WAIT_MAX_MS = 500;
const MAX_IN_FLIGHT_WHEEL_DISPATCHES = 128;
const NATIVE_WHEEL_DELTA_TO_DOM_SCALE = 10 / 9;
const WHEEL_DELTA_EPSILON = 0.01;
const TRACE_PROFILES = Object.freeze({
  none: null,
  fps: [
    "-*",
    "benchmark",
    "cc",
    "disabled-by-default-devtools.timeline",
    "viz",
    "disabled-by-default-display.framedisplayed",
    "blink.user_timing",
  ].join(","),
  "fps-minimal": [
    "-*",
    "benchmark",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-display.framedisplayed",
    "viz",
    "blink.user_timing",
  ].join(","),
  full: [
    "-*",
    "benchmark",
    "cc",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-display.framedisplayed",
    "disabled-by-default-gpu.service",
    "gpu",
    "input",
    "viz",
    "blink.user_timing",
  ].join(","),
  quick: [
    "-*",
    "benchmark",
    "cc",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-display.framedisplayed",
    "disabled-by-default-gpu.service",
    "input",
    "viz",
    "blink.user_timing",
  ].join(","),
});
const TRACE_WHEEL_START_MARKER = "ChromeDevToolsLab.WheelStart";
const TRACE_WHEEL_END_MARKER = "ChromeDevToolsLab.WheelEnd";
const NATIVE_FPS_COUNTER_SOURCE =
  "Chrome DevTools Overlay.setShowFPSCounter";
const LEGACY_MOUSEWHEEL_BRIDGE_SOURCE =
  "temporary legacy mousewheel compatibility relay";
const INPUT_DELIVERY_POLICIES = new Set(["strict", "diagnostic"]);
const SOFT_INPUT_CAPTURE_REASON =
  /^(dom-wheel-event-count-mismatch|dom-wheel-delta-y-sequence-mismatch|legacy-wheel-handler-count-mismatch|dom-wheel-timing-out-of-contract):/;
const WHEEL_PROBE_LISTENER_SCOPE = Object.freeze({
  target: "window",
  phase: "capture",
});
const INPUT_OBSERVATION_SAMPLE_LIMIT = 20;

function classifyWheelObservation(event, canvas, frozenRect, frozenPoint) {
  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  const pathContainsCanvas = path.includes(canvas);
  const coordinatesInsideCanvas =
    event.clientX >= frozenRect.x &&
    event.clientX < frozenRect.x + frozenRect.width &&
    event.clientY >= frozenRect.y &&
    event.clientY < frozenRect.y + frozenRect.height;
  const coordinatesMatchFrozenPoint =
    event.clientX === frozenPoint.x && event.clientY === frozenPoint.y;
  const rejectReasons = [];
  if (event.isTrusted !== true) rejectReasons.push("event-not-trusted");
  if (!pathContainsCanvas) rejectReasons.push("composed-path-missing-frozen-canvas");
  if (!coordinatesInsideCanvas)
    rejectReasons.push("coordinates-outside-frozen-canvas");
  if (!coordinatesMatchFrozenPoint)
    rejectReasons.push("coordinates-do-not-match-frozen-point");
  const describeTarget = (target) => {
    if (target === globalThis) return "WINDOW";
    if (target?.nodeType === 9) return "DOCUMENT";
    const tagName = target?.tagName || target?.constructor?.name || null;
    if (!tagName) return null;
    const id = target?.id ? `#${target.id}` : "";
    const className =
      typeof target?.className === "string" && target.className.trim().length > 0
        ? `.${target.className.trim().split(/\s+/).join(".")}`
        : "";
    return `${tagName}${id}${className}`;
  };
  return {
    accepted: rejectReasons.length === 0,
    rejectReasons,
    checks: {
      isTrusted: event.isTrusted === true,
      composedPathContainsFrozenCanvas: pathContainsCanvas,
      coordinatesInsideFrozenCanvas: coordinatesInsideCanvas,
      coordinatesMatchFrozenPoint,
    },
    event: {
      time: typeof performance?.now === "function" ? performance.now() : null,
      type: event.type || "wheel",
      isTrusted: event.isTrusted === true,
      clientX: event.clientX,
      clientY: event.clientY,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      target: describeTarget(event.target),
      composedPath: path.map(describeTarget).filter(Boolean),
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function integerOption(options, name, fallback, minimum, maximum) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid --${name}: ${options[name]}. Use ${minimum}..${maximum}.`,
    );
  }
  return value;
}

function numberOption(options, name, fallback, minimum, maximum) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid --${name}: ${options[name]}. Use ${minimum}..${maximum}.`,
    );
  }
  return value;
}

function requiredNumberOption(options, name, minimum, maximum) {
  if (options[name] === undefined || options[name] === true) {
    throw new Error(`Wheel benchmark requires --${name} <number>.`);
  }
  return numberOption(options, name, undefined, minimum, maximum);
}

function requiredIntegerOption(options, name, minimum, maximum) {
  if (options[name] === undefined || options[name] === true) {
    throw new Error(`Wheel benchmark requires --${name} <integer>.`);
  }
  return integerOption(options, name, undefined, minimum, maximum);
}

function parseExpectedEnvironmentContract(options) {
  return {
    dpr: requiredNumberOption(options, "expected-dpr", 0.1, 16),
    viewport: {
      width: requiredIntegerOption(
        options,
        "expected-viewport-width",
        1,
        100000,
      ),
      height: requiredIntegerOption(
        options,
        "expected-viewport-height",
        1,
        100000,
      ),
    },
    canvasRect: {
      x: requiredNumberOption(options, "expected-canvas-x", -100000, 100000),
      y: requiredNumberOption(options, "expected-canvas-y", -100000, 100000),
      width: requiredNumberOption(
        options,
        "expected-canvas-width",
        0.01,
        100000,
      ),
      height: requiredNumberOption(
        options,
        "expected-canvas-height",
        0.01,
        100000,
      ),
    },
  };
}

function parsePostFocusWindowPlacement(options, inputBackend) {
  const optionNames = [
    "post-focus-window-left",
    "post-focus-window-top",
    "post-focus-window-width",
    "post-focus-window-height",
  ];
  const supplied = optionNames.filter(
    (name) => options[name] !== undefined && options[name] !== true,
  );
  if (supplied.length === 0) return null;
  if (supplied.length !== optionNames.length) {
    throw new Error(
      `Post-focus window placement requires all of ${optionNames.map((name) => `--${name}`).join(", ")}.`,
    );
  }
  if (inputBackend !== "windows-native") {
    throw new Error(
      "Post-focus window placement is only valid with --input-backend windows-native.",
    );
  }
  return {
    left: requiredIntegerOption(
      options,
      "post-focus-window-left",
      -32768,
      32767,
    ),
    top: requiredIntegerOption(
      options,
      "post-focus-window-top",
      -32768,
      32767,
    ),
    width: requiredIntegerOption(
      options,
      "post-focus-window-width",
      200,
      32768,
    ),
    height: requiredIntegerOption(
      options,
      "post-focus-window-height",
      200,
      32768,
    ),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function selectTarget(options) {
  const host = String(options.host || DEFAULT_HOST);
  const port = integerOption(options, "port", DEFAULT_PORT, 1, 65535);
  const selector = options["target-exact"];
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("Wheel benchmark requires --target-exact <target ID>.");
  }
  const suppliedWebSocketUrl = options["target-websocket-url"];
  if (typeof suppliedWebSocketUrl === "string" && suppliedWebSocketUrl.length > 0) {
    if (!/^ws:\/\//i.test(suppliedWebSocketUrl)) {
      throw new Error("--target-websocket-url must be a ws:// URL.");
    }
    return {
      target: {
        type: "page",
        id: selector,
        title: null,
        url: null,
        webSocketDebuggerUrl: suppliedWebSocketUrl,
      },
      host,
      port,
      targetResolution: "caller-supplied-exact-websocket",
    };
  }
  const targets = await getJson(`http://${host}:${port}/json/list`);
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.id === selector,
  );
  if (!target) throw new Error(`Exact page target was not found: ${selector}`);
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error(`Target has no page WebSocket: ${selector}`);
  }
  return { target, host, port, targetResolution: "cdp-json-list" };
}

function connect(webSocketUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    let connected = false;
    const pending = new Map();
    const oneShotListeners = new Map();
    const persistentListeners = new Map();

    const failPending = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!connected) reject(error);
    };

    const socketFailure = (kind, event) => {
      const pendingMethods = [...pending.values()]
        .map((request) => request.method)
        .join(", ");
      const code = Number.isInteger(event?.code) ? ` code=${event.code}` : "";
      const reason = typeof event?.reason === "string" && event.reason.length > 0
        ? ` reason=${JSON.stringify(event.reason)}`
        : "";
      const clean = typeof event?.wasClean === "boolean"
        ? ` clean=${event.wasClean}`
        : "";
      const waiting = pendingMethods.length > 0
        ? ` pending=[${pendingMethods}]`
        : "";
      return new Error(`CDP WebSocket ${kind}${code}${reason}${clean}${waiting}`);
    };

    const connectTimer = setTimeout(() => {
      failPending(new Error(`Timed out connecting to ${webSocketUrl}`));
      socket.close();
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      connected = true;
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((resolveRequest, rejectRequest) => {
            const requestTimer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`Timed out waiting for ${method}`));
            }, timeoutMs);
              pending.set(id, {
                method,
                resolve: (value) => {
                clearTimeout(requestTimer);
                resolveRequest(value);
              },
              reject: (error) => {
                clearTimeout(requestTimer);
                rejectRequest(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        waitForEvent(method) {
          return new Promise((resolveEvent) => {
            const listeners = oneShotListeners.get(method) || [];
            listeners.push(resolveEvent);
            oneShotListeners.set(method, listeners);
          });
        },
        onEvent(method, handler) {
          const listeners = persistentListeners.get(method) || [];
          listeners.push(handler);
          persistentListeners.set(method, listeners);
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id != null) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error)
          request.reject(new Error(message.error.message || "CDP error"));
        else request.resolve(message.result || {});
        return;
      }
      for (const handler of persistentListeners.get(message.method) || []) {
        handler(message.params || {});
      }
      const listeners = oneShotListeners.get(message.method) || [];
      oneShotListeners.delete(message.method);
      for (const listener of listeners) listener(message.params || {});
    });

    socket.addEventListener("error", (event) =>
      failPending(socketFailure("error", event)),
    );
    socket.addEventListener("close", (event) => {
      if (pending.size > 0) failPending(socketFailure("closed", event));
    });
  });
}

async function evaluate(session, expression) {
  const response = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    const description =
      details.exception?.description ||
      details.text ||
      "Runtime.evaluate failed";
    const stack = details.exception?.stack || details.stackTrace;
    throw new Error(`${description}\n${JSON.stringify({ details, stack })}`);
  }
  return response.result?.value;
}

const PAGE_PERFORMANCE_METRIC_NAMES = Object.freeze([
  "Timestamp",
  "Documents",
  "Frames",
  "JSEventListeners",
  "Nodes",
  "LayoutObjects",
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "DevToolsCommandDuration",
  "ScriptDuration",
  "TaskDuration",
  "ThreadTime",
  "ProcessTime",
  "JSHeapUsedSize",
  "JSHeapTotalSize",
]);

async function readPagePerformanceSnapshot(session, phase) {
  const snapshot = {
    schemaVersion: 1,
    phase,
    capturedAtEpochMs: Date.now(),
    pageNowMs: null,
    metrics: {},
    heap: null,
    domCounters: null,
    resources: null,
    errors: [],
  };
  try {
    await session.send("Performance.enable");
    const response = await session.send("Performance.getMetrics");
    for (const metric of response.metrics || []) {
      if (PAGE_PERFORMANCE_METRIC_NAMES.includes(metric.name)) {
        snapshot.metrics[metric.name] = metric.value;
      }
    }
  } catch (error) {
    snapshot.errors.push(`Performance.getMetrics: ${error.message}`);
  }
  try {
    const response = await session.send("Runtime.getHeapUsage");
    snapshot.heap = {
      usedSize: response.usedSize ?? null,
      totalSize: response.totalSize ?? null,
      embedderHeapUsedSize: response.embedderHeapUsedSize ?? null,
      mallocedSize: response.mallocedSize ?? null,
    };
  } catch (error) {
    snapshot.errors.push(`Runtime.getHeapUsage: ${error.message}`);
  }
  try {
    const response = await session.send("Memory.getDOMCounters");
    snapshot.domCounters = {
      documents: response.documents ?? null,
      nodes: response.nodes ?? null,
      jsEventListeners: response.jsEventListeners ?? null,
    };
  } catch (error) {
    snapshot.errors.push(`Memory.getDOMCounters: ${error.message}`);
  }
  try {
    snapshot.resources = await evaluate(
      session,
      `(() => {
        const entries = performance.getEntriesByType("resource");
        const durations = entries
          .map((entry) => entry.duration)
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        const percentile = (values, ratio) =>
          values.length === 0
            ? null
            : values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))];
        return {
          count: entries.length,
          transferSize: entries.reduce(
            (sum, entry) => sum + (Number.isFinite(entry.transferSize) ? entry.transferSize : 0),
            0,
          ),
          encodedBodySize: entries.reduce(
            (sum, entry) => sum + (Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : 0),
            0,
          ),
          decodedBodySize: entries.reduce(
            (sum, entry) => sum + (Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : 0),
            0,
          ),
          durationP50Ms: percentile(durations, 0.5),
          durationP95Ms: percentile(durations, 0.95),
          durationMaxMs: durations.length === 0 ? null : durations[durations.length - 1],
          pageNowMs: performance.now(),
        };
      })()`,
    );
    snapshot.pageNowMs = snapshot.resources?.pageNowMs ?? null;
  } catch (error) {
    snapshot.errors.push(`Resource Timing: ${error.message}`);
  }
  return snapshot;
}

function subtractNumericRecord(before, after) {
  const result = {};
  for (const key of new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ])) {
    const left = before?.[key];
    const right = after?.[key];
    result[key] = Number.isFinite(left) && Number.isFinite(right) ? right - left : null;
  }
  return result;
}

function diffPagePerformance(before, after) {
  return {
    schemaVersion: 1,
    window: {
      durationMs:
        Number.isFinite(before?.pageNowMs) && Number.isFinite(after?.pageNowMs)
          ? after.pageNowMs - before.pageNowMs
          : null,
      startedAtEpochMs: before?.capturedAtEpochMs ?? null,
      endedAtEpochMs: after?.capturedAtEpochMs ?? null,
    },
    before,
    after,
    delta: {
      metrics: subtractNumericRecord(before?.metrics, after?.metrics),
      heap: subtractNumericRecord(before?.heap, after?.heap),
      domCounters: subtractNumericRecord(before?.domCounters, after?.domCounters),
      resources: subtractNumericRecord(before?.resources, after?.resources),
    },
    errors: [...(before?.errors || []), ...(after?.errors || [])],
  };
}

async function setNativeFpsCounter(session, show) {
  if (show) {
    // Overlay.enable is session-scoped, so keep it in the same CDP session as
    // the wheel operation. Otherwise a separate `cdp call` can appear to
    // succeed but disappear when its WebSocket closes.
    await session.send("DOM.enable");
    await session.send("Overlay.enable");
  }
  await session.send("Overlay.setShowFPSCounter", { show });
}

async function captureCanvasHash(session, canvas) {
  const response = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    optimizeForSpeed: true,
    clip: {
      x: canvas.x,
      y: canvas.y,
      width: canvas.width,
      height: canvas.height,
      scale: 1,
    },
  });
  return createHash("sha256")
    .update(Buffer.from(response.data, "base64"))
    .digest("hex");
}

async function installProbe(
  session,
  useLegacyMousewheelBridge,
  point,
  traceMarkersEnabled,
) {
  return evaluate(
    session,
    `(() => {
      const classifyWheelObservation = ${classifyWheelObservation.toString()};
      const canvases = [...document.querySelectorAll("canvas")]
        .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height);
      const candidate = canvases[0];
      if (!candidate) throw new Error("No visible canvas is available");
      const inputTarget = document.elementFromPoint(
        ${JSON.stringify(point.x)},
        ${JSON.stringify(point.y)},
      );
      if (inputTarget !== candidate.canvas) {
        const targetDescription = inputTarget
          ? [inputTarget.tagName, inputTarget.id && "#" + inputTarget.id, inputTarget.className && "." + String(inputTarget.className).trim().split(" ").filter(Boolean).join(".")]
              .filter(Boolean)
              .join("")
          : "null";
        throw new Error("Wheel input point is blocked; expected the largest canvas but elementFromPoint resolved " + targetDescription + ".");
      }
      const frozenRect = {
        x: candidate.rect.x,
        y: candidate.rect.y,
        width: candidate.rect.width,
        height: candidate.rect.height,
      };
      const frozenPoint = {
        x: ${JSON.stringify(point.x)},
        y: ${JSON.stringify(point.y)},
      };
      const createObservationChannel = (contributesToTrustedInput, contributesToInputLatencyKpi) => ({
        observedCount: 0,
        acceptedCount: 0,
        filteredCount: 0,
        filteredReasonCounts: {},
        samples: [],
        contributesToTrustedInput,
        contributesToInputLatencyKpi,
      });
      const state = {
        wheelEvents: [],
        legacyMousewheelEvents: [],
        relayedLegacyEvents: new WeakSet(),
        rafTimestamps: [],
        longTasks: [],
        pageErrors: [],
        firstInput: null,
        lastInput: null,
        observer: null,
        rafHandle: 0,
        onWheel: null,
        onMousewheel: null,
        onLegacyMousewheelBridge: null,
        legacyMousewheelBridge: null,
        onError: null,
        onRejection: null,
        inputObservation: {
          schemaVersion: 1,
          listener: {
            target: ${JSON.stringify(WHEEL_PROBE_LISTENER_SCOPE.target)},
            phase: ${JSON.stringify(WHEEL_PROBE_LISTENER_SCOPE.phase)},
          },
          acceptedWheelContract: {
            isTrusted: true,
            composedPathContainsFrozenCanvas: true,
            coordinatesInsideFrozenCanvas: true,
            coordinatesMatchFrozenPoint: true,
          },
          frozenTarget: {
            tagName: candidate.canvas.tagName,
            id: candidate.canvas.id || null,
            className: typeof candidate.canvas.className === "string" ? candidate.canvas.className : null,
            rect: frozenRect,
            point: frozenPoint,
          },
          channels: {
            nativeWheel: createObservationChannel(true, true),
            browserMousewheel: createObservationChannel(false, false),
            pluginRelayMousewheel: createObservationChannel(false, false),
          },
        },
      };
      state.onWheel = (event) => {
        const observation = classifyWheelObservation(
          event,
          candidate.canvas,
          frozenRect,
          frozenPoint,
        );
        const channel = state.inputObservation.channels.nativeWheel;
        channel.observedCount += 1;
        if (channel.samples.length < ${INPUT_OBSERVATION_SAMPLE_LIMIT}) {
          channel.samples.push(observation);
        }
        if (!observation.accepted) {
          channel.filteredCount += 1;
          for (const reason of observation.rejectReasons) {
            channel.filteredReasonCounts[reason] =
              (channel.filteredReasonCounts[reason] || 0) + 1;
          }
          return;
        }
        channel.acceptedCount += 1;
        const now = observation.event.time;
        if (${traceMarkersEnabled ? "true" : "false"} && state.wheelEvents.length === 0) {
          performance.mark(${JSON.stringify(TRACE_WHEEL_START_MARKER)});
          console.timeStamp(${JSON.stringify(TRACE_WHEEL_START_MARKER)});
        }
        state.firstInput ??= now;
        state.lastInput = now;
        state.wheelEvents.push({
          time: now,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          isTrusted: event.isTrusted,
          clientX: event.clientX,
          clientY: event.clientY,
          targetTag: event.target?.tagName || null,
        });
      };
      state.onMousewheel = (event) => {
        const source = state.relayedLegacyEvents.has(event)
          ? "plugin-relay"
          : "browser";
        const observedEvent = {
          time: performance.now(),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          wheelDelta: event.wheelDelta,
          wheelDeltaX: event.wheelDeltaX,
          wheelDeltaY: event.wheelDeltaY,
          isTrusted: event.isTrusted,
          clientX: event.clientX,
          clientY: event.clientY,
          defaultPrevented: event.defaultPrevented,
          targetTag: event.target?.tagName || null,
          source,
        };
        state.legacyMousewheelEvents.push(observedEvent);
        const channel = source === "plugin-relay"
          ? state.inputObservation.channels.pluginRelayMousewheel
          : state.inputObservation.channels.browserMousewheel;
        channel.observedCount += 1;
        channel.acceptedCount += 1;
        if (channel.samples.length < ${INPUT_OBSERVATION_SAMPLE_LIMIT}) {
          channel.samples.push(observedEvent);
        }
      };
      if (${useLegacyMousewheelBridge ? "true" : "false"}) {
        state.legacyMousewheelBridge = { relayEvents: [] };
        state.onLegacyMousewheelBridge = (event) => {
          if (!event.isTrusted || event.defaultPrevented) {
            state.legacyMousewheelBridge.relayEvents.push({
              relayed: false,
              reason: !event.isTrusted ? "outer-wheel-not-trusted" : "outer-wheel-already-prevented",
            });
            return;
          }
          const legacyEvent = new WheelEvent("mousewheel", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: event.clientX,
            clientY: event.clientY,
            screenX: event.screenX,
            screenY: event.screenY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            deltaMode: event.deltaMode,
          });
          Object.defineProperties(legacyEvent, {
            wheelDelta: { value: -event.deltaY },
            wheelDeltaX: { value: -event.deltaX },
            wheelDeltaY: { value: -event.deltaY },
          });
          state.relayedLegacyEvents.add(legacyEvent);
          candidate.canvas.dispatchEvent(legacyEvent);
          if (legacyEvent.defaultPrevented) event.preventDefault();
          state.legacyMousewheelBridge.relayEvents.push({
            relayed: true,
            outerIsTrusted: event.isTrusted,
            relayedIsTrusted: legacyEvent.isTrusted,
            outerDeltaX: event.deltaX,
            outerDeltaY: event.deltaY,
            wheelDelta: legacyEvent.wheelDelta,
            defaultPrevented: legacyEvent.defaultPrevented,
          });
        };
        candidate.canvas.addEventListener("wheel", state.onLegacyMousewheelBridge);
      }
      state.onError = (event) => state.pageErrors.push(String(event.error || event.message || "page error"));
      state.onRejection = (event) => state.pageErrors.push(String(event.reason || "unhandled rejection"));
      addEventListener("error", state.onError);
      addEventListener("unhandledrejection", state.onRejection);
      window.addEventListener("wheel", state.onWheel, true);
      window.addEventListener("mousewheel", state.onMousewheel, true);
      if (typeof PerformanceObserver === "function") {
        try {
          state.observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
          });
          state.observer.observe({ type: "longtask", buffered: false });
        } catch {}
      }
      const tick = (timestamp) => {
        state.rafTimestamps.push(timestamp);
        state.rafHandle = requestAnimationFrame(tick);
      };
      state.rafHandle = requestAnimationFrame(tick);
      globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__ = {
        state,
        canvas: candidate.canvas,
        rect: frozenRect,
        point: frozenPoint,
      };
      return {
        rect: frozenRect,
        drawingBuffer: { width: candidate.canvas.width, height: candidate.canvas.height },
        dpr: devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
        visibilityState: document.visibilityState,
        readyState: document.readyState,
        inputObservation: {
          listener: state.inputObservation.listener,
          acceptedWheelContract: state.inputObservation.acceptedWheelContract,
          frozenTarget: state.inputObservation.frozenTarget,
        },
      };
    })()`,
  );
}

async function disposeProbe(session) {
  return evaluate(
    session,
    `(() => {
      const probe = globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__;
      if (!probe) return { existed: false, residue: false };
      const { state, canvas } = probe;
      const cleanup = { attempted: true, completed: [], errors: [] };
      const attempt = (name, action) => {
        try {
          action();
          cleanup.completed.push(name);
        } catch (error) {
          cleanup.errors.push({
            name,
            message: String(error?.stack || error?.message || error),
          });
        }
      };
      attempt("cancel-animation-frame", () => cancelAnimationFrame(state.rafHandle));
      attempt("remove-window-wheel-capture", () =>
        window.removeEventListener("wheel", state.onWheel, true),
      );
      attempt("remove-window-mousewheel-capture", () =>
        window.removeEventListener("mousewheel", state.onMousewheel, true),
      );
      if (state.onLegacyMousewheelBridge) {
        attempt("remove-canvas-legacy-relay", () =>
          canvas.removeEventListener("wheel", state.onLegacyMousewheelBridge),
        );
      }
      attempt("remove-window-error", () =>
        removeEventListener("error", state.onError),
      );
      attempt("remove-window-unhandledrejection", () =>
        removeEventListener("unhandledrejection", state.onRejection),
      );
      attempt("disconnect-long-task-observer", () => state.observer?.disconnect());
      const rect = canvas.getBoundingClientRect();
      const snapshot = {
        wheelEvents: state.wheelEvents,
        legacyMousewheelEvents: state.legacyMousewheelEvents,
        rafTimestamps: state.rafTimestamps,
        longTasks: state.longTasks,
        pageErrors: state.pageErrors,
        inputObservation: state.inputObservation,
        legacyMousewheelBridge: state.legacyMousewheelBridge,
        firstInput: state.firstInput,
        lastInput: state.lastInput,
        environment: {
          dpr: devicePixelRatio,
          viewport: { width: innerWidth, height: innerHeight },
          canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          drawingBuffer: { width: canvas.width, height: canvas.height },
        },
      };
      attempt("delete-global-probe", () => {
        delete globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__;
      });
      const residue = globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__ !== undefined;
      cleanup.residue = residue;
      cleanup.complete = cleanup.errors.length === 0 && residue === false;
      return { existed: true, residue, snapshot, cleanup };
    })()`,
  );
}

async function resetProbeForMeasurement(session) {
  return evaluate(
    session,
    `(() => {
      const probe = globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__;
      if (!probe) throw new Error("Wheel probe is not installed");
      const { state } = probe;
      state.wheelEvents.length = 0;
      state.legacyMousewheelEvents.length = 0;
      state.rafTimestamps.length = 0;
      state.longTasks.length = 0;
      state.firstInput = null;
      state.lastInput = null;
      for (const channel of Object.values(state.inputObservation.channels)) {
        channel.observedCount = 0;
        channel.acceptedCount = 0;
        channel.filteredCount = 0;
        channel.filteredReasonCounts = {};
        channel.samples.length = 0;
      }
      if (state.legacyMousewheelBridge) {
        state.legacyMousewheelBridge.relayEvents.length = 0;
      }
      return { resetAt: performance.now() };
    })()`,
  );
}

async function readProbeEnvironment(session) {
  return evaluate(
    session,
    `(() => {
      const probe = globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__;
      if (!probe) throw new Error("Wheel probe is not installed");
      const rect = probe.canvas.getBoundingClientRect();
      const pointTarget = document.elementFromPoint(probe.point.x, probe.point.y);
      return {
        environment: {
          dpr: devicePixelRatio,
          viewport: { width: innerWidth, height: innerHeight },
          canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          drawingBuffer: { width: probe.canvas.width, height: probe.canvas.height },
        },
        point: probe.point,
        pointInsideCanvas:
          probe.point.x >= rect.x &&
          probe.point.x < rect.x + rect.width &&
          probe.point.y >= rect.y &&
          probe.point.y < rect.y + rect.height,
        pointTargetMatchesCanvas: pointTarget === probe.canvas,
        visibilityState: document.visibilityState,
      };
    })()`,
  );
}

function validatePostFocusEnvironment(readback, frozenEnvironment) {
  const comparison = compareEnvironmentContract(
    readback.environment,
    frozenEnvironment,
  );
  const invalidReasons = comparison.mismatches.map(
    (mismatch) =>
      `${mismatch.field}:expected=${mismatch.expected}:actual=${mismatch.actual}`,
  );
  if (readback.pointInsideCanvas !== true)
    invalidReasons.push("frozen-point-outside-canvas");
  if (readback.pointTargetMatchesCanvas !== true)
    invalidReasons.push("frozen-point-no-longer-targets-canvas");
  if (readback.visibilityState !== "visible")
    invalidReasons.push(`visibility-state:${readback.visibilityState}`);
  return {
    frozen: frozenEnvironment,
    actual: readback.environment,
    matches: invalidReasons.length === 0,
    mismatches: comparison.mismatches,
    invalidReasons,
    point: readback.point,
    pointInsideCanvas: readback.pointInsideCanvas === true,
    pointTargetMatchesCanvas: readback.pointTargetMatchesCanvas === true,
    visibilityState: readback.visibilityState,
  };
}

async function readTraceStream(session, handle) {
  const chunks = [];
  let eof = false;
  while (!eof) {
    const result = await session.send("IO.read", {
      handle,
      size: TRACE_STREAM_CHUNK_BYTES,
    });
    chunks.push(
      result.base64Encoded
        ? Buffer.from(result.data || "", "base64").toString("utf8")
        : result.data || "",
    );
    eof = result.eof === true;
  }
  await session.send("IO.close", { handle });
  return chunks.join("");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializeError(error) {
  if (error === null || error === undefined) return null;
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

async function invokeCleanupOnce(state, cleanup) {
  if (state.started !== true || state.attempted === true) return state.result;
  state.attempted = true;
  try {
    state.result = await cleanup();
    return state.result;
  } catch (error) {
    state.error = serializeError(error);
    const cleanupError = new Error(
      `Wheel probe cleanup failed: ${error?.message || String(error)}`,
      { cause: error },
    );
    cleanupError.isProbeCleanupError = true;
    throw cleanupError;
  }
}

function probeCleanupContractError(disposed) {
  if (!disposed || disposed.existed !== true) return null;
  if (disposed.residue === false && disposed.cleanup?.complete === true) {
    return null;
  }
  return new Error(
    `Wheel probe cleanup was incomplete: ${JSON.stringify({
      residue: disposed.residue,
      cleanup: disposed.cleanup || null,
    })}`,
  );
}

async function waitForProbeWheelDelivery(session, expectedCount, timeoutMs) {
  const startedAt = performance.now();
  const result = await evaluate(
    session,
    `(() => new Promise((resolve) => {
      const probe = globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__;
      if (!probe) {
        resolve({ available: false, expectedCount: ${expectedCount}, receivedCount: null, waitedMilliseconds: 0, timedOut: false, reason: "probe-missing" });
        return;
      }
      const startedAt = performance.now();
      const finish = (reason, timedOut) => resolve({
        available: true,
        expectedCount: ${expectedCount},
        receivedCount: probe.state.wheelEvents.length,
        waitedMilliseconds: performance.now() - startedAt,
        timedOut,
        reason,
      });
      const check = () => {
        if (probe.state.wheelEvents.length >= ${expectedCount}) {
          finish("expected-event-count", false);
          return;
        }
        if (performance.now() - startedAt >= ${timeoutMs}) {
          finish("delivery-timeout", true);
          return;
        }
        setTimeout(check, 4);
      };
      check();
    }))()`,
  );
  return {
    ...result,
    hostWaitedMilliseconds: performance.now() - startedAt,
    timeoutMilliseconds: timeoutMs,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function createExpectedWheelEvents(
  count,
  point,
  deltaMagnitude,
  durationMs,
  seed,
  inputBackend = "cdp",
) {
  return buildHumanWheelSequence({
    count,
    durationMs,
    deltaMagnitude,
    seed,
    maximumRunLength: 10,
    typicalBurstMaximum: 4,
  }).map((event) => {
    const nativeDeltaY =
      inputBackend === "windows-native"
        ? Math.max(1, Math.round(Math.abs(event.deltaY) / NATIVE_WHEEL_DELTA_TO_DOM_SCALE)) *
          -Math.sign(event.deltaY)
        : null;
    return {
      isTrusted: true,
      clientX: point.x,
      clientY: point.y,
      deltaMode: 0,
      deltaX: 0,
      deltaY:
        nativeDeltaY === null
          ? event.deltaY
          : -nativeDeltaY * NATIVE_WHEEL_DELTA_TO_DOM_SCALE,
      requestedDeltaY: event.deltaY,
      nativeDeltaY,
      offsetMilliseconds: event.offsetMilliseconds,
    };
  });
}

function runJsonChild(scriptPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: SCRIPT_DIRECTORY,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`${path.basename(scriptPath)} timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${path.basename(scriptPath)} failed to start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${path.basename(scriptPath)} failed with ${signal ? `signal ${signal}` : `code ${code}`}: ${(stderr || stdout).trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`${path.basename(scriptPath)} returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function focusNativeTarget(targetId, port, timeoutMs) {
  return runJsonChild(
    CDP_SCRIPT,
    [
      "focus",
      "--target-exact",
      targetId,
      "--port",
      String(port),
      "--allow-window-focus",
      "--no-focus-emulation",
      "--no-page-bring-to-front",
      "--timeout",
      String(timeoutMs),
    ],
    timeoutMs,
  );
}

async function placeNativeTargetAfterFocus(
  targetId,
  port,
  timeoutMs,
  requestedBounds,
) {
  return runJsonChild(
    CDP_SCRIPT,
    [
      "window-place",
      "--target-exact",
      targetId,
      "--port",
      String(port),
      "--allow-window-move",
      "--left",
      String(requestedBounds.left),
      "--top",
      String(requestedBounds.top),
      "--width",
      String(requestedBounds.width),
      "--height",
      String(requestedBounds.height),
      "--timeout",
      String(timeoutMs),
    ],
    timeoutMs,
  );
}

function validatePostFocusPlacement(
  placement,
  requestedBounds,
  resolvedFocus,
  page,
) {
  if (placement?.valid !== true) {
    throw new Error(
      `Post-focus exact-target window placement was not valid: ${JSON.stringify(placement)}`,
    );
  }
  const focusedWindowHandle = Number(
    resolvedFocus.activation?.window?.mainWindowHandle,
  );
  const placedWindowHandle = Number(placement.resolution?.candidate?.handle);
  if (
    !Number.isSafeInteger(focusedWindowHandle) ||
    !Number.isSafeInteger(placedWindowHandle) ||
    focusedWindowHandle !== placedWindowHandle
  ) {
    throw new Error(
      `Post-focus placement resolved a different Chrome window: focused=${focusedWindowHandle} placed=${placedWindowHandle}.`,
    );
  }
  const pageReadback = placement.readback?.page;
  const invalidReasons = [];
  if (pageReadback?.innerWidth !== page.viewport.width) {
    invalidReasons.push(
      `innerWidth:expected=${page.viewport.width}:actual=${pageReadback?.innerWidth}`,
    );
  }
  if (pageReadback?.innerHeight !== page.viewport.height) {
    invalidReasons.push(
      `innerHeight:expected=${page.viewport.height}:actual=${pageReadback?.innerHeight}`,
    );
  }
  if (pageReadback?.outerWidth !== requestedBounds.width) {
    invalidReasons.push(
      `outerWidth:expected=${requestedBounds.width}:actual=${pageReadback?.outerWidth}`,
    );
  }
  if (pageReadback?.outerHeight !== requestedBounds.height) {
    invalidReasons.push(
      `outerHeight:expected=${requestedBounds.height}:actual=${pageReadback?.outerHeight}`,
    );
  }
  if (invalidReasons.length > 0) {
    throw new Error(
      `Post-focus page/window readback changed the frozen viewport contract: ${invalidReasons.join(" ")}`,
    );
  }
  return {
    requestedBounds,
    focusedWindowHandle,
    placedWindowHandle,
    evidence: placement,
  };
}

async function dispatchNativeWheelSequence({
  session,
  target,
  port,
  page,
  frozenEnvironment,
  expectedEvents,
  durationMs,
  timeoutMs,
  postFocusWindowBounds,
}) {
  if (process.platform !== "win32") {
    throw new Error("Windows native wheel input is only supported on Windows.");
  }
  const resolvedFocus = await focusNativeTarget(target.id, port, timeoutMs);
  const processId = Number(resolvedFocus.activation?.window?.processId);
  if (!Number.isInteger(processId) || processId <= 0 || resolvedFocus.activation?.window?.focused !== true) {
    throw new Error(`Dedicated Chrome window was not focused: ${JSON.stringify(resolvedFocus.activation?.window || null)}`);
  }
  const postFocusPlacement = postFocusWindowBounds === null
    ? null
    : validatePostFocusPlacement(
        await placeNativeTargetAfterFocus(
          target.id,
          port,
          timeoutMs,
          postFocusWindowBounds,
        ),
        postFocusWindowBounds,
        resolvedFocus,
        page,
      );
  const postFocusEnvironmentReadback = await readProbeEnvironment(session);
  const postFocusEnvironment = validatePostFocusEnvironment(
    postFocusEnvironmentReadback,
    frozenEnvironment,
  );
  if (!postFocusEnvironment.matches) {
    throw new Error(
      `Post-focus environment changed before native wheel dispatch; sentCount=0 ${postFocusEnvironment.invalidReasons.join(" ")}`,
    );
  }
  const nativeEvents = expectedEvents.map((event) => ({
    offsetMilliseconds: event.offsetMilliseconds,
    deltaY: event.nativeDeltaY ?? event.deltaY,
  }));
  const startedAt = performance.now();
  const native = await runPowerShellNativeWheel({
    processId,
    foregroundWindowHandle:
      resolvedFocus.activation.window.mainWindowHandle,
    viewportPoint: {
      x: expectedEvents[0].clientX,
      y: expectedEvents[0].clientY,
    },
    viewport: {
      width: page.viewport.width,
      height: page.viewport.height,
      dpr: page.dpr,
    },
    events: nativeEvents,
    timeoutMs: timeoutMs + durationMs,
  });
  const endedAt = performance.now();
  return {
    dispatchAcks: native.sentCount,
    dispatchedEventCount: native.sentCount,
    dispatchStartedAt: startedAt,
    dispatchEndedAt: endedAt,
    maximumDispatchScheduleErrorMilliseconds: native.maximumScheduleErrorMilliseconds,
    maximumDispatchAckLatencyMilliseconds: null,
    maximumInFlightObserved: 1,
    maximumInFlightAllowed: 1,
    dispatchErrors: native.sentCount === expectedEvents.length ? [] : [`native sent ${native.sentCount}/${expectedEvents.length} events`],
    nativeInput: {
      backend: "windows-SendInput",
      processId,
      focus: resolvedFocus,
      postFocusEnvironment,
      postFocusPlacement,
      screenPoint: native.screenPoint,
      cursorLockedDuringDispatch:
        native.cursorLockedDuringDispatch === true,
      renderWidget: native.renderWidget,
      foregroundWindowHandle: native.foregroundWindowHandle,
      focusLease: native.focusLease,
      windowDpi: native.windowDpi,
      monitor: native.monitor,
      sentCount: native.sentCount,
      requestedCount: native.requestedCount,
      elapsedMilliseconds: native.elapsedMilliseconds,
      maximumScheduleErrorMilliseconds: native.maximumScheduleErrorMilliseconds,
      targeting: native.targeting || null,
    },
  };
}

async function dispatchWheelSequence(
  session,
  expectedEvents,
  durationMs,
  maximumInFlight = MAX_IN_FLIGHT_WHEEL_DISPATCHES,
  onDispatchComplete = null,
) {
  const dispatchStartedAt = performance.now();
  let dispatchAcks = 0;
  let maximumDispatchScheduleErrorMilliseconds = 0;
  let maximumDispatchAckLatencyMilliseconds = 0;
  let maximumInFlightObserved = 0;
  const dispatchErrors = [];
  const pendingAcks = new Set();
  let dispatchedEventCount = 0;

  for (let index = 0; index < expectedEvents.length; index += 1) {
    const due = dispatchStartedAt + expectedEvents[index].offsetMilliseconds;
    const delay = due - performance.now();
    if (delay > 0) await sleep(delay);
    if (pendingAcks.size >= maximumInFlight) {
      dispatchErrors.push(
        `maximum in-flight wheel dispatches exceeded: limit=${maximumInFlight} index=${index}`,
      );
      break;
    }
    const expectedEvent = expectedEvents[index];
    const sentAt = performance.now();
    maximumDispatchScheduleErrorMilliseconds = Math.max(
      maximumDispatchScheduleErrorMilliseconds,
      Math.abs(sentAt - due),
    );
    let acknowledgement;
    acknowledgement = session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: expectedEvent.clientX,
      y: expectedEvent.clientY,
      deltaX: expectedEvent.deltaX,
      deltaY: expectedEvent.deltaY,
      modifiers: 0,
    }).then(
      () => {
        dispatchAcks += 1;
        maximumDispatchAckLatencyMilliseconds = Math.max(
          maximumDispatchAckLatencyMilliseconds,
          performance.now() - sentAt,
        );
        pendingAcks.delete(acknowledgement);
      },
      (error) => {
        dispatchErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        pendingAcks.delete(acknowledgement);
      },
    );
    pendingAcks.add(acknowledgement);
    dispatchedEventCount += 1;
    maximumInFlightObserved = Math.max(
      maximumInFlightObserved,
      pendingAcks.size,
    );
  }

  const dispatchEndedAt = performance.now();
  if (onDispatchComplete !== null) await onDispatchComplete();
  await Promise.all([...pendingAcks]);
  return {
    dispatchAcks,
    dispatchedEventCount,
    dispatchStartedAt,
    dispatchEndedAt,
    maximumDispatchScheduleErrorMilliseconds,
    maximumDispatchAckLatencyMilliseconds,
    maximumInFlightObserved,
    maximumInFlightAllowed: maximumInFlight,
    dispatchErrors,
  };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mismatchIndexes(actualEvents, expectedEvents, predicate) {
  const indexes = [];
  const comparableCount = Math.min(actualEvents.length, expectedEvents.length);
  for (let index = 0; index < comparableCount; index += 1) {
    if (!predicate(actualEvents[index], expectedEvents[index])) {
      indexes.push(index);
    }
  }
  return indexes;
}

function matchesDeltaSequenceAllowingCoalescing(actualEvents, expectedEvents) {
  let expectedIndex = 0;
  for (const actual of actualEvents) {
    const actualDirection = Math.sign(actual.deltaY);
    if (actualDirection === 0) return false;

    let accumulatedDelta = 0;
    while (
      expectedIndex < expectedEvents.length &&
      Math.sign(expectedEvents[expectedIndex].deltaY) === actualDirection &&
      Math.abs(accumulatedDelta) < Math.abs(actual.deltaY)
    ) {
      accumulatedDelta += expectedEvents[expectedIndex].deltaY;
      expectedIndex += 1;
    }
    if (Math.abs(accumulatedDelta - actual.deltaY) > WHEEL_DELTA_EPSILON) return false;
  }
  return expectedIndex === expectedEvents.length;
}

function validateWheelEventContract(actualEvents, expectedEvents) {
  const mismatch = {
    isTrusted: mismatchIndexes(
      actualEvents,
      expectedEvents,
      (actual, expected) => actual.isTrusted === expected.isTrusted,
    ),
    coordinates: mismatchIndexes(
      actualEvents,
      expectedEvents,
      (actual, expected) =>
        actual.clientX === expected.clientX &&
        actual.clientY === expected.clientY,
    ),
    deltaMode: mismatchIndexes(
      actualEvents,
      expectedEvents,
      (actual, expected) => actual.deltaMode === expected.deltaMode,
    ),
    deltaX: mismatchIndexes(
      actualEvents,
      expectedEvents,
      (actual, expected) => actual.deltaX === expected.deltaX,
    ),
    deltaY: mismatchIndexes(
      actualEvents,
      expectedEvents,
      (actual, expected) =>
        Math.abs(actual.deltaY - expected.deltaY) <= WHEEL_DELTA_EPSILON,
    ),
  };
  const eventCountMatches = actualEvents.length === expectedEvents.length;
  const exactSequenceMatches =
    eventCountMatches &&
    Object.values(mismatch).every((indexes) => indexes.length === 0);
  const exactDeltaSequenceMatches =
    eventCountMatches && mismatch.deltaY.length === 0;
  const deltaSequenceMatchesAllowingCoalescing =
    exactDeltaSequenceMatches ||
    matchesDeltaSequenceAllowingCoalescing(actualEvents, expectedEvents);
  const sequenceMatchesAllowingCoalescing =
    deltaSequenceMatchesAllowingCoalescing &&
    mismatch.isTrusted.length === 0 &&
    mismatch.coordinates.length === 0 &&
    mismatch.deltaMode.length === 0 &&
    mismatch.deltaX.length === 0;
  return {
    eventCountMatches,
    exactSequenceMatches,
    deltaSequenceMatchesAllowingCoalescing,
    sequenceMatchesAllowingCoalescing,
    deliveryMode: exactSequenceMatches
      ? "exact"
      : sequenceMatchesAllowingCoalescing
        ? "coalesced"
        : "mismatch",
    coalescedEventCount: Math.max(0, expectedEvents.length - actualEvents.length),
    expectedEventCount: expectedEvents.length,
    receivedEventCount: actualEvents.length,
    expectedDeltaYSequenceSha256: sha256Json(
      expectedEvents.map((event) => event.deltaY),
    ),
    receivedDeltaYSequenceSha256: sha256Json(
      actualEvents.map((event) => event.deltaY),
    ),
    mismatch,
  };
}

function normalizePreflightEnvironment(preflight) {
  return {
    dpr: preflight.dpr,
    viewport: preflight.viewport,
    canvasRect: preflight.rect,
    drawingBuffer: preflight.drawingBuffer,
  };
}

function compareEnvironmentContract(actual, expected) {
  const comparisons = [
    ["dpr", actual.dpr, expected.dpr],
    ["viewport.width", actual.viewport?.width, expected.viewport.width],
    ["viewport.height", actual.viewport?.height, expected.viewport.height],
    ["canvasRect.x", actual.canvasRect?.x, expected.canvasRect.x],
    ["canvasRect.y", actual.canvasRect?.y, expected.canvasRect.y],
    ["canvasRect.width", actual.canvasRect?.width, expected.canvasRect.width],
    [
      "canvasRect.height",
      actual.canvasRect?.height,
      expected.canvasRect.height,
    ],
  ];
  if (expected.drawingBuffer !== undefined) {
    comparisons.push(
      [
        "drawingBuffer.width",
        actual.drawingBuffer?.width,
        expected.drawingBuffer.width,
      ],
      [
        "drawingBuffer.height",
        actual.drawingBuffer?.height,
        expected.drawingBuffer.height,
      ],
    );
  }
  const mismatches = comparisons
    .filter(([, actualValue, expectedValue]) => actualValue !== expectedValue)
    .map(([field, actualValue, expectedValue]) => ({
      field,
      expected: expectedValue,
      actual: actualValue ?? null,
    }));
  return { matches: mismatches.length === 0, mismatches };
}

function summarizeIndexes(indexes) {
  const displayed = indexes.slice(0, 20).join(",");
  return indexes.length <= 20
    ? displayed
    : `${displayed},...(+${indexes.length - 20})`;
}

function addInvalidReason(invalidReasons, code, details) {
  invalidReasons.push(`${code}: ${details}`);
}

function magnitudeRatio(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
  if (expected === 0) return actual === 0 ? 1 : null;
  return actual / expected;
}

function summarizeCaptureValidity(
  strictInvalidReasons,
  diagnostics,
  legacyMousewheelBridge,
  policy,
) {
  const blockingInvalidReasons =
    policy === "diagnostic"
      ? strictInvalidReasons.filter(
          (reason) => !SOFT_INPUT_CAPTURE_REASON.test(reason),
        )
      : [...strictInvalidReasons];
  const expectedCount = diagnostics.expectedEventCount;
  const receivedCount = diagnostics.receivedEventCount;
  const expectedMagnitude = diagnostics.expectedDeltaMagnitudePerDirection;
  const receivedCountRatio = magnitudeRatio(receivedCount, expectedCount);
  const negativeMagnitudeRatio = magnitudeRatio(
    diagnostics.receivedNegativeDeltaMagnitude,
    expectedMagnitude,
  );
  const positiveMagnitudeRatio = magnitudeRatio(
    diagnostics.receivedPositiveDeltaMagnitude,
    expectedMagnitude,
  );
  const mismatch = diagnostics.wheelContract?.mismatch || {};
  const hardMismatchFields = ["isTrusted", "coordinates", "deltaMode", "deltaX"];
  const hardMismatch = hardMismatchFields.filter(
    (field) => Array.isArray(mismatch[field]) && mismatch[field].length > 0,
  );
  const relayConsistent =
    !legacyMousewheelBridge.requested ||
    ((legacyMousewheelBridge.browserLegacyCount || 0) +
      (legacyMousewheelBridge.relayedCount || 0) >=
      receivedCount &&
      legacyMousewheelBridge.pluginRelayObservedCount ===
        legacyMousewheelBridge.relayedCount &&
      legacyMousewheelBridge.preventedCount ===
        legacyMousewheelBridge.relayedCount &&
      legacyMousewheelBridge.relayedEventsAreUntrusted === true);

  if (policy === "diagnostic") {
    if (receivedCountRatio === null || receivedCountRatio < 0.9) {
      addInvalidReason(
        blockingInvalidReasons,
        "diagnostic-input-received-ratio",
        `minimum=0.9 actual=${String(receivedCountRatio)}`,
      );
    }
    if (negativeMagnitudeRatio === null || negativeMagnitudeRatio < 0.95) {
      addInvalidReason(
        blockingInvalidReasons,
        "diagnostic-input-negative-magnitude-ratio",
        `minimum=0.95 actual=${String(negativeMagnitudeRatio)}`,
      );
    }
    if (positiveMagnitudeRatio === null || positiveMagnitudeRatio < 0.95) {
      addInvalidReason(
        blockingInvalidReasons,
        "diagnostic-input-positive-magnitude-ratio",
        `minimum=0.95 actual=${String(positiveMagnitudeRatio)}`,
      );
    }
    if (diagnostics.allReceivedEventsTrusted !== true || hardMismatch.length > 0) {
      addInvalidReason(
        blockingInvalidReasons,
        "diagnostic-input-event-contract",
        `trusted=${String(diagnostics.allReceivedEventsTrusted)} hardMismatch=${hardMismatch.join(",") || "none"}`,
      );
    }
    if (!relayConsistent) {
      addInvalidReason(
        blockingInvalidReasons,
        "diagnostic-input-legacy-relay",
        "legacy mousewheel relay counts are inconsistent with observed native wheel input",
      );
    }
  }

  return {
    policy,
    valid: blockingInvalidReasons.length === 0,
    invalidReasons: blockingInvalidReasons,
    strictValid: strictInvalidReasons.length === 0,
    strictInvalidReasons: [...strictInvalidReasons],
    varianceAccepted:
      policy === "diagnostic" &&
      blockingInvalidReasons.length === 0 &&
      strictInvalidReasons.length > 0,
    variance: {
      receivedCountRatio,
      negativeMagnitudeRatio,
      positiveMagnitudeRatio,
      deliveryMode: diagnostics.wheelContract?.deliveryMode || null,
      relayConsistent,
    },
  };
}

function appendWheelContractInvalidReasons(
  invalidReasons,
  wheelContract,
  expectedEvents,
) {
  if (
    !wheelContract.eventCountMatches &&
    !wheelContract.sequenceMatchesAllowingCoalescing
  ) {
    addInvalidReason(
      invalidReasons,
      "dom-wheel-event-count-mismatch",
      `expected=${wheelContract.expectedEventCount} actual=${wheelContract.receivedEventCount}`,
    );
  }
  const fields = [
    ["isTrusted", "dom-wheel-is-trusted-mismatch", "expected=true"],
    [
      "coordinates",
      "dom-wheel-coordinate-mismatch",
      `expected=(${expectedEvents[0].clientX},${expectedEvents[0].clientY})`,
    ],
    ["deltaMode", "dom-wheel-delta-mode-mismatch", "expected=0"],
    ["deltaX", "dom-wheel-delta-x-mismatch", "expected=0"],
    [
      "deltaY",
      "dom-wheel-delta-y-sequence-mismatch",
      `expectedSequenceSha256=${wheelContract.expectedDeltaYSequenceSha256} actualSequenceSha256=${wheelContract.receivedDeltaYSequenceSha256}`,
    ],
  ];
  for (const [field, code, expected] of fields) {
    if (
      field === "deltaY" &&
      wheelContract.deltaSequenceMatchesAllowingCoalescing
    ) {
      continue;
    }
    const indexes = wheelContract.mismatch[field];
    if (indexes.length > 0) {
      addInvalidReason(
        invalidReasons,
        code,
        `${expected} mismatchIndexes=${summarizeIndexes(indexes)}`,
      );
    }
  }
}

function appendEnvironmentInvalidReasons(
  invalidReasons,
  phase,
  environmentResult,
) {
  for (const mismatch of environmentResult.mismatches) {
    addInvalidReason(
      invalidReasons,
      `${phase}-environment-contract-mismatch`,
      `field=${mismatch.field} expected=${mismatch.expected} actual=${mismatch.actual}`,
    );
  }
}

function calculatePostInputRafIntervals(
  rafTimestamps,
  firstInput,
  maximumIntervalCount,
) {
  if (firstInput === null) return [];
  const postInputTimestamps = rafTimestamps
    .filter((value) => value >= firstInput)
    .slice(0, maximumIntervalCount + 1);
  return postInputTimestamps
    .slice(1)
    .map((value, index) => value - postInputTimestamps[index])
    .filter((value) => Number.isFinite(value) && value > 0);
}

function summarizeVisualChange(
  beforeHash,
  midpointHash,
  afterHash,
  count,
  midpointCaptureEnabled,
) {
  const responseObservedAtMidpoint = midpointCaptureEnabled
    ? beforeHash !== midpointHash
    : null;
  const finalDiffersFromBefore = beforeHash !== afterHash;
  return {
    responseObserved: midpointCaptureEnabled
      ? responseObservedAtMidpoint
      : finalDiffersFromBefore,
    evidenceSource: midpointCaptureEnabled
      ? "midpoint-canvas-screenshot"
      : "post-window-canvas-screenshot",
    measurementWindowContainsCanvasScreenshot: midpointCaptureEnabled,
    baselineCapturedAfterPointerSettle: true,
    midpointCaptureEnabled,
    responseObservedAtMidpoint,
    midpointCaptureAfterEventCount: midpointCaptureEnabled ? count / 2 : null,
    midpointCaptureBeforeDirectionReversal: midpointCaptureEnabled ? true : null,
    finalDiffersFromBefore,
    finalReturnedToBaseline: beforeHash === afterHash,
    beforeSha256: beforeHash,
    midpointSha256: midpointHash,
    afterSha256: afterHash,
  };
}

function summarizeTraceCompleteness(trace, complete, bufferUsageSamples) {
  const traceEventArrayPresent = Array.isArray(trace.traceEvents);
  const traceEventCount = traceEventArrayPresent ? trace.traceEvents.length : 0;
  const maximumBufferPercentFull = bufferUsageSamples.reduce(
    (maximum, sample) =>
      sample.percentFull === null
        ? maximum
        : Math.max(maximum, sample.percentFull),
    0,
  );
  return {
    valid:
      traceEventArrayPresent &&
      traceEventCount > 0 &&
      complete.dataLossOccurred !== true &&
      maximumBufferPercentFull < 1,
    tracingCompleteReceived: true,
    traceEventArrayPresent,
    traceEventCount,
    dataLossOccurred:
      typeof complete.dataLossOccurred === "boolean"
        ? complete.dataLossOccurred
        : null,
    maximumBufferPercentFull,
    bufferCapacityReached: maximumBufferPercentFull >= 1,
  };
}

function summarizeProbe(
  snapshot,
  expectedEvents,
  durationMs,
  postFrames,
  maximumDispatchScheduleErrorMilliseconds,
  maximumAllowedDispatchErrorMilliseconds,
  maximumDispatchAckLatencyMilliseconds,
  wheelDeliveryWait,
) {
  const events = snapshot.wheelEvents;
  const intervals = calculatePostInputRafIntervals(
    snapshot.rafTimestamps,
    snapshot.firstInput,
    postFrames + Math.max(0, events.length + 2),
  );
  const negativeMagnitude = events
    .filter((event) => event.deltaY < 0)
    .reduce((sum, event) => sum + Math.abs(event.deltaY), 0);
  const positiveMagnitude = events
    .filter((event) => event.deltaY > 0)
    .reduce((sum, event) => sum + Math.abs(event.deltaY), 0);
  const expectedDeltaMagnitude = expectedEvents
    .filter((event) => event.deltaY < 0)
    .reduce((sum, event) => sum + Math.abs(event.deltaY), 0);
  const wheelContract = validateWheelEventContract(events, expectedEvents);
  const firstEventTime = events[0]?.time ?? null;
  let expectedEventIndex = 0;
  const maximumReceivedScheduleErrorMilliseconds =
    firstEventTime === null
      ? null
      : wheelContract.exactSequenceMatches
        ? events.reduce(
            (maximum, event, index) =>
              Math.max(
                maximum,
                Math.abs(
                  event.time -
                    firstEventTime -
                    expectedEvents[index].offsetMilliseconds,
                ),
              ),
            0,
          )
      : events.reduce((maximum, event, index) => {
          let accumulatedDelta = 0;
          const direction = Math.sign(event.deltaY);
          while (
            expectedEventIndex < expectedEvents.length &&
            Math.sign(expectedEvents[expectedEventIndex].deltaY) === direction &&
            Math.abs(accumulatedDelta) + WHEEL_DELTA_EPSILON <
              Math.abs(event.deltaY)
          ) {
            accumulatedDelta += expectedEvents[expectedEventIndex].deltaY;
            expectedEventIndex += 1;
          }
          if (accumulatedDelta !== event.deltaY) return Number.POSITIVE_INFINITY;
          const expectedOffset =
            expectedEvents[expectedEventIndex - 1]?.offsetMilliseconds ??
            (durationMs * index) / Math.max(1, expectedEvents.length - 1);
          return Math.max(
            maximum,
            Math.abs(event.time - firstEventTime - expectedOffset),
          );
        }, 0);
  const frameMean =
    intervals.length > 0
      ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
      : null;
  const longTaskDurations = snapshot.longTasks
    .map((entry) => entry.duration)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    expectedEventCount: expectedEvents.length,
    receivedEventCount: events.length,
    receivedDeltaYSequence: events.map((event) => event.deltaY),
    receivedWheelEventSamples: events.slice(0, 20),
    receivedEventTypes: [...new Set(events.map((event) => event.targetTag))],
    legacyMousewheelEventCount: snapshot.legacyMousewheelEvents.length,
    browserLegacyMousewheelEventCount: snapshot.legacyMousewheelEvents.filter(
      (event) => event.source === "browser",
    ).length,
    pluginRelayMousewheelEventCount: snapshot.legacyMousewheelEvents.filter(
      (event) => event.source === "plugin-relay",
    ).length,
    allReceivedEventsTrusted: wheelContract.mismatch.isTrusted.length === 0,
    wheelContract,
    receivedNegativeDeltaMagnitude: negativeMagnitude,
    receivedPositiveDeltaMagnitude: positiveMagnitude,
    expectedDeltaMagnitudePerDirection: expectedDeltaMagnitude,
    balancedDirectionMagnitudes:
      negativeMagnitude === expectedDeltaMagnitude &&
      positiveMagnitude === expectedDeltaMagnitude,
    inputWindowMilliseconds:
      snapshot.firstInput === null || snapshot.lastInput === null
        ? null
        : snapshot.lastInput - snapshot.firstInput,
    requestedDurationMilliseconds: durationMs,
    requestedIntervalMilliseconds:
      expectedEvents.length > 1
        ? durationMs / (expectedEvents.length - 1)
        : null,
    maximumDispatchErrorMilliseconds: maximumDispatchScheduleErrorMilliseconds,
    maximumAllowedDispatchErrorMilliseconds,
    dispatchTimingWithinContract:
      maximumDispatchScheduleErrorMilliseconds <=
      maximumAllowedDispatchErrorMilliseconds,
    maximumReceivedScheduleErrorMilliseconds,
    receivedTimingWithinContract:
      wheelContract.sequenceMatchesAllowingCoalescing &&
      maximumReceivedScheduleErrorMilliseconds !== null &&
      maximumReceivedScheduleErrorMilliseconds <=
        maximumAllowedDispatchErrorMilliseconds,
    maximumDispatchAckLatencyMilliseconds,
    wheelDeliveryWait,
    rafDiagnostic: {
      isGpuPresentationFps: false,
      label: "requestAnimationFrame cadence diagnostic only",
      frameCount: intervals.length,
      averageFps: frameMean === null ? null : 1000 / frameMean,
      p50FrameIntervalMilliseconds: percentile(intervals, 0.5),
      p95FrameIntervalMilliseconds: percentile(intervals, 0.95),
      maximumFrameIntervalMilliseconds:
        intervals.length > 0 ? Math.max(...intervals) : null,
      longFrameCount: intervals.filter((value) => value > 16.667).length,
    },
    longTaskCount: snapshot.longTasks.length,
    longTaskDurationMilliseconds: snapshot.longTasks.reduce(
      (sum, entry) => sum + entry.duration,
      0,
    ),
    longTaskDurationP50Milliseconds: percentile(longTaskDurations, 0.5),
    longTaskDurationP95Milliseconds: percentile(longTaskDurations, 0.95),
    longTaskDurationMaxMilliseconds:
      longTaskDurations.length > 0 ? longTaskDurations.at(-1) : null,
    pageErrors: snapshot.pageErrors,
    inputObservation: snapshot.inputObservation || null,
    postInputFrames: postFrames,
  };
}

async function main(options) {
  const count = integerOption(options, "count", DEFAULT_COUNT, 2, 10000);
  if (count % 2 !== 0)
    throw new Error(
      "--count must be even so both wheel directions have equal events.",
    );
  const durationMs = integerOption(
    options,
    "duration",
    DEFAULT_DURATION_MS,
    100,
    600000,
  );
  const settleMs = integerOption(
    options,
    "settle",
    DEFAULT_SETTLE_MS,
    0,
    60000,
  );
  const postFrames = integerOption(
    options,
    "post-frames",
    DEFAULT_POST_FRAMES,
    1,
    240,
  );
  const timeoutMs = integerOption(
    options,
    "timeout",
    DEFAULT_TIMEOUT_MS,
    1000,
    600000,
  );
  const x = numberOption(options, "x", undefined, 0, 100000);
  const y = numberOption(options, "y", undefined, 0, 100000);
  const deltaMagnitude = numberOption(options, "delta-y", 40, 0.01, 10000);
  if (!Number.isInteger(deltaMagnitude)) {
    throw new Error("--delta-y must be an integer for wheel input compatibility.");
  }
  const sequenceSeed = String(options["sequence-seed"] || "chrome-devtools-lab-human-wheel-v1");
  const maximumAllowedDispatchErrorMilliseconds = numberOption(
    options,
    "max-dispatch-error",
    Math.max(20, (durationMs / (count - 1)) * 2),
    0,
    timeoutMs,
  );
  const expectedEnvironment = parseExpectedEnvironmentContract(options);
  const showFpsCounter = options["show-fps-counter"] === true;
  const inputBackend = String(options["input-backend"] || "cdp");
  if (!["cdp", "windows-native"].includes(inputBackend)) {
    throw new Error(`Invalid --input-backend: ${inputBackend}. Use cdp or windows-native.`);
  }
  const postFocusWindowBounds = parsePostFocusWindowPlacement(
    options,
    inputBackend,
  );
  const inputDeliveryPolicy = String(
    options["input-delivery-policy"] || "strict",
  );
  if (!INPUT_DELIVERY_POLICIES.has(inputDeliveryPolicy)) {
    throw new Error(
      `Invalid --input-delivery-policy: ${inputDeliveryPolicy}. Use strict or diagnostic.`,
    );
  }
  const useLegacyMousewheelBridge =
    options["legacy-mousewheel-bridge"] === true;
  const skipMidpointScreenshot =
    options["skip-midpoint-screenshot"] === true;
  const traceProfile = String(options["trace-profile"] || "full");
  const traceCategories = TRACE_PROFILES[traceProfile];
  if (!Object.hasOwn(TRACE_PROFILES, traceProfile)) {
    throw new Error(
      `Invalid --trace-profile: ${traceProfile}. Use ${Object.keys(TRACE_PROFILES).join(" or ")}.`,
    );
  }
  const traceEnabled = traceProfile !== "none";
  const fpsCounterHoldMs = showFpsCounter
    ? integerOption(options, "fps-counter-hold", 0, 0, 600000)
    : 0;
  const output = options.output;
  if (typeof output !== "string" || output.length === 0)
    throw new Error("Wheel benchmark requires --output <json>.");
  const analyzedOutput =
    typeof options["analyzed-output"] === "string"
      ? path.resolve(options["analyzed-output"])
      : null;
  const traceOutput =
    typeof options["trace-output"] === "string"
      ? options["trace-output"]
      : `${output}.trace.json`;
  const { target, host, port, targetResolution } = await selectTarget(options);
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  let traceSession = null;
  if (traceEnabled) {
    try {
      traceSession = await connect(target.webSocketDebuggerUrl, timeoutMs);
    } catch (error) {
      session.close();
      throw error;
    }
  }
  let tracingStarted = false;
  let traceComplete = null;
  let traceLock = null;
  const collectedEvents = [];
  const traceBufferUsageSamples = [];
  const fpsCounter = {
    requested: showFpsCounter,
    enabled: false,
    scope: showFpsCounter ? "same-CDP-session-during-sample" : null,
    postSampleHoldMilliseconds: fpsCounterHoldMs,
    heldForMilliseconds: 0,
    source: showFpsCounter ? NATIVE_FPS_COUNTER_SOURCE : null,
    numericValueReturnedByCdp: false,
    visibilityRequirement:
      "The target must be visible/foreground for the user to see the overlay.",
  };
  const legacyMousewheelBridge = {
    requested: useLegacyMousewheelBridge,
    enabled: false,
    source: useLegacyMousewheelBridge
      ? LEGACY_MOUSEWHEEL_BRIDGE_SOURCE
      : null,
    inputLatencyKpiValid: !useLegacyMousewheelBridge,
    renderingComparisonValid: true,
  };
  if (traceSession !== null) {
    traceSession.onEvent("Tracing.dataCollected", (params) => {
      if (Array.isArray(params.value)) collectedEvents.push(...params.value);
    });
    traceSession.onEvent("Tracing.bufferUsage", (params) => {
      traceBufferUsageSamples.push({
        sampledAtMilliseconds: performance.now(),
        percentFull:
          typeof params.percentFull === "number"
            ? params.percentFull
            : typeof params.value === "number"
              ? params.value
              : null,
        eventCount:
          typeof params.eventCount === "number" ? params.eventCount : null,
      });
      });
  }
  const probeLifecycle = {
    started: false,
    attempted: false,
    result: null,
    error: null,
  };
  let disposed = null;
  let primaryError = null;
  const cleanupProbe = async () => {
    const result = await invokeCleanupOnce(
      probeLifecycle,
      () => disposeProbe(session),
    );
    if (result !== null && result !== undefined) {
      disposed = result;
      const contractError = probeCleanupContractError(result);
      if (contractError) throw contractError;
    }
    return result;
  };
  try {
    if (showFpsCounter) {
      await setNativeFpsCounter(session, true);
      fpsCounter.enabled = true;
    }
    const page = await evaluate(
      session,
      "({ url: location.href, title: document.title, visibilityState: document.visibilityState, dpr: devicePixelRatio, screenX: screenX, screenY: screenY, outerWidth: outerWidth, outerHeight: outerHeight, viewport: { width: innerWidth, height: innerHeight }, scrollX: window.scrollX, scrollY: window.scrollY })",
    );
    target.title = page.title;
    target.url = page.url;
    probeLifecycle.started = true;
    const preflight = await installProbe(
      session,
      useLegacyMousewheelBridge,
      { x, y },
      traceEnabled,
    );
    legacyMousewheelBridge.enabled = useLegacyMousewheelBridge;
    const canvas = preflight.rect;
    if (
      x < canvas.x ||
      x >= canvas.x + canvas.width ||
      y < canvas.y ||
      y >= canvas.y + canvas.height
    ) {
      throw new Error(
        `Point (${x}, ${y}) is outside canvas ${JSON.stringify(canvas)}`,
      );
    }
    if (inputBackend === "cdp") {
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      });
    }
    await sleep(POINTER_SETTLE_MS);
    const beforeHash = await captureCanvasHash(session, canvas);
    if (traceSession !== null) {
      traceLock = await acquireTraceLock({
        host,
        port,
        timeoutMs,
        metadata: { script: "wheel-benchmark", targetId: target.id },
      });
      await traceSession.send("Tracing.start", {
        categories: traceCategories,
        options: "record-continuously",
        bufferUsageReportingInterval: 250,
        transferMode: "ReturnAsStream",
      });
      tracingStarted = true;
      traceComplete = traceSession.waitForEvent("Tracing.tracingComplete");
    }
    const probeMeasurementReset = await resetProbeForMeasurement(session);
    const pagePerformanceBefore = await readPagePerformanceSnapshot(
      session,
      "before-input",
    );
    const dispatchStartEpochMs = Date.now();
    const midpointHashPromise = skipMidpointScreenshot
      ? Promise.resolve({ hash: null, error: null })
      : (async () => {
          await sleep(durationMs / 2);
          try {
            return { hash: await captureCanvasHash(session, canvas), error: null };
          } catch (error) {
            return { hash: null, error };
          }
        })();
    const expectedEvents = createExpectedWheelEvents(
      count,
      { x, y },
      deltaMagnitude,
      durationMs,
      sequenceSeed,
      inputBackend,
    );
    const dispatch = inputBackend === "windows-native"
      ? await dispatchNativeWheelSequence({
          session,
          target,
          port,
          page,
          frozenEnvironment: normalizePreflightEnvironment(preflight),
          expectedEvents,
          durationMs,
          timeoutMs,
          postFocusWindowBounds,
        })
      : await dispatchWheelSequence(
          session,
          expectedEvents,
          durationMs,
          MAX_IN_FLIGHT_WHEEL_DISPATCHES,
          traceSession === null
            ? null
            : () =>
                evaluate(
                  session,
                  `performance.mark(${JSON.stringify(TRACE_WHEEL_END_MARKER)}); console.timeStamp(${JSON.stringify(TRACE_WHEEL_END_MARKER)})`,
                ),
        );
    if (traceSession !== null && inputBackend === "windows-native") {
      await evaluate(
        session,
        `performance.mark(${JSON.stringify(TRACE_WHEEL_END_MARKER)}); console.timeStamp(${JSON.stringify(TRACE_WHEEL_END_MARKER)})`,
      );
    }
    const dispatchEndEpochMs = Math.round(
      dispatchStartEpochMs +
        dispatch.dispatchEndedAt -
        dispatch.dispatchStartedAt,
    );
    const midpointCapture = await midpointHashPromise;
    if (midpointCapture.error) throw midpointCapture.error;
    const midpointHash = midpointCapture.hash;
    await evaluate(
      session,
      `new Promise((resolve) => { let count = 0; const tick = () => { if (++count >= ${postFrames}) resolve(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`,
    );
    await sleep(settleMs);
    const wheelDeliveryWait = await waitForProbeWheelDelivery(
      session,
      expectedEvents.length,
      WHEEL_DELIVERY_WAIT_MAX_MS,
    );
    const pagePerformanceAfter = await readPagePerformanceSnapshot(
      session,
      "after-input",
    );
    const pagePerformance = diffPagePerformance(
      pagePerformanceBefore,
      pagePerformanceAfter,
    );
    const afterHash = await captureCanvasHash(session, canvas);
    await cleanupProbe();
    let complete = null;
    let trace = null;
    if (traceSession !== null) {
      await traceSession.send("Tracing.end");
      tracingStarted = false;
      await evaluate(
        session,
        `performance.clearMarks(${JSON.stringify(TRACE_WHEEL_START_MARKER)}); performance.clearMarks(${JSON.stringify(TRACE_WHEEL_END_MARKER)})`,
      );
      complete = await Promise.race([
        traceComplete,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tracing.tracingComplete timed out")),
            timeoutMs,
          ),
        ),
      ]);
      const traceText = complete.stream
        ? await readTraceStream(traceSession, complete.stream)
        : JSON.stringify({ traceEvents: collectedEvents });
      await traceLock.release();
      traceLock = null;
      const parsedTrace = JSON.parse(traceText);
      trace = Array.isArray(parsedTrace)
        ? { traceEvents: parsedTrace }
        : parsedTrace;
      await fs.mkdir(path.dirname(path.resolve(traceOutput)), {
        recursive: true,
      });
      await fs.writeFile(
        path.resolve(traceOutput),
        `${JSON.stringify(trace)}\n`,
        "utf8",
      );
    }
    const snapshot = disposed.snapshot;
    const pageAfter = await evaluate(
      session,
      "({ visibilityState: document.visibilityState, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, scrollX: window.scrollX, scrollY: window.scrollY })",
    );
    const diagnostics = summarizeProbe(
      snapshot,
      expectedEvents,
      durationMs,
      postFrames,
      dispatch.maximumDispatchScheduleErrorMilliseconds,
      maximumAllowedDispatchErrorMilliseconds,
      dispatch.maximumDispatchAckLatencyMilliseconds,
      wheelDeliveryWait,
    );
    const relayEvents =
      disposed.snapshot.legacyMousewheelBridge?.relayEvents || [];
    legacyMousewheelBridge.relayedCount = relayEvents.filter(
      (event) => event.relayed === true,
    ).length;
    legacyMousewheelBridge.skippedNativeHandledCount = relayEvents.filter(
      (event) =>
        event.relayed === false &&
        event.reason === "outer-wheel-already-prevented",
    ).length;
    legacyMousewheelBridge.preventedCount = relayEvents.filter(
      (event) => event.defaultPrevented === true,
    ).length;
    legacyMousewheelBridge.relayedEventsAreTrusted = relayEvents
      .filter((event) => event.relayed === true)
      .every((event) => event.relayedIsTrusted === true);
    legacyMousewheelBridge.relayedEventsAreUntrusted = relayEvents
      .filter((event) => event.relayed === true)
      .every((event) => event.relayedIsTrusted === false);
    legacyMousewheelBridge.browserLegacyCount =
      diagnostics.browserLegacyMousewheelEventCount;
    legacyMousewheelBridge.pluginRelayObservedCount =
      diagnostics.pluginRelayMousewheelEventCount;
    legacyMousewheelBridge.inputLatencyKpiValid =
      legacyMousewheelBridge.relayedCount === 0 &&
      diagnostics.browserLegacyMousewheelEventCount >= count;
    const preflightEnvironment = normalizePreflightEnvironment(preflight);
    const preflightEnvironmentResult = compareEnvironmentContract(
      preflightEnvironment,
      expectedEnvironment,
    );
    const postInputEnvironmentResult = compareEnvironmentContract(
      snapshot.environment,
      expectedEnvironment,
    );
    const visualChange = summarizeVisualChange(
      beforeHash,
      midpointHash,
      afterHash,
      count,
      !skipMidpointScreenshot,
    );
    const traceCompleteness = traceEnabled
      ? summarizeTraceCompleteness(trace, complete, traceBufferUsageSamples)
      : null;
    const traceEventCount = traceCompleteness?.traceEventCount ?? 0;
    const traceEvents = Array.isArray(trace?.traceEvents)
      ? trace.traceEvents
      : [];
    const frameRateWindow = traceEnabled
      ? findTraceWindow(traceEvents, {
          startLabel: TRACE_WHEEL_START_MARKER,
          endLabel: TRACE_WHEEL_END_MARKER,
          targetId: target.id,
        })
      : null;
    const compositorFrameRate = traceEnabled
      ? analyzeCompositorFps(traceEvents, {
          targetId: target.id,
          window: frameRateWindow,
        })
      : null;
    diagnostics.compositorFrameRate = compositorFrameRate;
    if (fpsCounterHoldMs > 0) {
      await sleep(fpsCounterHoldMs);
      fpsCounter.heldForMilliseconds = fpsCounterHoldMs;
    }
    const invalidReasons = [];
    const nativeWheelObservation =
      diagnostics.inputObservation?.channels?.nativeWheel || null;
    if (nativeWheelObservation === null) {
      addInvalidReason(
        invalidReasons,
        "wheel-observation-channel-missing",
        "nativeWheel channel was not installed",
      );
    } else {
      if (nativeWheelObservation.acceptedCount !== diagnostics.receivedEventCount) {
        addInvalidReason(
          invalidReasons,
          "wheel-observation-count-mismatch",
          `accepted=${nativeWheelObservation.acceptedCount} recorded=${diagnostics.receivedEventCount}`,
        );
      }
      if (nativeWheelObservation.filteredCount > 0) {
        addInvalidReason(
          invalidReasons,
          "wheel-observation-filtered-events",
          `filtered=${nativeWheelObservation.filteredCount} reasons=${JSON.stringify(nativeWheelObservation.filteredReasonCounts)}`,
        );
      }
    }
    if (dispatch.dispatchAcks !== count) {
      addInvalidReason(
        invalidReasons,
        "cdp-wheel-ack-count-mismatch",
        `expected=${count} actual=${dispatch.dispatchAcks}`,
      );
    }
    if (inputBackend === "windows-native") {
      const nativeInput = dispatch.nativeInput || null;
      if (nativeInput?.targeting?.winnerCount !== 1) {
        addInvalidReason(
          invalidReasons,
          "native-targeting-contract-mismatch",
          `winnerCount=${nativeInput?.targeting?.winnerCount ?? "missing"}`,
        );
      }
      if (nativeInput?.targeting?.dispatchRecheck?.passed !== true) {
        addInvalidReason(
          invalidReasons,
          "native-dispatch-recheck-missing-or-failed",
          JSON.stringify(nativeInput?.targeting?.dispatchRecheck || null),
        );
      }
      if (nativeInput?.postFocusEnvironment?.matches !== true) {
        addInvalidReason(
          invalidReasons,
          "native-post-focus-environment-mismatch",
          JSON.stringify(nativeInput?.postFocusEnvironment || null),
        );
      }
    }
    appendWheelContractInvalidReasons(
      invalidReasons,
      diagnostics.wheelContract,
      expectedEvents,
    );
    if (
      useLegacyMousewheelBridge &&
      (diagnostics.browserLegacyMousewheelEventCount +
          legacyMousewheelBridge.relayedCount <
          count ||
        diagnostics.pluginRelayMousewheelEventCount !==
          legacyMousewheelBridge.relayedCount ||
        legacyMousewheelBridge.preventedCount !==
          legacyMousewheelBridge.relayedCount)
    ) {
      addInvalidReason(
        invalidReasons,
        "legacy-wheel-handler-count-mismatch",
        `expected=${count} browserLegacy=${diagnostics.browserLegacyMousewheelEventCount} relayed=${legacyMousewheelBridge.relayedCount} pluginRelayObserved=${diagnostics.pluginRelayMousewheelEventCount} prevented=${legacyMousewheelBridge.preventedCount}`,
      );
    }
    appendEnvironmentInvalidReasons(
      invalidReasons,
      "preflight",
      preflightEnvironmentResult,
    );
    appendEnvironmentInvalidReasons(
      invalidReasons,
      "post-input",
      postInputEnvironmentResult,
    );
    if (!visualChange.responseObserved) {
      addInvalidReason(
        invalidReasons,
        "visual-response-missing",
        `source=${visualChange.evidenceSource} beforeSha256=${beforeHash} midpointSha256=${midpointHash} afterSha256=${afterHash}`,
      );
    }
    if (disposed.residue !== false)
      addInvalidReason(
        invalidReasons,
        "probe-residue",
        `expected=false actual=${disposed.residue}`,
      );
    if (page.visibilityState !== "visible")
      addInvalidReason(
        invalidReasons,
        "page-not-visible",
        `expected=visible actual=${page.visibilityState}`,
      );
    if (pageAfter.visibilityState !== "visible")
      addInvalidReason(
        invalidReasons,
        "page-not-visible-after-input",
        `expected=visible actual=${pageAfter.visibilityState}`,
      );
    if (
      pageAfter.scrollX !== page.scrollX ||
      pageAfter.scrollY !== page.scrollY
    )
      addInvalidReason(
        invalidReasons,
        "page-scrolled",
        `before=(${page.scrollX},${page.scrollY}) after=(${pageAfter.scrollX},${pageAfter.scrollY})`,
      );
    if (!diagnostics.dispatchTimingWithinContract)
      addInvalidReason(
        invalidReasons,
        "wheel-dispatch-timing-out-of-contract",
        `maximumScheduleErrorMs=${dispatch.maximumDispatchScheduleErrorMilliseconds} allowedMs=${maximumAllowedDispatchErrorMilliseconds}`,
      );
    if (!diagnostics.receivedTimingWithinContract)
      addInvalidReason(
        invalidReasons,
        "dom-wheel-timing-out-of-contract",
        `maximumScheduleErrorMs=${diagnostics.maximumReceivedScheduleErrorMilliseconds} allowedMs=${maximumAllowedDispatchErrorMilliseconds}`,
      );
    if (dispatch.dispatchErrors.length > 0)
      addInvalidReason(
        invalidReasons,
        "wheel-dispatch-error",
        `count=${dispatch.dispatchErrors.length} first=${dispatch.dispatchErrors[0]}`,
      );
    if (traceEnabled && !traceCompleteness.traceEventArrayPresent)
      addInvalidReason(
        invalidReasons,
        "trace-event-array-missing",
        "expected trace.traceEvents array",
      );
    if (traceEnabled && traceCompleteness.traceEventArrayPresent && traceEventCount === 0)
      addInvalidReason(
        invalidReasons,
        "trace-events-empty",
        "expected at least one trace event",
      );
    if (traceEnabled && frameRateWindow?.applied !== true)
      addInvalidReason(
        invalidReasons,
        "trace-frame-rate-window-missing",
        `source=${frameRateWindow?.source || "unknown"} startLabel=${TRACE_WHEEL_START_MARKER} endLabel=${TRACE_WHEEL_END_MARKER}`,
      );
    if (traceEnabled && complete.dataLossOccurred === true)
      addInvalidReason(
        invalidReasons,
        "trace-data-loss-reported",
        "Tracing.tracingComplete dataLossOccurred=true",
      );
    if (traceEnabled && traceCompleteness.bufferCapacityReached)
      addInvalidReason(
        invalidReasons,
        "trace-buffer-capacity-reached",
        `maximumPercentFull=${traceCompleteness.maximumBufferPercentFull}`,
      );
    const captureValidity = summarizeCaptureValidity(
      invalidReasons,
      diagnostics,
      legacyMousewheelBridge,
      inputDeliveryPolicy,
    );
    const result = {
      schemaVersion: 5,
      valid: captureValidity.valid,
      invalidReasons: captureValidity.invalidReasons,
      strictValid: captureValidity.strictValid,
      strictInvalidReasons: captureValidity.strictInvalidReasons,
      target: { id: target.id, title: target.title, url: target.url },
      page,
      pageAfter,
      preflight,
      environmentContract: {
        expected: expectedEnvironment,
        preflight: {
          actual: preflightEnvironment,
          ...preflightEnvironmentResult,
        },
        postInput: {
          actual: snapshot.environment,
          ...postInputEnvironmentResult,
        },
      },
      point: { x, y },
    input: {
        type: inputBackend === "windows-native" ? "windows-MOUSEEVENTF_WHEEL" : "mouseWheel",
        backend: inputBackend,
        count,
        deltaMagnitude,
        requestedDeltaMagnitude: deltaMagnitude,
        nativeWheelDeltaToDomScale:
          inputBackend === "windows-native"
            ? NATIVE_WHEEL_DELTA_TO_DOM_SCALE
            : null,
        directionSequence: "seeded-human-bursts",
        sequenceSeed,
        deliveryPolicy: inputDeliveryPolicy,
        captureValidity,
        expectedDeltaMode: 0,
        expectedDeltaX: 0,
        expectedDeltaYSequenceSha256:
          diagnostics.wheelContract.expectedDeltaYSequenceSha256,
        dispatchAcks: dispatch.dispatchAcks,
        dispatchAckCountMatches: dispatch.dispatchAcks === count,
        dispatchedEventCount: dispatch.dispatchedEventCount,
        maximumDispatchErrorMilliseconds:
          dispatch.maximumDispatchScheduleErrorMilliseconds,
        maximumAllowedDispatchErrorMilliseconds,
        maximumDispatchAckLatencyMilliseconds:
          dispatch.maximumDispatchAckLatencyMilliseconds,
        maximumInFlightObserved: dispatch.maximumInFlightObserved,
        maximumInFlightAllowed: dispatch.maximumInFlightAllowed,
        nativeInput: dispatch.nativeInput || null,
        targetResolution,
        probeMeasurementReset,
        wheelDeliveryWait,
        wallClock: {
          dispatchStartEpochMs,
          dispatchEndEpochMs,
          timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
        },
        legacyMousewheelBridge,
      },
      visualChange,
      pagePerformance,
      diagnostics,
      fpsCounter,
      trace: {
        enabled: traceEnabled,
        path: traceEnabled ? path.resolve(traceOutput) : null,
        analysisOutput: traceEnabled ? analyzedOutput : null,
        recordingMode: traceEnabled ? "record-continuously" : null,
        profile: traceProfile,
        categories: traceCategories,
        eventCount: traceEventCount,
        transport: traceEnabled
          ? "separate-browser-cdp-session"
          : "disabled",
        transferMode: complete?.stream ? "ReturnAsStream" : traceEnabled ? "dataCollected" : null,
        streamFormat: complete?.traceFormat || null,
        streamCompression: complete?.streamCompression || null,
        bufferUsage: {
          reportingIntervalMilliseconds: traceEnabled ? 250 : null,
          sampleCount: traceBufferUsageSamples.length,
          maximumPercentFull:
            traceCompleteness?.maximumBufferPercentFull ?? null,
          maximumEventCount: traceBufferUsageSamples.reduce(
            (maximum, sample) =>
              sample.eventCount === null
                ? maximum
                : Math.max(maximum, sample.eventCount),
            0,
          ),
          samples: traceBufferUsageSamples,
        },
        completeness: traceCompleteness,
        frameRateWindow,
        compositorFrameRate,
      },
      frameRate: {
        compositor: compositorFrameRate,
        presentation: {
          valid: false,
          fps: null,
          source: "Display::FrameDisplayed / system Present",
          isFinalDisplayPresentFps: true,
          reason:
            "This sample did not produce an analyzed browser presentation KPI. Enable a trace profile for target-correlated Display::FrameDisplayed cadence; use PresentMon only for an optional independent Windows ETW/DWM measurement.",
        },
      },
      performanceKpi: {
        valid: false,
        reason:
          "No qualified browser presentation FPS is asserted here. Enable a trace profile and require valid Display::FrameDisplayed evidence; compositor cadence and optional PresentMon ETW/DWM data remain separate layers.",
      },
    };
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(
      path.resolve(output),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    if (traceEnabled && analyzedOutput !== null) {
      const analyzed = analyzeTrace(
        trace,
        50,
        frameRateWindow,
        result,
        target.id,
      );
      await fs.mkdir(path.dirname(analyzedOutput), { recursive: true });
      await fs.writeFile(
        analyzedOutput,
        `${JSON.stringify(analyzed, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (probeLifecycle.started && probeLifecycle.attempted !== true) {
      try {
        await cleanupProbe();
      } catch (error) {
        cleanupErrors.push({ label: "probe", error });
      }
    }
    if (tracingStarted) {
      try {
        await traceSession?.send("Tracing.end");
        tracingStarted = false;
      } catch (error) {
        cleanupErrors.push({ label: "tracing-end", error });
      }
    }
    if (traceLock) {
      try {
        await traceLock.release();
        traceLock = null;
      } catch (error) {
        cleanupErrors.push({ label: "trace-lock-release", error });
      }
    }
    if (showFpsCounter && fpsCounter.enabled) {
      try {
        await setNativeFpsCounter(session, false);
        fpsCounter.enabled = false;
      } catch (error) {
        cleanupErrors.push({ label: "fps-overlay-disable", error });
      }
    }
    traceSession?.close();
    session.close();
    if (primaryError !== null || cleanupErrors.length > 0) {
      const parts = [];
      if (primaryError !== null) {
        parts.push(`PrimaryError=${primaryError?.stack || primaryError?.message || primaryError}`);
      }
      for (const entry of cleanupErrors) {
        parts.push(`CleanupError[${entry.label}]=${entry.error?.stack || entry.error?.message || entry.error}`);
      }
      const combined = new Error(parts.join("\n"), {
        cause: primaryError || cleanupErrors[0]?.error,
      });
      combined.primaryError = serializeError(primaryError);
      combined.cleanupErrors = cleanupErrors.map((entry) => ({
        label: entry.label,
        error: serializeError(entry.error),
      }));
      throw combined;
    }
  }
}

async function runSelfTests() {
  assert.equal(TRACE_PROFILES.none, null);
  const parsed = parseArgs([
    "--expected-dpr",
    "1",
    "--expected-viewport-width",
    "1192",
    "--expected-viewport-height",
    "1028",
    "--expected-canvas-x",
    "0",
    "--expected-canvas-y",
    "0",
    "--expected-canvas-width",
    "1192",
    "--expected-canvas-height",
    "1028",
  ]);
  const environment = parseExpectedEnvironmentContract(parsed);
  assert.deepEqual(environment, {
    dpr: 1,
    viewport: { width: 1192, height: 1028 },
    canvasRect: { x: 0, y: 0, width: 1192, height: 1028 },
  });
  assert.throws(
    () =>
      parseExpectedEnvironmentContract({
        ...parsed,
        "expected-canvas-height": undefined,
      }),
    /requires --expected-canvas-height/,
  );
  assert.deepEqual(
    parsePostFocusWindowPlacement(
      {
        "post-focus-window-left": "0",
        "post-focus-window-top": "0",
        "post-focus-window-width": "1377",
        "post-focus-window-height": "1039",
      },
      "windows-native",
    ),
    { left: 0, top: 0, width: 1377, height: 1039 },
  );
  assert.throws(
    () =>
      parsePostFocusWindowPlacement(
        { "post-focus-window-left": "0" },
        "windows-native",
      ),
    /requires all of/,
  );
  assert.throws(
    () =>
      parsePostFocusWindowPlacement(
        {
          "post-focus-window-left": "0",
          "post-focus-window-top": "0",
          "post-focus-window-width": "1377",
          "post-focus-window-height": "1039",
        },
        "cdp",
      ),
    /only valid with --input-backend windows-native/,
  );

  const expectedEvents = createExpectedWheelEvents(
    4,
    { x: 596, y: 514 },
    40,
    100,
    "wheel-benchmark-self-test",
  );
  assert.equal(expectedEvents.length, 4);
  assert.equal(expectedEvents[0].offsetMilliseconds, 0);
  assert.equal(expectedEvents.at(-1).offsetMilliseconds, 100);
  assert.equal(expectedEvents.reduce((sum, event) => sum + event.deltaY, 0), 0);
  const nativeExpectedEvents = createExpectedWheelEvents(
    4,
    { x: 596, y: 514 },
    40,
    100,
    "wheel-benchmark-self-test",
    "windows-native",
  );
  assert.deepEqual(
    nativeExpectedEvents.map((event) => event.nativeDeltaY),
    expectedEvents.map((event) => -Math.sign(event.deltaY) * 36),
  );
  assert.deepEqual(
    nativeExpectedEvents.map((event) => event.deltaY),
    expectedEvents.map((event) => event.deltaY),
  );
  const delayedDispatch = await dispatchWheelSequence(
    {
      send: async () => {
        await sleep(40);
      },
    },
    expectedEvents,
    30,
  );
  assert.equal(delayedDispatch.dispatchedEventCount, 4);
  assert.equal(delayedDispatch.dispatchAcks, 4);
  assert.equal(delayedDispatch.dispatchErrors.length, 0);
  assert.ok(delayedDispatch.maximumInFlightObserved > 1);
  assert.ok(
    delayedDispatch.maximumDispatchScheduleErrorMilliseconds < 20,
  );
  const inFlightLimited = await dispatchWheelSequence(
    {
      send: async () => {
        await sleep(100);
      },
    },
    expectedEvents,
    3,
    2,
  );
  assert.equal(inFlightLimited.dispatchedEventCount, 2);
  assert.equal(inFlightLimited.dispatchAcks, 2);
  assert.equal(inFlightLimited.dispatchErrors.length, 1);
  const exactEvents = expectedEvents.map((event) => ({
    ...event,
    targetTag: "CANVAS",
  }));
  const exactContract = validateWheelEventContract(exactEvents, expectedEvents);
  assert.equal(exactContract.eventCountMatches, true);
  assert.equal(exactContract.exactSequenceMatches, true);
  assert.equal(exactContract.sequenceMatchesAllowingCoalescing, true);
  assert.equal(exactContract.deliveryMode, "exact");

  const coalescedEvents = [
    {
      ...exactEvents[0],
      deltaY: exactEvents.slice(0, 2).reduce((sum, event) => sum + event.deltaY, 0),
    },
    {
      ...exactEvents[2],
      deltaY: exactEvents.slice(2, 4).reduce((sum, event) => sum + event.deltaY, 0),
    },
  ];
  const coalescedContract = validateWheelEventContract(
    coalescedEvents,
    expectedEvents,
  );
  assert.equal(coalescedContract.eventCountMatches, false);
  assert.equal(coalescedContract.exactSequenceMatches, false);
  assert.equal(coalescedContract.sequenceMatchesAllowingCoalescing, true);
  assert.equal(coalescedContract.deliveryMode, "coalesced");
  assert.equal(coalescedContract.coalescedEventCount, 2);
  const coalescedReasons = [];
  appendWheelContractInvalidReasons(
    coalescedReasons,
    coalescedContract,
    expectedEvents,
  );
  assert.deepEqual(coalescedReasons, []);

  const missingDeltaEvents = [
    {
      ...exactEvents[0],
      deltaY: exactEvents.slice(0, 2).reduce((sum, event) => sum + event.deltaY, 0),
    },
    { ...exactEvents[2], deltaY: 40 },
  ];
  const missingDeltaContract = validateWheelEventContract(
    missingDeltaEvents,
    expectedEvents,
  );
  assert.equal(missingDeltaContract.sequenceMatchesAllowingCoalescing, false);
  assert.equal(missingDeltaContract.deliveryMode, "mismatch");
  const missingDeltaReasons = [];
  appendWheelContractInvalidReasons(
    missingDeltaReasons,
    missingDeltaContract,
    expectedEvents,
  );
  assert.equal(missingDeltaReasons.length, 2);

  const softInputReasons = [
    "dom-wheel-event-count-mismatch: expected=600 actual=598",
    "dom-wheel-delta-y-sequence-mismatch: expectedSequenceSha256=a actualSequenceSha256=b",
    "legacy-wheel-handler-count-mismatch: expected=600 browserLegacy=0 relayed=598 pluginRelayObserved=598 prevented=598",
    "dom-wheel-timing-out-of-contract: maximumScheduleErrorMs=Infinity allowedMs=66",
  ];
  const diagnosticInput = {
    expectedEventCount: 600,
    receivedEventCount: 598,
    expectedDeltaMagnitudePerDirection: 12000,
    receivedNegativeDeltaMagnitude: 11960,
    receivedPositiveDeltaMagnitude: 11960,
    allReceivedEventsTrusted: true,
    wheelContract: {
      deliveryMode: "mismatch",
      mismatch: {
        isTrusted: [],
        coordinates: [],
        deltaMode: [],
        deltaX: [],
      },
    },
  };
  const diagnosticRelay = {
    requested: true,
    browserLegacyCount: 0,
    relayedCount: 598,
    pluginRelayObservedCount: 598,
    preventedCount: 598,
    relayedEventsAreUntrusted: true,
  };
  const strictCaptureValidity = summarizeCaptureValidity(
    softInputReasons,
    diagnosticInput,
    diagnosticRelay,
    "strict",
  );
  assert.equal(strictCaptureValidity.valid, false);
  assert.equal(strictCaptureValidity.strictValid, false);
  const diagnosticCaptureValidity = summarizeCaptureValidity(
    softInputReasons,
    diagnosticInput,
    diagnosticRelay,
    "diagnostic",
  );
  assert.equal(diagnosticCaptureValidity.valid, true);
  assert.equal(diagnosticCaptureValidity.varianceAccepted, true);
  assert.equal(
    summarizeCaptureValidity(
      softInputReasons,
      {
        ...diagnosticInput,
        receivedNegativeDeltaMagnitude: 11000,
      },
      diagnosticRelay,
      "diagnostic",
    ).valid,
    false,
  );

  const mismatchedEvents = exactEvents.map((event) => ({ ...event }));
  mismatchedEvents[0].isTrusted = false;
  mismatchedEvents[1].clientX += 1;
  mismatchedEvents[2].deltaMode = 1;
  mismatchedEvents[2].deltaX = 1;
  mismatchedEvents[3].deltaY = -expectedEvents[3].deltaY;
  const mismatchedContract = validateWheelEventContract(
    mismatchedEvents,
    expectedEvents,
  );
  assert.equal(mismatchedContract.exactSequenceMatches, false);
  assert.deepEqual(mismatchedContract.mismatch, {
    isTrusted: [0],
    coordinates: [1],
    deltaMode: [2],
    deltaX: [2],
    deltaY: [3],
  });
  const mismatchReasons = [];
  appendWheelContractInvalidReasons(
    mismatchReasons,
    mismatchedContract,
    expectedEvents,
  );
  assert.equal(mismatchReasons.length, 5);
  assert.ok(
    mismatchReasons.every((reason) => reason.includes("mismatchIndexes=")),
  );

  const exactEnvironment = compareEnvironmentContract(
    {
      dpr: 1,
      viewport: { width: 1192, height: 1028 },
      canvasRect: { x: 0, y: 0, width: 1192, height: 1028 },
    },
    environment,
  );
  assert.equal(exactEnvironment.matches, true);
  const mismatchedEnvironment = compareEnvironmentContract(
    {
      dpr: 2,
      viewport: { width: 1192, height: 1028 },
      canvasRect: { x: 1, y: 0, width: 1192, height: 1028 },
    },
    environment,
  );
  assert.deepEqual(
    mismatchedEnvironment.mismatches.map((entry) => entry.field),
    ["dpr", "canvasRect.x"],
  );

  assert.deepEqual(
    calculatePostInputRafIntervals([0, 10, 20, 30, 40], 15, 2),
    [10, 10],
  );
  assert.deepEqual(
    summarizeVisualChange("before", "midpoint", "before", 4, true),
    {
    responseObserved: true,
    evidenceSource: "midpoint-canvas-screenshot",
    measurementWindowContainsCanvasScreenshot: true,
    baselineCapturedAfterPointerSettle: true,
    midpointCaptureEnabled: true,
    responseObservedAtMidpoint: true,
    midpointCaptureAfterEventCount: 2,
    midpointCaptureBeforeDirectionReversal: true,
    finalDiffersFromBefore: false,
    finalReturnedToBaseline: true,
    beforeSha256: "before",
    midpointSha256: "midpoint",
    afterSha256: "before",
    },
  );
  assert.deepEqual(
    summarizeVisualChange("before", null, "after", 4, false),
    {
      responseObserved: true,
      evidenceSource: "post-window-canvas-screenshot",
      measurementWindowContainsCanvasScreenshot: false,
      baselineCapturedAfterPointerSettle: true,
      midpointCaptureEnabled: false,
      responseObservedAtMidpoint: null,
      midpointCaptureAfterEventCount: null,
      midpointCaptureBeforeDirectionReversal: null,
      finalDiffersFromBefore: true,
      finalReturnedToBaseline: false,
      beforeSha256: "before",
      midpointSha256: null,
      afterSha256: "after",
    },
  );
  assert.equal(
    summarizeTraceCompleteness(
      { traceEvents: [{ name: "event" }] },
      { dataLossOccurred: false },
      [{ percentFull: 0.5, eventCount: 1 }],
    ).valid,
    true,
  );
  assert.equal(
    summarizeTraceCompleteness(
      { traceEvents: [{ name: "event" }] },
      { dataLossOccurred: true },
      [{ percentFull: 1, eventCount: 1 }],
    ).valid,
    false,
  );

  const result = {
    valid: true,
    checks: [
      "required-environment-parameters",
      "post-focus-native-window-placement-contract",
      "frozen-direction-sequence",
      "exact-dom-wheel-contract",
      "valid-contiguous-wheel-event-coalescing",
      "missing-coalesced-wheel-delta-rejected",
      "strict-and-bounded-diagnostic-input-policy",
      "detailed-wheel-mismatch-reasons",
      "preflight-and-post-input-environment-contract",
      "post-input-raf-first-interval",
      "midpoint-visual-response-with-final-baseline-return",
      "post-window-visual-response-without-measurement-screenshot",
      "trace-buffer-and-completeness-contract",
      "no-trace-profile-contract",
      "absolute-deadline-bounded-in-flight-dispatch",
    ],
  };
  console.log(JSON.stringify(result, null, 2));
}

const cliOptions = parseArgs(process.argv.slice(2));
const operation =
  cliOptions["self-test"] === true ? runSelfTests() : main(cliOptions);
Promise.resolve(operation).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exit(1);
  },
);
