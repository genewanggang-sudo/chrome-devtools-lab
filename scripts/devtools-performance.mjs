import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadTraceParser } from "./devtools-runtime.mjs";
import {
  NativePerformanceAnalysis, PerformanceSummary, resolvePerformanceWindow,
} from "./performance-analysis.mjs";
export {
  NativePerformanceAnalysis, PerformanceSummary, resolvePerformanceWindow, browserAnalysisSource,
} from "./performance-analysis.mjs";
const decompressGzip = promisify(gunzip);

class PerformanceArtifacts {
  static async write(entries, overwrite) {
    const checks = await Promise.allSettled(
      entries.map(async ({ path: output }) => {
        try {
          const stat = await fs.lstat(output);
          if (!overwrite)
            throw Object.assign(
              new Error(`EEXIST: output already exists, '${output}'`),
              { code: "EEXIST" },
            );
          if (!stat.isFile())
            throw new Error(
              `Analysis output must be a regular file: ${output}`,
            );
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    const rejected = checks.find((check) => check.status === "rejected");
    if (rejected) throw rejected.reason;
    const opened = [];
    let writing = false;
    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const existed = checks[index].value;
        const file = await fs.open(entry.path, existed ? "r+" : "wx");
        opened.push({ ...entry, file, created: !existed });
      }
      writing = true;
      for (const entry of opened) {
        await entry.file.truncate(0);
        await entry.file.writeFile(entry.text);
      }
    } finally {
      for (const entry of opened) {
        await entry.file.close();
        // A reservation race must not leave a report pointing at another
        // run's summary. Once writing begins, preserve partial evidence.
        if (!writing && entry.created) await fs.unlink(entry.path);
      }
    }
  }
}

/** Explicitly owned parsed recording. Multiple queries reuse one official parse. */
export class PerformanceTraceSession {
  static async open(options = {}) {
    const started = performance.now();
    if (!options.input) throw new Error("input is required.");
    const input = path.resolve(options.input);
    const sourceBuffer = await fs.readFile(input);
    const compressed = sourceBuffer[0] === 0x1f && sourceBuffer[1] === 0x8b;
    const buffer = compressed ? await decompressGzip(sourceBuffer) : sourceBuffer;
    const readMs = performance.now() - started;
    let capture = options.capture;
    if (typeof capture === "string")
      capture = JSON.parse(await fs.readFile(capture, "utf8"));
    const runtimeStarted = performance.now();
    const native = await loadTraceParser();
    const runtimeMs = performance.now() - runtimeStarted;
    const parseStarted = performance.now();
    const result = await native.parseRawTraceBuffer(buffer);
    if (!native.traceResultIsSuccess(result))
      throw new Error(
        `Chrome DevTools could not parse the trace: ${result.error}`,
      );
    const session = new PerformanceTraceSession();
    session.native = native;
    session.parsedTrace = result.parsedTrace;
    session.capture = capture;
    session.queryCount = 0;
    session.timings = { readMs, runtimeMs, parseMs: performance.now() - parseStarted, queryMs: 0, writeMs: 0, parseCount: 1 };
    session.source = {
      input,
      bytes: sourceBuffer.length,
      parserInputBytes: buffer.length,
      encoding: compressed ? "gzip" : "utf8",
      sha256: createHash("sha256").update(sourceBuffer).digest("hex"),
      originalPreserved: true,
    };
    return session;
  }

  resolveWindow(options, capture) {
    return resolvePerformanceWindow(this.parsedTrace, options, capture);
  }

  async query(options = {}) {
    const started = performance.now();
    let capture = options.capture ?? this.capture;
    if (typeof capture === "string") capture = JSON.parse(await fs.readFile(capture, "utf8"));
    const capturedTarget = capture?.target?.id ?? capture?.targetId;
    if (options.targetId && capturedTarget && options.targetId !== capturedTarget)
      throw new Error("targetId does not match the capture sidecar target.");
    if (options.input && path.resolve(options.input) !== this.source.input) throw new Error("Query input does not match this parsed recording.");
    const report = new NativePerformanceAnalysis(this.native, this.parsedTrace, this.resolveWindow(options, capture), capture).report();
    this.queryCount++;
    const queryMs = performance.now() - started;
    this.timings.queryMs += queryMs;
    report.source = this.source;
    report.processing = { parseCount: 1, queryIndex: this.queryCount, reusedParse: this.queryCount > 1, readMs: this.timings.readMs, runtimeMs: this.timings.runtimeMs, parseMs: this.timings.parseMs, queryMs };
    const input = this.source.input;
    if (options.output) {
      const output = path.resolve(options.output);
      const parsedOutput = path.parse(output);
      const summaryOutput = path.resolve(
        parsedOutput.dir,
        parsedOutput.base === "report.json"
          ? "summary.json"
          : `${parsedOutput.name}.summary.json`,
      );
      if (
        process.platform === "win32"
          ? output.toLowerCase() === input.toLowerCase()
          : output === input
      )
        throw new Error("Analysis output must not overwrite the original trace.");
      if (
        process.platform === "win32"
          ? summaryOutput.toLowerCase() === input.toLowerCase()
          : summaryOutput === input
      )
        throw new Error(
          "Analysis summary must not overwrite the original trace.",
        );
      report.artifacts = { report: output, summary: summaryOutput };
      await fs.mkdir(path.dirname(output), { recursive: true });
      const writeStarted = performance.now();
      await PerformanceArtifacts.write(
        [
          { path: output, text: `${JSON.stringify(report, null, 2)}\n` },
          {
            path: summaryOutput,
            text: `${JSON.stringify(new PerformanceSummary(report).reportSummary(), null, 2)}\n`,
          },
        ],
        Boolean(options.overwrite),
      );
      this.timings.writeMs += performance.now() - writeStarted;
    }
    return report;
  }
}

/** Analyze an unchanged Chrome trace using the pinned upstream DevTools parser and trees. */
export async function analyzePerformanceTrace(options = {}) {
  const session = options.session ?? await PerformanceTraceSession.open(options);
  return session.query(options);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== "analyze" || argv.includes("--help")) {
    console.log(
      "Usage: node scripts/devtools-performance.mjs analyze --input trace.json [--output report.json] [--capture capture.json] [--start-ms N --end-ms N | --start-mark NAME --end-mark NAME] [--frame-id ID] [--pid N --tid N] [--expand-call-tree] [--max-nodes 100 --max-depth 10] [--overwrite]\nDefaults: native tree roots and Bottom-up hotspots only; --expand-call-tree expands call chains, bounded by 100 nodes / depth 10. An output report also saves a bounded summary.json (or <report-name>.summary.json); stdout contains only paths, coverage and five hotspots.",
    );
    return;
  }
  const names = {
    input: "input",
    output: "output",
    capture: "capture",
    "start-ms": "startMs",
    "end-ms": "endMs",
    "start-mark": "startMark",
    "end-mark": "endMark",
    "frame-id": "frameId",
    "target-id": "targetId",
    pid: "pid",
    tid: "tid",
    "max-nodes": "maxNodes",
    "max-depth": "maxDepth",
  };
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--overwrite") options.overwrite = true;
    else if (key === "--expand-call-tree") options.expandCallTree = true;
    else if (
      key.startsWith("--") &&
      names[key.slice(2)] &&
      argv[i + 1] &&
      !argv[i + 1].startsWith("--")
    )
      options[names[key.slice(2)]] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  const report = await analyzePerformanceTrace(options);
  const summary = new PerformanceSummary(report).reportSummary();
  console.log(
    JSON.stringify(
      {
        artifacts: report.artifacts ?? null,
        window: summary.window,
        coverage: summary.coverage,
        scope: summary.scope,
        javascriptHotspots: summary.javascriptHotspots.slice(0, 5),
        truncatedNativeTrees: summary.truncation.nativeTrees.length,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
