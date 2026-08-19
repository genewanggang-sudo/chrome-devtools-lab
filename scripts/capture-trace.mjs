#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { acquireTraceLock } from "./trace-lock.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
const TRACE_STREAM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CATEGORIES = [
  "-*",
  "blink",
  "browser",
  "cc",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.inputs",
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
      const message = JSON.parse(String(event.data));
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

async function readTraceStream(session, handle) {
  const chunks = [];
  let eof = false;
  while (!eof) {
    const result = await session.send("IO.read", {
      handle,
      size: TRACE_STREAM_CHUNK_BYTES,
    });
    chunks.push(result.data || "");
    eof = result.eof === true;
  }
  await session.send("IO.close", { handle });
  return chunks.join("");
}

function traceTextFromCollected(events) {
  return JSON.stringify({ traceEvents: events });
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
  const categories = String(options.categories || DEFAULT_CATEGORIES.join(","));
  const { target, host, port } = await selectTarget(options);
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  const collectedEvents = [];
  session.onEvent("Tracing.dataCollected", (params) => {
    if (Array.isArray(params.value)) collectedEvents.push(...params.value);
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
    const startResult = await session.send("Tracing.start", {
      categories,
      options: "record-until-full",
      transferMode: "ReturnAsStream",
    });
    tracingStarted = true;
    traceCompletePromise = session.waitForEvent("Tracing.tracingComplete");
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    await session.send("Tracing.end");
    const complete = await Promise.race([
      traceCompletePromise,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("Timed out waiting for Tracing.tracingComplete")),
          timeoutMs,
        ),
      ),
    ]);
    let traceText;
    if (complete.stream) {
      traceText = await readTraceStream(session, complete.stream);
    } else {
      traceText = traceTextFromCollected(collectedEvents);
    }
    await traceLock.release();
    traceLock = null;
    const parsed = JSON.parse(traceText);
    const normalized = Array.isArray(parsed)
      ? { traceEvents: parsed }
      : parsed && Array.isArray(parsed.traceEvents)
        ? parsed
        : { traceEvents: collectedEvents };
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(
      path.resolve(output),
      `${JSON.stringify(normalized)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          target: {
            id: target.id,
            title: target.title,
            url: target.url,
          },
          page,
          output: path.resolve(output),
          durationMs: Date.now() - startedAt,
          requestedDurationMs: durationMs,
          categories,
          traceEventCount: normalized.traceEvents.length,
          transferMode: complete.stream ? "ReturnAsStream" : "dataCollected",
          tracingStartResult: startResult,
        },
        null,
        2,
      )}\n`,
    );
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

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
