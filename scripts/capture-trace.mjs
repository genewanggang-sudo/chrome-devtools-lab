#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireTraceLock } from "./trace-lock.mjs";
import {
  parseTraceJson,
  readTraceJsonTextFile,
  writeTraceStream,
} from "./trace-json.mjs";
import { buildTargetFrameBinding, readTargetFrameTree } from "./frame-rate.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
const TRACE_STREAM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CATEGORIES = [
  "-*",
  "blink",
  "benchmark",
  "browser",
  "cc",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.inputs",
  "disabled-by-default-display.framedisplayed",
  "disabled-by-default-gpu.service",
  "devtools.timeline",
  "gpu",
  "input",
  "renderer",
  "toplevel",
  "v8",
  "viz",
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = true;
    } else {
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
      `Invalid --${name}: ${options[name]}. Use an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function selectTarget(options) {
  const host = String(options.host || DEFAULT_HOST);
  const port = integerOption(options, "port", DEFAULT_PORT, 1, 65535);
  const selector = options["target-exact"];
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("Trace capture requires --target-exact <target ID>.");
  }
  const targets = await getJson(`http://${host}:${port}/json/list`);
  const pages = targets.filter((target) => target.type === "page");
  const target = pages.find((candidate) => candidate.id === selector);
  if (!target) {
    throw new Error(
      `Exact page target was not found: ${selector}. Run cdp.mjs list and bind a current ID.`,
    );
  }
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error(`Target has no page WebSocket: ${selector}`);
  }
  return { host, port, target };
}

