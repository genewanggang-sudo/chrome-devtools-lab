import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  analyzePerformanceTrace,
  NativePerformanceAnalysis,
  PerformanceSummary,
  PerformanceTraceSession,
  browserAnalysisSource,
  resolvePerformanceWindow,
} from "./devtools-performance.mjs";
import {
  loadDevTools,
  loadTraceParser,
  getDevToolsRuntime,
} from "./devtools-runtime.mjs";
const runFile = promisify(execFile);

function fixtureEvents() {
  const base = 1_000_000;
  const complete = (name, offset, duration, extra = {}) => ({
    cat: "devtools.timeline",
    name,
    ph: "X",
    pid: 10,
    tid: 11,
    ts: base + offset,
    dur: duration,
    args: {},
    ...extra,
  });
  const nodes = [
    {
      id: 1,
      callFrame: {
        functionName: "(root)",
        scriptId: "0",
        url: "",
        lineNumber: -1,
        columnNumber: -1,
      },
      children: [2],
    },
    {
      id: 2,
      parent: 1,
      callFrame: {
        functionName: "work",
        scriptId: "7",
        url: "https://fixture.test/app.js",
        lineNumber: 3,
        columnNumber: 0,
      },
      children: [3],
    },
    {
      id: 3,
      parent: 2,
      callFrame: {
        functionName: "work",
        scriptId: "7",
        url: "https://fixture.test/app.js",
        lineNumber: 3,
        columnNumber: 0,
      },
    },
  ];
  return [
    {
      name: "process_name",
      cat: "__metadata",
      ph: "M",
      pid: 1,
      tid: 1,
      ts: 0,
      args: { name: "Browser" },
    },
    {
      name: "thread_name",
      cat: "__metadata",
      ph: "M",
      pid: 10,
      tid: 11,
      ts: 0,
      args: { name: "CrRendererMain" },
    },
    {
      name: "thread_name",
      cat: "__metadata",
      ph: "M",
      pid: 20,
      tid: 21,
      ts: 0,
      args: { name: "CrRendererMain" },
    },
    {
      name: "TracingStartedInBrowser",
      cat: "disabled-by-default-devtools.timeline",
      ph: "I",
      pid: 1,
      tid: 1,
      ts: base,
      args: {
        data: {
          frames: [
            {
              frame: "frame-a",
              processId: 10,
              url: "https://fixture.test/",
              isOutermostMainFrame: true,
              isInPrimaryMainFrame: true,
            },
            {
              frame: "frame-b",
              processId: 20,
              url: "https://other.test/",
              isOutermostMainFrame: false,
              isInPrimaryMainFrame: false,
            },
          ],
        },
      },
    },
    complete("RunTask", 0, 100_000),
    complete("Compute", 0, 100_000),
    complete("Compute", 10_000, 80_000),
    complete("MajorGC", 20_000, 30_000),
    complete("V8.GCIncrementalMarking", 25_000, 10_000),
    complete("RunTask", 5_000, 80_000, { pid: 20, tid: 21 }),
    {
      name: "Profile",
      cat: "disabled-by-default-v8.cpu_profiler",
      ph: "P",
      pid: 10,
      tid: 11,
      ts: base,
      id: "profile-1",
      args: { data: { startTime: base, source: "Inspector" } },
    },
    {
      name: "ProfileChunk",
      cat: "disabled-by-default-v8.cpu_profiler",
      ph: "P",
      pid: 10,
      tid: 11,
      ts: base + 100_000,
      id: "profile-1",
      args: {
        data: {
          cpuProfile: { nodes, samples: [2, 2, 3, 3, 3, 2, 2, 3, 3, 2] },
          timeDeltas: [
            1, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
            9_999,
          ],
        },
      },
    },
    {
      name: "fixture-ready",
      cat: "blink.user_timing",
      ph: "I",
      pid: 10,
      tid: 11,
      ts: base + 75_000,
      args: { data: { detail: "ready" } },
    },
  ];
}

