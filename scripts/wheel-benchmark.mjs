#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  analyzeCompositorFps,
  findTraceWindow,
} from "./frame-rate.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_COUNT = 120;
const DEFAULT_DURATION_MS = 2000;
const DEFAULT_SETTLE_MS = 500;
const DEFAULT_POST_FRAMES = 12;
const DEFAULT_TIMEOUT_MS = 60000;
const TRACE_STREAM_CHUNK_BYTES = 1024 * 1024;
const POINTER_SETTLE_MS = 100;
const TRACE_CATEGORIES = [
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
].join(",");
const TRACE_WHEEL_START_MARKER = "ChromeDevToolsLab.WheelStart";
const TRACE_WHEEL_END_MARKER = "ChromeDevToolsLab.WheelEnd";
const NATIVE_FPS_COUNTER_SOURCE =
  "Chrome DevTools Overlay.setShowFPSCounter";
const LEGACY_MOUSEWHEEL_BRIDGE_SOURCE =
  "temporary legacy mousewheel compatibility relay";

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
  const targets = await getJson(`http://${host}:${port}/json/list`);
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.id === selector,
  );
  if (!target) throw new Error(`Exact page target was not found: ${selector}`);
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error(`Target has no page WebSocket: ${selector}`);
  }
  return { target, host, port };
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