function connect(webSocketUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map();
    const listeners = new Map();
    const handlers = new Map();

    const fail = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out connecting to ${webSocketUrl}`));
      socket.close();
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        async send(method, params = {}) {
          const id = nextId++;
          return new Promise((resolveRequest, rejectRequest) => {
            const requestTimer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`Timed out waiting for ${method}`));
            }, timeoutMs);
            pending.set(id, {
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
            const queue = listeners.get(method) || [];
            queue.push(resolveEvent);
            listeners.set(method, queue);
          });
        },
        onEvent(method, handler) {
          const queue = handlers.get(method) || [];
          queue.push(handler);
          handlers.set(method, queue);
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = parseTraceJson(String(event.data));
      if (message.id != null) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) {
          request.reject(
            new Error(
              `${message.error.message || "CDP error"} (${message.error.code || "unknown"})`,
            ),
          );
        } else {
          request.resolve(message.result || {});
        }
        return;
      }
      const queue = listeners.get(message.method) || [];
      listeners.delete(message.method);
      for (const resolveEvent of queue) resolveEvent(message.params || {});
      for (const handler of handlers.get(message.method) || []) {
        handler(message.params || {});
      }
    });

    socket.addEventListener("error", () =>
      fail(new Error("CDP WebSocket error")),
    );
    socket.addEventListener("close", () => {
      if (!settled) fail(new Error("CDP WebSocket closed before connection"));
      else fail(new Error("CDP WebSocket closed during trace capture"));
    });
  });
}

async function evaluatePage(session) {
  const response = await session.send("Runtime.evaluate", {
    expression: `({
      url: location.href,
      title: document.title,
      visibilityState: document.visibilityState,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      canvasCount: document.querySelectorAll("canvas").length
    })`,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error("Runtime.evaluate failed while reading page state");
  }
  return response.result?.value || null;
}

async function readTraceStream(session, handle, output, maxParseBytes) {
  await writeTraceStream(session, handle, output, {
    chunkBytes: TRACE_STREAM_CHUNK_BYTES,
  });
  return readTraceJsonTextFile(output, { maxBytes: maxParseBytes });
}

function traceTextFromCollected(events) {
  return JSON.stringify({ traceEvents: events });
}

export function buildCaptureTraceEvidence(trace, complete, bufferUsageSamples) {
  const traceEventArrayPresent = Array.isArray(trace?.traceEvents);
  const traceEventCount = traceEventArrayPresent ? trace.traceEvents.length : 0;
  const percentages = bufferUsageSamples
    .map((sample) => sample.percentFull)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const maximumPercentFull = percentages.length
    ? Math.max(...percentages)
    : null;
  const dataLossOccurred =
    typeof complete?.dataLossOccurred === "boolean"
      ? complete.dataLossOccurred
      : null;
  const bufferCapacityReached =
    maximumPercentFull === null ? null : maximumPercentFull >= 1;
  const completeness = {
    valid:
      traceEventArrayPresent &&
      traceEventCount > 0 &&
      dataLossOccurred === false &&
      bufferCapacityReached === false,
    tracingCompleteReceived: complete !== null && complete !== undefined,
    traceEventArrayPresent,
    traceEventCount,
    dataLossOccurred,
    maximumBufferPercentFull: maximumPercentFull,
    bufferCapacityReached,
  };
  return {
    completeness,
    bufferUsage: {
      reportingIntervalMilliseconds: 250,
      sampleCount: bufferUsageSamples.length,
      maximumPercentFull,
      samples: bufferUsageSamples,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const durationMs = integerOption(
    options,
    "duration",
    DEFAULT_DURATION_MS,
    100,
    600000,
  );
  const timeoutMs = integerOption(
    options,
    "timeout",
    DEFAULT_TIMEOUT_MS,
    1000,
    600000,
  );
  const output = options.output;
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Trace capture requires --output <trace.json>.");
  }
  const maxParseBytes = integerOption(
    options,
    "max-parse-bytes",
    256 * 1024 * 1024,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const captureOutput =
    typeof options["capture-output"] === "string"
      ? options["capture-output"]
      : `${output}.capture.json`;
  const categories = String(options.categories || DEFAULT_CATEGORIES.join(","));
  const { target, host, port } = await selectTarget(options);
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  const collectedEvents = [];
  const bufferUsageSamples = [];
  session.onEvent("Tracing.dataCollected", (params) => {
    if (Array.isArray(params.value)) collectedEvents.push(...params.value);
  });
  session.onEvent("Tracing.bufferUsage", (params) => {
    bufferUsageSamples.push({
      observedAtEpochMs: Date.now(),
      percentFull:
        typeof params.percentFull === "number" ? params.percentFull : null,
      eventCount:
        typeof params.eventCount === "number" ? params.eventCount : null,
      value: typeof params.value === "number" ? params.value : null,
    });
  });
  let tracingStarted = false;
  let traceCompletePromise = null;
  let traceLock = null;
  const startedAt = Date.now();
  try {
    const page = await evaluatePage(session);
    traceLock = await acquireTraceLock({
      host,
      port,
      timeoutMs,
      metadata: { script: "capture-trace", targetId: target.id },
    });
    const frameTreeBefore = await readTargetFrameTree(session);
    const startResult = await session.send("Tracing.start", {
      categories,
      options: "record-until-full",
      bufferUsageReportingInterval: 250,
      transferMode: "ReturnAsStream",
    });
    tracingStarted = true;
    traceCompletePromise = session.waitForEvent("Tracing.tracingComplete");
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    await session.send("Tracing.end");
    let completionTimer;
    let complete;
    try {
      complete = await Promise.race([
        traceCompletePromise,
        new Promise((_, reject) => {
          completionTimer = setTimeout(
            () =>
              reject(
                new Error("Timed out waiting for Tracing.tracingComplete"),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(completionTimer);
    }
    // The completed capture no longer owns an active trace. Do not end a new
    // collector's trace from finally after this collector releases the lock.
    tracingStarted = false;
    const frameTreeAfter = await readTargetFrameTree(session);
    const targetFrameBinding = buildTargetFrameBinding(
      target.id,
      frameTreeBefore,
      frameTreeAfter,
    );
    let traceText;
    let parsed;
    let rawTransferComplete = false;
    try {
      if (complete.stream) {
        traceText = await readTraceStream(
          session,
          complete.stream,
          path.resolve(output),
          maxParseBytes,
        );
      } else {
        traceText = traceTextFromCollected(collectedEvents);
        await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        await fs.writeFile(path.resolve(output), traceText, {
          encoding: "utf8",
          flag: "wx",
        });
      }
      rawTransferComplete = true;
      parsed = parseTraceJson(traceText, { maxBytes: maxParseBytes });
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.traceEvents)) {
        throw new Error("Trace stream is missing traceEvents[].");
      }
    } catch (error) {
      let rawFileExists = false;
      try {
        rawFileExists = (await fs.stat(path.resolve(output))).isFile();
      } catch {}
      const failure = {
        ok: false,
        valid: false,
        target: { id: target.id, title: target.title, url: target.url },
        output: path.resolve(output),
        analysis: {
          available: false,
          error: error.message,
          code: error.code ?? null,
          fullMemoryParseLimitBytes: maxParseBytes,
        },
        trace: {
          path: path.resolve(output),
          tracingCompleteReceived: true,
          dataLossOccurred: complete.dataLossOccurred ?? null,
          rawTracePreserved: rawFileExists && error.code !== "EEXIST",
          existingOutputPreserved: rawFileExists && error.code === "EEXIST",
          transferMode: complete.stream ? "ReturnAsStream" : "dataCollected",
          transferComplete:
            rawTransferComplete || error.code === "TRACE_ANALYSIS_SIZE_LIMIT",
        },
      };
      await fs.mkdir(path.dirname(path.resolve(captureOutput)), {
        recursive: true,
      });
      await fs.writeFile(
        path.resolve(captureOutput),
        `${JSON.stringify(failure, null, 2)}\n`,
        "utf8",
      );
      throw error;
    }
    await traceLock.release();
    traceLock = null;
    const normalized = Array.isArray(parsed) ? { traceEvents: parsed } : parsed;
    const evidence = buildCaptureTraceEvidence(
      normalized,
      complete,
      bufferUsageSamples,
    );
    const captureResult = {
      ok: true,
      valid: evidence.completeness.valid && targetFrameBinding.valid,
      invalidReasons: targetFrameBinding.invalidReasons,
      target: {
        id: target.id,
        rootFrameId: targetFrameBinding.rootFrameId,
        title: target.title,
        url: target.url,
      },
      targetFrameBinding,
      page,
      output: path.resolve(output),
      captureOutput: path.resolve(captureOutput),
      durationMs: Date.now() - startedAt,
      requestedDurationMs: durationMs,
      categories,
      traceEventCount: normalized.traceEvents.length,
      analysis: { available: true, fullMemoryParseLimitBytes: maxParseBytes },
      transferMode: complete.stream ? "ReturnAsStream" : "dataCollected",
      tracingStartResult: startResult,
      trace: {
        path: path.resolve(output),
        categories,
        recordingMode: "record-until-full",
        ...evidence,
      },
      limitations: [
        "Generic trace capture does not send input or validate application state, geometry, or camera parity.",
        "Visibility is page state only; active rendering cadence must be verified separately.",
        "ReturnAsStream is written directly to disk. Summary analysis still parses the complete JSON in memory and is size-limited; an oversized raw trace remains available for Chrome Performance.",
        "The dataCollected fallback retains events in memory and is unsuitable for long recordings; use ReturnAsStream for those captures.",
      ],
    };
    await fs.mkdir(path.dirname(path.resolve(captureOutput)), {
      recursive: true,
    });
    await fs.writeFile(
      path.resolve(captureOutput),
      `${JSON.stringify(captureResult, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(captureResult, null, 2)}\n`);
  } finally {
    if (tracingStarted) {
      try {
        await session.send("Tracing.end");
      } catch {}
    }
    if (traceLock) {
      try {
        await traceLock.release();
      } catch {}
    }
    session.close();
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