async function withTrace(fn) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chrome-lab-native-analysis-"),
  );
  const input = path.join(directory, "trace.json");
  await fs.writeFile(input, JSON.stringify({ traceEvents: fixtureEvents() }));
  try {
    return await fn({ directory, input });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("parsed sessions reuse one native parse across marked queries with explicit timings", async () =>
  withTrace(async ({ input, directory }) => {
    const session = await PerformanceTraceSession.open({ input });
    const first = await session.query({ endMark: "fixture-ready", output: path.join(directory, "ready.json") });
    const second = await session.query({ startMs: 25, endMs: 75 });
    assert.equal(first.window.endMs, 75);
    assert.equal(second.window.durationMs, 50);
    assert.equal(session.timings.parseCount, 1);
    assert.equal(session.queryCount, 2);
    assert.equal(first.processing.reusedParse, false);
    assert.equal(second.processing.reusedParse, true);
    assert.ok(session.timings.parseMs >= 0);
    const summary = new PerformanceSummary(first).reportSummary();
    assert.ok(summary.javascriptHotspotsByTotal.some(node => node.name === "work"));
    assert.ok(summary.marks.some(mark => mark.name === "fixture-ready"));
    await assert.rejects(session.query({ startMark: "missing" }), /exactly one/);
    await assert.rejects(session.query({ startMark: "fixture-ready", startMs: 1 }), /not both/);
    await assert.rejects(session.query({ input: path.join(directory, "different.json") }), /does not match/);
  }));

test("runtime resolves the pinned distributable native DevTools package", async () => {
  const runtime = await getDevToolsRuntime();
  assert.equal(runtime.version, "1.10.1");
  const { DevTools } = await loadDevTools();
  assert.equal(
    typeof DevTools.TraceEngine.Extras.TraceTree.BottomUpRootNode,
    "function",
  );
  assert.equal(
    typeof (await loadTraceParser()).parseRawTraceBuffer,
    "function",
  );
});

test("shared analysis executes without Node globals and matches the offline report", async () =>
  withTrace(async ({ input }) => {
    const session = await PerformanceTraceSession.open({ input });
    // This context has neither Node imports nor DOM globals. The expression must
    // carry every helper used by the exact same report classes as the CLI.
    const browser = runInNewContext(browserAnalysisSource(), Object.create(null));
    const capture = { targetId: "target-a", mainFrameId: "frame-a" };
    const query = { targetId: "target-a", endMark: "fixture-ready" };
    const options = resolvePerformanceWindow(session.parsedTrace, query, capture);
    const native = {
      ...session.native,
      analysisEngine: {
        package: "Chrome native frontend",
        version: "Chrome/test",
        parser: "existing native parsed recording",
      },
    };
    const expected = new NativePerformanceAnalysis(native, session.parsedTrace, options, capture).report();
    const actual = new browser.NativePerformanceAnalysis(native, session.parsedTrace,
      browser.resolvePerformanceWindow(session.parsedTrace, query, capture), capture).report();
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(actual), plain(expected));
    assert.deepEqual(plain(new browser.PerformanceSummary(actual).reportSummary()),
      plain(new PerformanceSummary(expected).reportSummary()));
    assert.equal(actual.engine.package, "Chrome native frontend");
    assert.equal(actual.engine.version, "Chrome/test");
    assert.equal(actual.engine.parser, "existing native parsed recording");
    assert.equal(actual.window.endMs, 75);
    assert.equal(actual.scope.targetId, "target-a");
    assert.ok(actual.threads.find(thread => thread.selected)?.javascript);
    assert.throws(() => browser.resolvePerformanceWindow(session.parsedTrace,
      { startMark: "fixture-ready", startMs: 0 }, capture), /not both/);
    assert.throws(() => browser.resolvePerformanceWindow(session.parsedTrace,
      { startMark: "missing" }, capture), /exactly one/);
  }));

test("native parsing preserves source and reports tasks, CPU samples and frame attribution", async () =>
  withTrace(async ({ directory, input }) => {
    const before = await fs.readFile(input);
    const output = path.join(directory, "report.json");
    const report = await analyzePerformanceTrace({
      input,
      output,
      capture: {
        target: { id: "target-a" },
        frameBefore: { frameTree: { frame: { id: "frame-a" } } },
      },
    });
    assert.equal(
      report.source.sha256,
      createHash("sha256").update(before).digest("hex"),
    );
    assert.deepEqual(await fs.readFile(input), before);
    assert.equal(report.scope.targetId, "target-a");
    assert.deepEqual(report.scope.rendererPids, [10]);
    const main = report.threads.find(
      (thread) => thread.pid === 10 && thread.tid === 11,
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(directory, "summary.json"), "utf8"),
    );
    assert.equal(summary.artifacts.report, output);
    assert.equal(
      summary.artifacts.summary,
      path.join(directory, "summary.json"),
    );
    assert.equal(summary.source.sha256, report.source.sha256);
    assert.equal(
      summary.threads.find((thread) => thread.pid === 10).taskTimeMs,
      100,
    );
    assert.equal(summary.longTasks.length, 1);
    assert.equal(summary.longTasks[0].durationMs, 100);
    assert.ok(summary.javascriptHotspots.some((node) => node.name === "work"));
    assert.equal(summary.gc.eventCount, report.gc.events.length);
    assert.equal(summary.gc.threadTimeMs[0].durationMs, 30);
    assert.match(summary.truncation.note, /raw trace events remain unchanged/);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 20_000);
    assert.equal(main.isMainThread, true);
    assert.equal(main.longTaskCount, 1);
    assert.equal(main.taskTimeMs, 100);
    assert.equal(main.blockingTimeMs, 50);
    assert.equal(main.sampling.sampleCount, 10);
    assert.ok(
      main.javascript.bottomUp.nodes.some((node) => node.name === "work"),
    );
    assert.equal(
      report.threads.find((thread) => thread.pid === 20 && thread.tid === 21)
        .selected,
      false,
    );
    assert.ok(report.marks.some((mark) => mark.name === "fixture-ready"));
    assert.equal(
      report.gc.threadTimeMs.find((thread) => thread.thread === "10:11")
        .durationMs,
      30,
    );
    assert.equal(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".html"))
        .length,
      0,
    );
  }));

