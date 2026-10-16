#!/usr/bin/env node

// Capture a V8 CPU profile (line-attributable) from an exact page target.
// Output is a standard .cpuprofile file that DevTools, analyze-cpu-profile.mjs,
// and speedscope can consume. CPU profiling is a separate evidence layer from
// frame-rate traces: never combine this sample with a Tracing-based KPI run.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireTraceLock } from "./trace-lock.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_DURATION_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_SAMPLING_INTERVAL_US = 1000;

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
    throw new Error("CPU profile capture requires --target-exact <target ID>.");
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
      for (const handler of handlers.get(message.method) || []) {
        handler(message.params || {});
      }
    });

    socket.addEventListener("error", () =>
      fail(new Error("CDP WebSocket error")),
    );
    socket.addEventListener("close", () => {
      fail(new Error("CDP WebSocket closed during CPU profile capture"));
    });
  });
}

async function evaluatePage(session) {
  const response = await session.send("Runtime.evaluate", {
    expression: `({
      url: location.href,
      title: document.title,
      visibilityState: document.visibilityState,
      readyState: document.readyState
    })`,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error("Runtime.evaluate failed while reading page state");
  }
  return response.result?.value || null;
}

function lineStartsFor(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export async function summarizeCoverage(
  session,
  scripts,
  limit,
  scriptInfoById,
) {
  const summarized = [];
  for (const script of scripts) {
    let source = "";
    try {
      const response = await session.send("Debugger.getScriptSource", {
        scriptId: script.scriptId,
      });
      source = response.scriptSource || "";
    } catch {
      source = "";
    }
    const info = scriptInfoById.get(script.scriptId) || {};
    // scriptParsed.startLine is the 0-based document line where the script
    // content begins; for inline scripts, source line 1 maps to startLine+1.
    const startLine = Number.isInteger(info.startLine) ? info.startLine : 0;
    const starts = lineStartsFor(source);
    const lineMax = new Map();
    const functions = [];
    for (const fn of script.functions || []) {
      const label = fn.functionName || "(script)";
      const definitionRange = fn.ranges?.[0];
      const callCount =
        typeof fn.callCount === "number"
          ? fn.callCount
          : (definitionRange?.count ?? 0);
      functions.push({
        functionName: label,
        callCount,
        scriptLine: definitionRange
          ? lineOf(starts, definitionRange.startOffset)
          : null,
        line: definitionRange
          ? startLine + lineOf(starts, definitionRange.startOffset)
          : null,
      });
      for (const range of fn.ranges || []) {
        if (!Number.isFinite(range.count) || range.count <= 0) continue;
        const firstLine = lineOf(starts, range.startOffset);
        const lastLine = lineOf(
          starts,
          Math.max(range.startOffset, range.endOffset - 1),
        );
        for (let line = firstLine; line <= lastLine; line += 1) {
          const existing = lineMax.get(line);
          if (!existing || range.count > existing.count) {
            lineMax.set(line, {
              count: range.count,
              functionName: label,
              documentLine: startLine + line,
            });
          }
        }
      }
    }
    summarized.push({
      url: script.url || info.url || "",
      scriptId: script.scriptId,
      inlineScript: startLine > 0,
      functionCount: (script.functions || []).length,
      functions: functions
        .map((fn) => ({
          ...fn,
          documentLine: fn.line,
        }))
        .sort((left, right) => right.callCount - left.callCount)
        .slice(0, limit),
      hotLinesByCount: [...lineMax.entries()]
        .map(([scriptLine, value]) => ({
          line: startLine + scriptLine,
          scriptLine,
          documentLine: startLine + scriptLine,
          count: value.count,
          functionName: value.functionName,
        }))
        .sort((left, right) => right.count - left.count)
        .slice(0, limit),
    });
  }
  return summarized;
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
  const samplingIntervalUs = integerOption(
    options,
    "sampling-interval-us",
    DEFAULT_SAMPLING_INTERVAL_US,
    10,
    1000000,
  );
  const reload = options.reload === true;
  const coverage = options.coverage === true;
  const coverageOutput = options["coverage-output"];
  if (
    coverage &&
    (typeof coverageOutput !== "string" || coverageOutput.length === 0)
  ) {
    throw new Error("--coverage requires --coverage-output <coverage.json>.");
  }
  const coverageLimit = integerOption(options, "coverage-limit", 25, 1, 500);
  let coverageState = null;
  const output = options.output;
  if (typeof output !== "string" || output.length === 0) {
    throw new Error(
      "CPU profile capture requires --output <profile.cpuprofile>.",
    );
  }
  const { target, host, port } = await selectTarget(options);
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  let lock = null;
  const startedAt = Date.now();
  try {
    const page = await evaluatePage(session);
    lock = await acquireTraceLock({
      host,
      port,
      timeoutMs,
      metadata: { script: "capture-cpu-profile", targetId: target.id },
    });
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", {
      interval: samplingIntervalUs,
    });
    if (coverage) {
      // scriptParsed gives the 0-based document line of each script so inline
      // scripts can be reported in document coordinates.
      const scriptInfoById = new Map();
      session.onEvent("Debugger.scriptParsed", (params) => {
        if (params?.scriptId) {
          scriptInfoById.set(params.scriptId, {
            url: params.url || "",
            startLine: params.startLine ?? 0,
          });
        }
      });
      await session.send("Debugger.enable");
      // Chrome 152 ignores blockCount; block-level ranges require detailed:true.
      await session.send("Profiler.startPreciseCoverage", {
        callCount: true,
        detailed: true,
        blockCount: true,
        allowTriggeredUpdates: true,
      });
      coverageState = { scriptInfoById };
    }
    await session.send("Profiler.start");
    if (reload) {
      await session.send("Page.reload", { ignoreCache: false });
    }
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const stopResult = await session.send("Profiler.stop");
    const profile = stopResult?.profile;
    if (!profile || !Array.isArray(profile.nodes)) {
      throw new Error("Profiler.stop returned no profile data");
    }
    let coverageScripts = null;
    if (coverage && coverageState) {
      // takePreciseCoverage returns the collected counts; stopPreciseCoverage
      // only disables collection and carries no payload.
      const takeResult = await session.send("Profiler.takePreciseCoverage");
      await session.send("Profiler.stopPreciseCoverage").catch(() => {});
      coverageScripts = await summarizeCoverage(
        session,
        takeResult?.result || [],
        coverageLimit,
        coverageState.scriptInfoById,
      );
    }
    await lock.release();
    lock = null;
    const profiledUs =
      Number(profile.endTime || 0) - Number(profile.startTime || 0);
    const cpuprofile = {
      nodes: profile.nodes,
      samples: profile.samples || [],
      timeDeltas: profile.timeDeltas || [],
      startTime: profile.startTime,
      endTime: profile.endTime,
    };
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(
      path.resolve(output),
      `${JSON.stringify(cpuprofile)}\n`,
      "utf8",
    );
    let coverageFile = null;
    if (coverage) {
      await fs.mkdir(path.dirname(path.resolve(coverageOutput)), {
        recursive: true,
      });
      await fs.writeFile(
        path.resolve(coverageOutput),
        `${JSON.stringify(
          {
            ok: true,
            note: "Precise coverage reports instrumented range counts, not elapsed time or exact statement/line execution frequencies. Enclosing function and nested block ranges may overlap; each displayed line count is the maximum positive count among ranges overlapping that line. This can include unexecuted nested code inside an executed outer range. Coverage instrumentation affects measured wall times; use sampling-only captures for timing comparisons. line/documentLine are 1-based script positions translated to document coordinates exactly once via Debugger.scriptParsed.startLine; scriptLine is relative to the script. Positions refer to captured JavaScript, not automatically source-mapped source files.",
            target: { id: target.id, url: target.url },
            reload,
            scripts: coverageScripts,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      coverageFile = path.resolve(coverageOutput);
    }
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
          coverageOutput: coverageFile,
          reload,
          coverage,
          requestedDurationMs: durationMs,
          wallDurationMs: Date.now() - startedAt,
          profiledDurationMs: Number.isFinite(profiledUs)
            ? Math.round(profiledUs / 1000)
            : null,
          samplingIntervalUs,
          nodeCount: cpuprofile.nodes.length,
          sampleCount: cpuprofile.samples.length,
          coverageScripts: coverageScripts
            ? coverageScripts.map((script) => ({
                url: script.url,
                hotLinesByCount: script.hotLinesByCount.slice(0, 5),
              }))
            : undefined,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch {}
    }
    session.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