async function installProbe(session, useLegacyMousewheelBridge) {
  return evaluate(
    session,
    `(() => {
      const canvases = [...document.querySelectorAll("canvas")]
        .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height);
      const candidate = canvases[0];
      if (!candidate) throw new Error("No visible canvas is available");
      const state = {
        wheelEvents: [],
        legacyMousewheelEvents: [],
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
      };
      state.onWheel = (event) => {
        const now = performance.now();
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
        state.legacyMousewheelEvents.push({
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
        });
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
      candidate.canvas.addEventListener("wheel", state.onWheel, true);
      candidate.canvas.addEventListener("mousewheel", state.onMousewheel, true);
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
      globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__ = { state, canvas: candidate.canvas, rect: candidate.rect };
      return {
        rect: { x: candidate.rect.x, y: candidate.rect.y, width: candidate.rect.width, height: candidate.rect.height },
        drawingBuffer: { width: candidate.canvas.width, height: candidate.canvas.height },
        dpr: devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
        visibilityState: document.visibilityState,
        readyState: document.readyState,
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
      cancelAnimationFrame(state.rafHandle);
      canvas.removeEventListener("wheel", state.onWheel, true);
      canvas.removeEventListener("mousewheel", state.onMousewheel, true);
      if (state.onLegacyMousewheelBridge) {
        canvas.removeEventListener("wheel", state.onLegacyMousewheelBridge);
      }
      removeEventListener("error", state.onError);
      removeEventListener("unhandledrejection", state.onRejection);
      state.observer?.disconnect();
      const rect = canvas.getBoundingClientRect();
      const snapshot = {
        wheelEvents: state.wheelEvents,
        legacyMousewheelEvents: state.legacyMousewheelEvents,
        rafTimestamps: state.rafTimestamps,
        longTasks: state.longTasks,
        pageErrors: state.pageErrors,
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
      delete globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__;
      return { existed: true, residue: globalThis.__CHROME_DEVTOOLS_LAB_WHEEL__ !== undefined, snapshot };
    })()`,
  );
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

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function createExpectedWheelEvents(count, point, deltaMagnitude) {
  return Array.from({ length: count }, (_, index) => ({
    isTrusted: true,
    clientX: point.x,
    clientY: point.y,
    deltaMode: 0,
    deltaX: 0,
    deltaY: index < count / 2 ? -deltaMagnitude : deltaMagnitude,
  }));
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
    if (accumulatedDelta !== actual.deltaY) return false;
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
      (actual, expected) => actual.deltaY === expected.deltaY,
    ),
  };
  const eventCountMatches = actualEvents.length === expectedEvents.length;
  const exactSequenceMatches =
    eventCountMatches &&
    Object.values(mismatch).every((indexes) => indexes.length === 0);
  const deltaSequenceMatchesAllowingCoalescing =
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
  const frameMean =
    intervals.length > 0
      ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
      : null;
  return {
    expectedEventCount: expectedEvents.length,
    receivedEventCount: events.length,
    receivedEventTypes: [...new Set(events.map((event) => event.targetTag))],
    legacyMousewheelEventCount: snapshot.legacyMousewheelEvents.length,
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
    maximumDispatchAckLatencyMilliseconds,
    rafDiagnostic: {
      isGpuPresentationFps: false,
      label: "requestAnimationFrame cadence diagnostic only",
      frameCount: intervals.length,
      averageFps: frameMean === null ? null : 1000 / frameMean,
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
    pageErrors: snapshot.pageErrors,
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
  const maximumAllowedDispatchErrorMilliseconds = numberOption(
    options,
    "max-dispatch-error",
    Math.max(20, (durationMs / (count - 1)) * 2),
    0,
    timeoutMs,
  );
  const expectedEnvironment = parseExpectedEnvironmentContract(options);
  const showFpsCounter = options["show-fps-counter"] === true;
  const useLegacyMousewheelBridge =
    options["legacy-mousewheel-bridge"] === true;
  const skipMidpointScreenshot =
    options["skip-midpoint-screenshot"] === true;
  const fpsCounterHoldMs = showFpsCounter
    ? integerOption(options, "fps-counter-hold", 0, 0, 600000)
    : 0;
  const output = options.output;
  if (typeof output !== "string" || output.length === 0)
    throw new Error("Wheel benchmark requires --output <json>.");
  const traceOutput =
    typeof options["trace-output"] === "string"
      ? options["trace-output"]
      : `${output}.trace.json`;
  const { target } = await selectTarget(options);
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  let tracingStarted = false;
  let traceComplete = null;
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
  session.onEvent("Tracing.dataCollected", (params) => {
    if (Array.isArray(params.value)) collectedEvents.push(...params.value);
  });
  session.onEvent("Tracing.bufferUsage", (params) => {
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
  try {
    if (showFpsCounter) {
      await setNativeFpsCounter(session, true);
      fpsCounter.enabled = true;
    }
    const page = await evaluate(
      session,
      "({ url: location.href, title: document.title, visibilityState: document.visibilityState, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, scrollX: window.scrollX, scrollY: window.scrollY })",
    );
    const preflight = await installProbe(session, useLegacyMousewheelBridge);
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
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
    await sleep(POINTER_SETTLE_MS);
    const beforeHash = await captureCanvasHash(session, canvas);
    await session.send("Tracing.start", {
      categories: TRACE_CATEGORIES,
      options: "record-continuously",
      bufferUsageReportingInterval: 250,
      transferMode: "ReturnAsStream",
    });
    tracingStarted = true;
    traceComplete = session.waitForEvent("Tracing.tracingComplete");
    await evaluate(
      session,
      `performance.mark(${JSON.stringify(TRACE_WHEEL_START_MARKER)}); console.timeStamp(${JSON.stringify(TRACE_WHEEL_START_MARKER)})`,
    );
    const dispatchStartEpochMs = Date.now();
    const dispatchStartedAt = performance.now();
    let dispatchAcks = 0;
    let maximumDispatchScheduleErrorMs = 0;
    let maximumDispatchAckLatencyMs = 0;
    const dispatchPromises = [];
    const dispatchErrors = [];
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
    );
    for (let index = 0; index < count; index += 1) {
      const due = dispatchStartedAt + (durationMs * index) / (count - 1);
      const delay = due - performance.now();
      if (delay > 0) await sleep(delay);
      const expectedEvent = expectedEvents[index];
      const sentAt = performance.now();
      maximumDispatchScheduleErrorMs = Math.max(
        maximumDispatchScheduleErrorMs,
        Math.abs(sentAt - due),
      );
      const dispatchPromise = session
        .send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: expectedEvent.clientX,
          y: expectedEvent.clientY,
          deltaX: expectedEvent.deltaX,
          deltaY: expectedEvent.deltaY,
          modifiers: 0,
        })
        .then(
          () => {
            dispatchAcks += 1;
            maximumDispatchAckLatencyMs = Math.max(
              maximumDispatchAckLatencyMs,
              performance.now() - sentAt,
            );
          },
          (error) => {
            dispatchErrors.push(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          },
        );
      dispatchPromises.push(dispatchPromise);
    }
    await Promise.all(dispatchPromises);
    const dispatchEndEpochMs = Date.now();
    await evaluate(
      session,
      `performance.mark(${JSON.stringify(TRACE_WHEEL_END_MARKER)}); console.timeStamp(${JSON.stringify(TRACE_WHEEL_END_MARKER)})`,
    );
    const midpointCapture = await midpointHashPromise;
    if (midpointCapture.error) throw midpointCapture.error;
    const midpointHash = midpointCapture.hash;
    await evaluate(
      session,
      `new Promise((resolve) => { let count = 0; const tick = () => { if (++count >= ${postFrames}) resolve(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`,
    );
    await sleep(settleMs);
    const afterHash = await captureCanvasHash(session, canvas);
    const disposed = await disposeProbe(session);
    await session.send("Tracing.end");
    await evaluate(
      session,
      `performance.clearMarks(${JSON.stringify(TRACE_WHEEL_START_MARKER)}); performance.clearMarks(${JSON.stringify(TRACE_WHEEL_END_MARKER)})`,
    );
    const complete = await Promise.race([
      traceComplete,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Tracing.tracingComplete timed out")),
          timeoutMs,
        ),
      ),
    ]);
    const traceText = complete.stream
      ? await readTraceStream(session, complete.stream)
      : JSON.stringify({ traceEvents: collectedEvents });
    const parsedTrace = JSON.parse(traceText);
    const trace = Array.isArray(parsedTrace)
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
      maximumDispatchScheduleErrorMs,
      maximumAllowedDispatchErrorMilliseconds,
      maximumDispatchAckLatencyMs,
    );
    const relayEvents =
      disposed.snapshot.legacyMousewheelBridge?.relayEvents || [];
    legacyMousewheelBridge.relayedCount = relayEvents.filter(
      (event) => event.relayed === true,
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
    const traceCompleteness = summarizeTraceCompleteness(
      trace,
      complete,
      traceBufferUsageSamples,
    );
    const traceEventCount = traceCompleteness.traceEventCount;
    const traceEvents = Array.isArray(trace.traceEvents)
      ? trace.traceEvents
      : [];
    const frameRateWindow = findTraceWindow(traceEvents, {
      startLabel: TRACE_WHEEL_START_MARKER,
      endLabel: TRACE_WHEEL_END_MARKER,
      targetId: target.id,
    });
    const compositorFrameRate = analyzeCompositorFps(traceEvents, {
      targetId: target.id,
      window: frameRateWindow,
    });
    diagnostics.compositorFrameRate = compositorFrameRate;
    if (fpsCounterHoldMs > 0) {
      await sleep(fpsCounterHoldMs);
      fpsCounter.heldForMilliseconds = fpsCounterHoldMs;
    }
    const invalidReasons = [];
    if (dispatchAcks !== count) {
      addInvalidReason(
        invalidReasons,
        "cdp-wheel-ack-count-mismatch",
        `expected=${count} actual=${dispatchAcks}`,
      );
    }
    appendWheelContractInvalidReasons(
      invalidReasons,
      diagnostics.wheelContract,
      expectedEvents,
    );
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
        `maximumScheduleErrorMs=${maximumDispatchScheduleErrorMs} allowedMs=${maximumAllowedDispatchErrorMilliseconds}`,
      );
    if (dispatchErrors.length > 0)
      addInvalidReason(
        invalidReasons,
        "wheel-dispatch-error",
        `count=${dispatchErrors.length} first=${dispatchErrors[0]}`,
      );
    if (!traceCompleteness.traceEventArrayPresent)
      addInvalidReason(
        invalidReasons,
        "trace-event-array-missing",
        "expected trace.traceEvents array",
      );
    if (traceCompleteness.traceEventArrayPresent && traceEventCount === 0)
      addInvalidReason(
        invalidReasons,
        "trace-events-empty",
        "expected at least one trace event",
      );
    if (complete.dataLossOccurred === true)
      addInvalidReason(
        invalidReasons,
        "trace-data-loss-reported",
        "Tracing.tracingComplete dataLossOccurred=true",
      );
    if (traceCompleteness.bufferCapacityReached)
      addInvalidReason(
        invalidReasons,
        "trace-buffer-capacity-reached",
        `maximumPercentFull=${traceCompleteness.maximumBufferPercentFull}`,
      );
    const result = {
      schemaVersion: 5,
      valid: invalidReasons.length === 0,
      invalidReasons,
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
        type: "mouseWheel",
        count,
        deltaMagnitude,
        directionSequence: "negative-first-half-positive-second-half",
        expectedDeltaMode: 0,
        expectedDeltaX: 0,
        expectedDeltaYSequenceSha256:
          diagnostics.wheelContract.expectedDeltaYSequenceSha256,
        dispatchAcks,
        dispatchAckCountMatches: dispatchAcks === count,
        maximumDispatchErrorMilliseconds: maximumDispatchScheduleErrorMs,
        maximumAllowedDispatchErrorMilliseconds,
        maximumDispatchAckLatencyMilliseconds: maximumDispatchAckLatencyMs,
        wallClock: {
          dispatchStartEpochMs,
          dispatchEndEpochMs,
          timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
        },
        legacyMousewheelBridge,
      },
      visualChange,
      diagnostics,
      fpsCounter,
      trace: {
        path: path.resolve(traceOutput),
        recordingMode: "record-continuously",
        eventCount: traceEventCount,
        transferMode: complete.stream ? "ReturnAsStream" : "dataCollected",
        streamFormat: complete.traceFormat || null,
        streamCompression: complete.streamCompression || null,
        bufferUsage: {
          reportingIntervalMilliseconds: 250,
          sampleCount: traceBufferUsageSamples.length,
          maximumPercentFull: traceCompleteness.maximumBufferPercentFull,
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
            "This wheel benchmark does not claim final display FPS; use the optional PresentMon backend with the required Windows tracing privilege.",
        },
      },
      performanceKpi: {
        valid: false,
        reason:
          "Final display Present FPS is not asserted here; use frameRate.compositor for Chrome compositor draw/swap FPS and the optional PresentMon backend for DWM/display FPS.",
      },
    };
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(
      path.resolve(output),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (tracingStarted) {
      try {
        await session.send("Tracing.end");
      } catch {}
    }
    if (showFpsCounter) {
      try {
        await setNativeFpsCounter(session, false);
      } catch {}
    }
    session.close();
  }
}

function runSelfTests() {
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

  const expectedEvents = createExpectedWheelEvents(4, { x: 596, y: 514 }, 40);
  assert.deepEqual(
    expectedEvents.map((event) => event.deltaY),
    [-40, -40, 40, 40],
  );
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
    { ...exactEvents[0], deltaY: -80 },
    { ...exactEvents[2], deltaY: 80 },
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
    { ...exactEvents[0], deltaY: -80 },
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

  const mismatchedEvents = exactEvents.map((event) => ({ ...event }));
  mismatchedEvents[0].isTrusted = false;
  mismatchedEvents[1].clientX += 1;
  mismatchedEvents[2].deltaMode = 1;
  mismatchedEvents[2].deltaX = 1;
  mismatchedEvents[3].deltaY = -40;
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
      "frozen-direction-sequence",
      "exact-dom-wheel-contract",
      "valid-contiguous-wheel-event-coalescing",
      "missing-coalesced-wheel-delta-rejected",
      "detailed-wheel-mismatch-reasons",
      "preflight-and-post-input-environment-contract",
      "post-input-raf-first-interval",
      "midpoint-visual-response-with-final-baseline-return",
      "post-window-visual-response-without-measurement-screenshot",
      "trace-buffer-and-completeness-contract",
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