test("lazy first pass preserves native hotspots and timings while explicit expansion returns call chains", async () =>
  withTrace(async ({ input }) => {
    const options = { input, capture: { mainFrameId: "frame-a" } };
    const first = await analyzePerformanceTrace(options);
    const expanded = await analyzePerformanceTrace({
      ...options,
      expandCallTree: true,
    });
    for (const key of ["window", "scope", "coverage", "network", "gc", "marks"])
      assert.deepEqual(first[key], expanded[key]);
    const main = first.threads.find((thread) => thread.pid === 10);
    const detailed = expanded.threads.find((thread) => thread.pid === 10);
    for (const kind of ["activity", "javascript"]) {
      assert.deepEqual(main[kind].bottomUp, detailed[kind].bottomUp);
      assert.equal(main[kind].callTree.totalMs, detailed[kind].callTree.totalMs);
      assert.equal(main[kind].callTree.descendantsIncluded, false);
      assert.ok(main[kind].callTree.nodes.every((node) => node.depth === 0 && !node.childrenExpanded));
    }
    assert.equal(main.activity.callTree.descendantsDeferred, true);
    assert.ok(detailed.activity.callTree.nodes.some((node) => node.depth > 0));
    assert.deepEqual(
      new PerformanceSummary(first).reportSummary().javascriptHotspots,
      new PerformanceSummary(expanded).reportSummary().javascriptHotspots,
    );
    assert.ok(new PerformanceSummary(first).reportSummary().truncation.nativeTrees.some((tree) => tree.descendantsDeferred));
  }));

test("first-pass summary bounds details and reports native tree limits without expanding them", async () =>
  withTrace(async ({ directory, input }) => {
    const output = path.join(directory, "window-25-75.json");
    const report = await analyzePerformanceTrace({
      input,
      output,
      maxNodes: 1,
      maxDepth: 0,
    });
    assert.equal(
      report.artifacts.summary,
      path.join(directory, "window-25-75.summary.json"),
    );
    const main = report.threads.find((thread) => thread.selected);
    const originalTasks = [...main.topLevelTasks];
    main.topLevelTasks = Array.from({ length: 25 }, (_, index) => ({
      name: "RunTask",
      startMs: index,
      durationMs: 100 + index,
      selectedDurationMs: 100 + index,
    }));
    report.network.requests = Array.from({ length: 25 }, (_, index) => ({
      url:
        index === 24
          ? `https://fixture.test/${"x".repeat(100_000)}`
          : `https://fixture.test/${index}`,
      startMs: index,
      durationMs: 100 + index,
      selectedDurationMs: 100 + index,
    }));
    const before = JSON.stringify(report);
    const summary = new PerformanceSummary(report).reportSummary();
    assert.equal(summary.longTasks.length, 10);
    assert.equal(summary.longTasks[0].durationMs, 124);
    assert.equal(summary.truncation.longTasksOmitted, 15);
    assert.equal(summary.network.slowestRequests.length, 10);
    assert.equal(summary.network.requestCount, 25);
    assert.ok(summary.network.slowestRequests[0].url.length < 1100);
    assert.equal(summary.truncation.textValuesShortened, 1);
    assert.equal(summary.truncation.requestsOmitted, 15);
    assert.ok(summary.truncation.nativeTrees.length > 0);
    assert.equal(summary.truncation.nativeTrees[0].maxNodes, 1);
    assert.equal(JSON.stringify(report), before);
    main.topLevelTasks = originalTasks;
  }));

test("unified analysis CLI prints the saved summary path and bounded hotspots", async () =>
  withTrace(async ({ directory, input }) => {
    const { stdout } = await runFile(process.execPath, [
      fileURLToPath(new URL("./performance.mjs", import.meta.url)),
      "analyze",
      "--input",
      input,
      "--output",
      path.join(directory, "report.json"),
    ]);
    const result = JSON.parse(stdout);
    assert.equal(
      result.artifacts.summary,
      path.join(directory, "summary.json"),
    );
    assert.equal(result.coverage.sampledThreadCount, 1);
    assert.ok(result.javascriptHotspots.length <= 5);
    assert.equal(result.threads, undefined);
    assert.ok(Buffer.byteLength(stdout) < 10_000);
  }));

test("summary distinguishes selected coverage and preserves navigation insight scope", async () =>
  withTrace(async ({ input }) => {
    const events = fixtureEvents();
    events.push(
      ...events
        .filter(
          (event) => event.name === "Profile" || event.name === "ProfileChunk",
        )
        .map((event) => ({
          ...event,
          pid: 20,
          tid: 21,
          id: "profile-other-frame",
        })),
    );
    await fs.writeFile(input, JSON.stringify({ traceEvents: events }));
    const report = await analyzePerformanceTrace({
      input,
      frameId: "frame-a",
      startMs: 25,
      endMs: 75,
    });
    assert.equal(report.coverage.sampledThreadCount, 2);
    assert.equal(report.coverage.selectedSampledThreadCount, 1);
    assert.equal(report.coverage.selectedThreadCount, 1);
    assert.match(report.coverage.scope, /complete trace/);
    const bounds = { min: 1_000_000, max: 1_100_000, range: 100_000 };
    report.insights.sets = [
      {
        id: "navigation-outside-selection",
        frameId: "frame-b",
        bounds,
        errors: [],
        models: [{ name: "Example", state: "fail", title: "Fixture finding" }],
      },
    ];
    const summary = new PerformanceSummary(report).reportSummary();
    assert.equal(summary.coverage.selectedSampledThreadCount, 1);
    assert.equal(summary.insights.scope, report.insights.scope);
    assert.match(summary.insights.scope, /outside the selected query window/);
    assert.equal(summary.insights.findings[0].frameId, "frame-b");
    assert.deepEqual(summary.insights.findings[0].bounds, bounds);
  }));

test("unified analysis CLI expands call chains only when explicitly requested", async () =>
  withTrace(async ({ directory, input }) => {
    const output = path.join(directory, "expanded.json");
    await runFile(process.execPath, [
      fileURLToPath(new URL("./performance.mjs", import.meta.url)),
      "analyze", "--input", input, "--output", output, "--expand-call-tree",
    ]);
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    assert.ok(report.threads.find((thread) => thread.pid === 10).activity.callTree.nodes.some((node) => node.depth > 0));
  }));

test("unified CLI accepts conventional help flags without starting Chrome", async () => {
  for (const flag of ["--help", "-h"]) {
    const { stdout } = await runFile(process.execPath, [
      fileURLToPath(new URL("./performance.mjs", import.meta.url)),
      flag,
    ]);
    assert.match(stdout, /--max-nodes 100 --max-depth 10/);
    assert.match(stdout, /Read summary.json first/);
  }
});

test("native Bottom-up avoids recursive duration inflation and clips selected ranges", async () =>
  withTrace(async ({ input }) => {
    const full = await analyzePerformanceTrace({ input });
    const compute = full.threads
      .find((thread) => thread.pid === 10)
      .activity.bottomUp.nodes.find((node) => node.name === "Compute");
    assert.equal(compute.totalMs, 100);
    const selected = await analyzePerformanceTrace({
      input,
      startMs: 25,
      endMs: 75,
      frameId: "frame-a",
    });
    const main = selected.threads.find((thread) => thread.pid === 10);
    assert.equal(main.taskTimeMs, 50);
    assert.equal(main.blockingTimeMs, 25);
    assert.equal(
      main.activity.bottomUp.nodes.find((node) => node.name === "Compute")
        .totalMs,
      50,
    );
    assert.equal(
      selected.gc.threadTimeMs.find((thread) => thread.thread === "10:11")
        .durationMs,
      25,
    );
    assert.equal(selected.window.durationMs, 50);
  }));

test("query rejects malformed windows, input overwrites and accidental output replacement", async () =>
  withTrace(async ({ directory, input }) => {
    await assert.rejects(
      analyzePerformanceTrace({ input, startMs: -1 }),
      /Invalid time range/,
    );
    await assert.rejects(
      analyzePerformanceTrace({ input, startMs: 30, endMs: 20 }),
      /Invalid time range/,
    );
    await assert.rejects(
      analyzePerformanceTrace({ input, output: input, overwrite: true }),
      /must not overwrite/,
    );
    const output = path.join(directory, "existing.json");
    await fs.writeFile(output, "preserve-me");
    await assert.rejects(analyzePerformanceTrace({ input, output }), /EEXIST/);
    assert.equal(await fs.readFile(output, "utf8"), "preserve-me");
    await assert.rejects(
      fs.access(path.join(directory, "existing.summary.json")),
      { code: "ENOENT" },
    );
  }));

test("summary conflicts reject before creating a report and overwrite replaces both outputs", async () =>
  withTrace(async ({ directory, input }) => {
    const output = path.join(directory, "report.json");
    const summaryOutput = path.join(directory, "summary.json");
    await fs.writeFile(summaryOutput, "preserve-summary");
    await assert.rejects(analyzePerformanceTrace({ input, output }), {
      code: "EEXIST",
    });
    await assert.rejects(fs.access(output), { code: "ENOENT" });
    assert.equal(await fs.readFile(summaryOutput, "utf8"), "preserve-summary");
    await analyzePerformanceTrace({ input, output, overwrite: true });
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    const summary = JSON.parse(await fs.readFile(summaryOutput, "utf8"));
    assert.equal(report.artifacts.summary, summaryOutput);
    assert.equal(summary.artifacts.report, output);
    assert.equal(summary.source.sha256, report.source.sha256);
    await analyzePerformanceTrace({
      input,
      output,
      overwrite: true,
      startMs: 25,
      endMs: 75,
    });
    assert.equal(
      JSON.parse(await fs.readFile(output, "utf8")).window.durationMs,
      50,
    );
    assert.equal(
      JSON.parse(await fs.readFile(summaryOutput, "utf8")).window.durationMs,
      50,
    );
  }));

test("unknown frame remains explicitly unattributed instead of reporting it as a verified target", async () =>
  withTrace(async ({ input }) => {
    const report = await analyzePerformanceTrace({
      input,
      frameId: "missing-frame",
      targetId: "missing-target",
    });
    assert.match(report.scope.attribution, /unattributed/);
    assert.equal(report.scope.warnings.length, 1);
  }));

test("native compressed Performance exports are decoded without changing the original gzip file", async () =>
  withTrace(async ({ directory, input }) => {
    const original = await fs.readFile(input);
    const zipped = gzipSync(original);
    const compressed = path.join(directory, "native-export.json.gz");
    await fs.writeFile(compressed, zipped);
    const report = await analyzePerformanceTrace({
      input: compressed,
      startMs: 0,
      endMs: 50,
    });
    assert.equal(report.source.encoding, "gzip");
    assert.equal(report.source.bytes, zipped.length);
    assert.equal(report.source.parserInputBytes, original.length);
    assert.deepEqual(await fs.readFile(compressed), zipped);
    assert.ok(
      report.insights.sets.every((set) =>
        set.errors.every((error) => !error.error.includes("LanguageSelector")),
      ),
    );
  }));

test("an associated worker in another process retains native JS analysis without inventing task metrics", async () =>
  withTrace(async ({ input }) => {
    const events = fixtureEvents();
    events.push({
      name: "thread_name",
      cat: "__metadata",
      ph: "M",
      pid: 30,
      tid: 31,
      ts: 0,
      args: { name: "DedicatedWorker thread" },
    });
    events.push({
      name: "TracingSessionIdForWorker",
      cat: "disabled-by-default-devtools.timeline",
      ph: "I",
      pid: 30,
      tid: 31,
      ts: 1_000_000,
      args: {
        data: {
          frame: "frame-a",
          workerId: "worker-other-process",
          workerThreadId: 31,
          url: "https://fixture.test/worker.js",
        },
      },
    });
    events.push(
      ...events
        .filter(
          (event) => event.name === "Profile" || event.name === "ProfileChunk",
        )
        .map((event) => ({ ...event, pid: 30, tid: 31, id: "profile-worker" })),
    );
    await fs.writeFile(input, JSON.stringify({ traceEvents: events }));
    const report = await analyzePerformanceTrace({ input, frameId: "frame-a" });
    const worker = report.threads.find(
      (thread) => thread.pid === 30 && thread.tid === 31,
    );
    assert.equal(worker.selected, true);
    assert.equal(worker.worker.workerId, "worker-other-process");
    assert.equal(worker.sampling.sampleCount, 10);
    assert.ok(
      worker.javascript.bottomUp.nodes.some((node) => node.name === "work"),
    );
    assert.equal(worker.taskTimeMs, undefined);
    assert.match(worker.activityAvailability, /Sample-only/);
  }));
