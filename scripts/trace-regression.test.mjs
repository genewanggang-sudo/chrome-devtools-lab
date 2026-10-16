import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseTraceJson } from "./trace-json.mjs";
import {
  analyzeCompositorFps,
  collectCompositorSwapEvents,
  findTargetRendererProcesses,
  buildTargetFrameBinding,
  readTargetFrameTree,
  resolveTargetFrameBinding,
  findTraceWindow,
} from "./frame-rate.mjs";
import { analyzeTrace } from "./analyze-trace.mjs";
import { buildCaptureTraceEvidence } from "./capture-trace.mjs";

function traceStart(frames = [{ frame: "target", processId: 10 }]) {
  return {
    name: "TracingStartedInBrowser",
    cat: "disabled-by-default-devtools.timeline",
    ph: "I",
    ts: 100,
    pid: 1,
    tid: 1,
    args: { data: { frames } },
  };
}

function pipeline(step, fields, pid = 20, ts = 200) {
  return {
    name: "Graphics.Pipeline",
    cat: "viz,benchmark,graphics.pipeline",
    ph: "X",
    pid,
    tid: 2,
    ts,
    args: { chrome_graphics_pipeline: { step, ...fields } },
  };
}

function reporter(surface, display, state = "STATE_PRESENTED_ALL") {
  return {
    name: "PipelineReporter",
    cat: "cc,benchmark,disabled-by-default-devtools.timeline.frame",
    ph: "b",
    pid: 10,
    tid: 1,
    ts: 150,
    args: {
      frame_reporter: {
        surface_frame_trace_id: surface,
        display_trace_id: display,
        state,
      },
    },
  };
}

function pageFrameTree(rootId = "target", children = []) {
  return {
    frameTree: {
      frame: {
        id: rootId,
        loaderId: `loader-${rootId}`,
        url: "https://same.example/",
      },
      childFrames: children.map((frame) => ({
        frame: {
          id: frame.id,
          parentId: rootId,
          loaderId: `loader-${frame.id}`,
          url: "https://same.example/",
        },
        ...(frame.children
          ? {
              childFrames: frame.children.map((child) => ({
                frame: {
                  id: child,
                  parentId: frame.id,
                  loaderId: `loader-${child}`,
                  url: "https://same.example/",
                },
              })),
            }
          : {}),
      })),
    },
  };
}

test("raw trace IDs remain exact across parse and JSON serialization", () => {
  const raw =
    '{"ids":[-7549611329979386641,-7549611329979386642],"ts":294202288006,"text":"number -7549611329979386641 \\"quoted\\"", "decimal":1.5}';
  const parsed = parseTraceJson(raw);
  assert.deepEqual(parsed.ids, [
    "-7549611329979386641",
    "-7549611329979386642",
  ]);
  assert.equal(parsed.ts, 294202288006);
  assert.equal(parsed.decimal, 1.5);
  assert.equal(parsed.text, 'number -7549611329979386641 "quoted"');
  assert.deepEqual(parseTraceJson(JSON.stringify(parsed)), parsed);
  assert.throws(() => parseTraceJson('{"bad":01}'));
});

test("nested frame reporter joins the target surface to its display without unrelated swaps", () => {
  const surface = "-7549611329979386641";
  const display = "-7549611329979386594";
  const events = [
    traceStart(),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: surface },
      10,
    ),
    reporter(surface, display),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: display }, 20, 300),
    pipeline(
      "STEP_DRAW_AND_SWAP",
      { display_trace_id: "-7549611329979386595" },
      20,
      301,
    ),
  ];
  const result = collectCompositorSwapEvents(events, { targetId: "target" });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.selected.length, 1);
  assert.equal(result.binding, "surface-trace-id");
  assert.deepEqual(result.targetDisplayTraceIds, [display]);
  assert.deepEqual(result.targetCorrelationSources, [
    "PipelineReporter.STATE_PRESENTED_ALL",
  ]);
});

test("surface aggregation joins distinct ID domains", () => {
  const events = [
    traceStart(),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: "surface-1" },
      10,
    ),
    pipeline("STEP_SURFACE_AGGREGATION", {
      aggregated_surface_frame_trace_ids: ["surface-1", "other"],
      display_trace_id: "display-1",
    }),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: "display-1" }, 20, 300),
  ];
  const result = collectCompositorSwapEvents(events, { targetId: "target" });
  assert.equal(result.selected.length, 1);
  assert.deepEqual(result.targetCorrelationSources, [
    "Graphics.Pipeline.STEP_SURFACE_AGGREGATION",
  ]);
});

test("already rounded numbers fail closed and never bind all GPU swaps", () => {
  const rounded = Number("-7549611329979386641");
  const events = [
    traceStart(),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: rounded },
      10,
    ),
    reporter(rounded, rounded),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: rounded }, 20, 300),
  ];
  const result = analyzeCompositorFps(events, { targetId: "target" });
  assert.equal(result.valid, false);
  assert.equal(result.eventCount, 0);
  assert.ok(
    result.invalidReasons.includes("compositor-surface-trace-id-missing"),
  );
});

test("partial and dropped frame reporters cannot certify a model frame", () => {
  const events = [
    traceStart(),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: "surface" },
      10,
    ),
    reporter("surface", "display", "STATE_PRESENTED_PARTIAL"),
    reporter("surface", "display", "STATE_DROPPED"),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: "display" }, 20, 300),
  ];
  assert.equal(
    collectCompositorSwapEvents(events, { targetId: "target" }).selected.length,
    0,
  );
});

test("OOPIF renderer descendants belong to target but sibling tabs do not", () => {
  const frames = [
    { frame: "target", processId: 10 },
    { frame: "child", parent: "target", processId: 11 },
    { frame: "grandchild", parent: "child", processId: 12 },
    { frame: "sibling", processId: 13 },
  ];
  assert.deepEqual(
    findTargetRendererProcesses([traceStart(frames)], "target"),
    [10, 11, 12],
  );
});

test("a sibling tab sharing the target renderer fails exact surface attribution closed", () => {
  const frames = [
    { frame: "target", processId: 10 },
    { frame: "sibling", processId: 10 },
  ];
  // These are the sibling's submitted and presented frames. Process-only
  // attribution cannot distinguish them from the idle requested target.
  const events = [
    traceStart(frames),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: "sibling-surface" },
      10,
    ),
    reporter("sibling-surface", "sibling-display"),
    pipeline(
      "STEP_DRAW_AND_SWAP",
      { display_trace_id: "sibling-display" },
      20,
      300,
    ),
  ];
  const collection = collectCompositorSwapEvents(events, {
    targetId: "target",
  });
  assert.equal(collection.binding, "ambiguous-renderer-pid");
  assert.equal(collection.selected.length, 0);
  const result = analyzeCompositorFps(events, { targetId: "target" });
  assert.equal(result.valid, false);
  assert.equal(result.eventCount, 0);
  assert.ok(
    result.invalidReasons.includes(
      "compositor-target-renderer-shared-with-unrelated-frame:10",
    ),
  );
});

test("unrelated documents sharing a descendant renderer invalidate the entire target sample", () => {
  const frames = [
    { frame: "target", processId: 10 },
    { frame: "child", parent: "target", processId: 11 },
    { frame: "sibling", processId: 13 },
    { frame: "sibling-child", parent: "sibling", processId: 11 },
  ];
  const events = [
    traceStart(frames),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: "root-surface" },
      10,
    ),
    reporter("root-surface", "root-display"),
    pipeline(
      "STEP_DRAW_AND_SWAP",
      { display_trace_id: "root-display" },
      20,
      300,
    ),
  ];
  const result = analyzeCompositorFps(events, { targetId: "target" });
  assert.equal(result.valid, false);
  assert.equal(result.eventCount, 0);
  assert.ok(
    result.invalidReasons.includes(
      "compositor-target-renderer-shared-with-unrelated-frame:11",
    ),
  );
});

test("same-process child frames and distinct OOPIF descendants retain target surface attribution", () => {
  const frames = [
    { frame: "target", processId: 10 },
    { frame: "child", parent: "target", processId: 10 },
    { frame: "oopif", parent: "child", processId: 11 },
    { frame: "grandchild", parent: "oopif", processId: 12 },
    { frame: "sibling", processId: 13 },
  ];
  const events = [traceStart(frames)];
  for (const [index, processId] of [10, 11, 12, 13].entries()) {
    const surface = `surface-${processId}`;
    const display = `display-${processId}`;
    events.push(
      pipeline(
        "STEP_SUBMIT_COMPOSITOR_FRAME",
        { surface_frame_trace_id: surface },
        processId,
      ),
      { ...reporter(surface, display), pid: processId },
      pipeline(
        "STEP_DRAW_AND_SWAP",
        { display_trace_id: display },
        20,
        300 + index * 16,
      ),
    );
  }
  const result = analyzeCompositorFps(events, { targetId: "target" });
  const frameTree = pageFrameTree("target", [
    { id: "child", children: ["oopif"] },
  ]);
  frameTree.frameTree.childFrames[0].childFrames[0].childFrames = [
    {
      frame: {
        id: "grandchild",
        parentId: "oopif",
        loaderId: "loader-grandchild",
      },
    },
  ];
  const boundResult = analyzeCompositorFps(events, {
    targetId: "target",
    frameBinding: buildTargetFrameBinding("target", frameTree, frameTree),
  });
  assert.equal(
    result.valid,
    false,
    "legacy target-only input remains unconfirmed",
  );
  assert.equal(boundResult.valid, true);
  assert.equal(result.eventCount, 3);
  assert.deepEqual(result.rendererProcessIds, [10, 11, 12]);
  assert.deepEqual(result.targetSurfaceTraceIds, [
    "surface-10",
    "surface-11",
    "surface-12",
  ]);
});

test("CDP target and root frame IDs are independent and explicit binding owns descendants", () => {
  const targetId = "1001253EE87F586A9F1F6FA8ED941D71";
  const rootFrameId = "82659358E0AFBB085C14BBF65B40AB65";
  const tree = pageFrameTree(rootFrameId, [{ id: "oopif" }]);
  const frameBinding = buildTargetFrameBinding(targetId, tree, tree);
  assert.equal(frameBinding.valid, true);
  const frames = [
    { frame: rootFrameId, processId: 17752 },
    { frame: "oopif", parent: rootFrameId, processId: 17800 },
    { frame: targetId, processId: 19999 },
  ];
  const events = [
    traceStart(frames),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: "owned" },
      17752,
    ),
    { ...reporter("owned", "display"), pid: 17752 },
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: "display" }, 20, 300),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: "display" }, 20, 316),
    {
      name: "TimeStamp",
      pid: 17752,
      ts: 250,
      args: { data: { message: "start" } },
    },
    {
      name: "TimeStamp",
      pid: 17752,
      ts: 350,
      args: { data: { message: "end" } },
    },
    {
      name: "FunctionCall",
      ph: "X",
      pid: 17752,
      ts: 270,
      dur: 60000,
      args: { data: { frame: rootFrameId, functionName: "owned" } },
    },
    {
      name: "FunctionCall",
      ph: "X",
      pid: 19999,
      ts: 280,
      dur: 90000,
      args: { data: { frame: targetId, functionName: "wrong-id" } },
    },
  ];
  const compositor = analyzeCompositorFps(events, { targetId, frameBinding });
  assert.equal(compositor.valid, true);
  assert.deepEqual(compositor.rendererProcessIds, [17752, 17800]);
  const window = findTraceWindow(events, {
    startLabel: "start",
    endLabel: "end",
    targetId,
    frameBinding,
  });
  assert.equal(window.applied, true);
  assert.equal(window.startUs, 250);
  const analyzed = analyzeTrace(
    { traceEvents: events },
    50,
    { applied: false },
    { valid: true, targetFrameBinding: frameBinding },
    targetId,
  );
  assert.equal(analyzed.targetDiagnostics.rootFrameId, rootFrameId);
  assert.equal(analyzed.targetDiagnostics.frameBinding.valid, true);
  assert.equal(analyzed.longTasks.count, 1);
  assert.equal(analyzed.longTasks.top[0].args.data.functionName, "owned");
  assert.ok(
    !analyzed.performanceKpi.invalidReasons.includes(
      "target-frame-binding-missing",
    ),
  );
});

test("legacy target-only reports retain an explicit assumption but fail qualified metrics closed", () => {
  const events = [
    traceStart(),
    pipeline(
      "STEP_SUBMIT_COMPOSITOR_FRAME",
      { surface_frame_trace_id: "surface" },
      10,
    ),
    reporter("surface", "display"),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: "display" }, 20, 300),
    pipeline("STEP_DRAW_AND_SWAP", { display_trace_id: "display" }, 20, 316),
  ];
  const result = analyzeCompositorFps(events, { targetId: "target" });
  assert.equal(result.valid, false);
  assert.equal(
    result.frameBinding.source,
    "legacy-unverified-target-id-assumption",
  );
  assert.ok(result.frameBinding.assumption.includes("diagnostic only"));
  assert.ok(result.invalidReasons.includes("target-frame-binding-missing"));
  const analyzed = analyzeTrace(
    { traceEvents: events },
    50,
    { applied: false },
    { valid: true, target: { id: "target" } },
    "target",
  );
  assert.equal(analyzed.performanceKpi.valid, false);
  assert.ok(
    analyzed.performanceKpi.invalidReasons.includes(
      "target-frame-binding-missing",
    ),
  );
});

test("frame and loader changes invalidate captured binding instead of guessing from identical URLs", () => {
  const before = pageFrameTree("root", [{ id: "child" }]);
  const variants = [
    pageFrameTree("replacement", [{ id: "child" }]),
    pageFrameTree("root"),
    pageFrameTree("root", [{ id: "replacement-child" }]),
    structuredClone(before),
  ];
  variants.at(-1).frameTree.frame.loaderId = "new-document-same-frame";
  for (const after of variants) {
    const binding = buildTargetFrameBinding("tab", before, after);
    assert.equal(binding.valid, false);
    assert.ok(binding.invalidReasons.length > 0);
    assert.equal(resolveTargetFrameBinding("tab", binding).rootFrameId, null);
  }
  const changedChild = structuredClone(before);
  changedChild.frameTree.childFrames[0].frame.loaderId = "new-child-document";
  assert.ok(
    buildTargetFrameBinding(
      "tab",
      before,
      changedChild,
    ).invalidReasons.includes("target-frame-document-changed:child"),
  );
});

test("Page API failure and forged target/root mappings cannot certify a trace", async () => {
  const failed = await readTargetFrameTree({
    send() {
      throw new Error("Page API failed");
    },
  });
  assert.equal(failed.error, "Page API failed");
  assert.equal(buildTargetFrameBinding("tab", failed, failed).valid, false);
  const tree = pageFrameTree("root");
  const valid = buildTargetFrameBinding("tab", tree, tree);
  assert.equal(resolveTargetFrameBinding("other-tab", valid).valid, false);
  assert.equal(
    resolveTargetFrameBinding("tab", { ...valid, rootFrameId: "forged" }).valid,
    false,
  );
  assert.equal(
    resolveTargetFrameBinding("tab", { ...valid, source: "url-match" }).valid,
    false,
  );
  const result = analyzeCompositorFps(
    [traceStart([{ frame: "root", processId: 10 }])],
    {
      targetId: "tab",
      frameBinding: buildTargetFrameBinding(
        "tab",
        pageFrameTree("root", [{ id: "unreported-child" }]),
        pageFrameTree("root", [{ id: "unreported-child" }]),
      ),
    },
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.invalidReasons.includes(
      "captured-frame-missing-from-trace:unreported-child",
    ),
  );
});

test("generic production capture writes Page.getFrameTree mapping on the exact target sidecar", async () => {
  const source = fs.readFileSync(
    new URL("./capture-trace.mjs", import.meta.url),
    "utf8",
  );
  const mainSource = source.slice(
    source.indexOf("async function main()"),
    source.indexOf("\nif (", source.indexOf("async function main()")),
  );
  const target = {
    id: "tab-id",
    webSocketDebuggerUrl: "ws://exact-tab",
    title: "page",
    url: "https://same.example/",
  };
  const frameTree = pageFrameTree("different-root", [{ id: "child" }]);
  const events = [
    traceStart([
      { frame: "different-root", processId: 10 },
      { frame: "child", parent: "different-root", processId: 11 },
    ]),
  ];
  const methods = [];
  const handlers = new Map();
  const writes = new Map();
  let complete;
  let closed = false;
  const session = {
    onEvent(method, handler) {
      handlers.set(method, handler);
    },
    waitForEvent() {
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    async send(method) {
      methods.push(method);
      if (method === "Page.getFrameTree") return structuredClone(frameTree);
      if (method === "Tracing.start")
        handlers.get("Tracing.bufferUsage")({ percentFull: 0.1 });
      if (method === "Tracing.end")
        complete({ stream: "handle", dataLossOccurred: false });
      if (method === "IO.read")
        return { data: JSON.stringify({ traceEvents: events }), eof: true };
      return {};
    },
    close() {
      closed = true;
    },
  };
  const mockFs = {
    async mkdir() {},
    async writeFile(output, text) {
      writes.set(output, text);
    },
  };
  const mockPath = { resolve: (value) => value, dirname: () => "evidence" };
  const mockProcess = { argv: ["node", "capture"], stdout: { write() {} } };
  const main = new Function(
    "parseArgs",
    "integerOption",
    "selectTarget",
    "connect",
    "evaluatePage",
    "acquireTraceLock",
    "readTargetFrameTree",
    "buildTargetFrameBinding",
    "readTraceStream",
    "parseTraceJson",
    "buildCaptureTraceEvidence",
    "fs",
    "path",
    "process",
    "DEFAULT_DURATION_MS",
    "DEFAULT_TIMEOUT_MS",
    "DEFAULT_CATEGORIES",
    "setTimeout",
    "clearTimeout",
    `${mainSource}; return main;`,
  )(
    () => ({ output: "trace.json" }),
    (_options, _key, fallback) => fallback,
    async () => ({ target, host: "127.0.0.1", port: 9333 }),
    async (url) => {
      assert.equal(url, target.webSocketDebuggerUrl);
      return session;
    },
    async () => ({ visibilityState: "visible" }),
    async () => ({ async release() {} }),
    readTargetFrameTree,
    buildTargetFrameBinding,
    async (activeSession) => {
      const response = await activeSession.send("IO.read");
      await activeSession.send("IO.close");
      return response.data;
    },
    parseTraceJson,
    buildCaptureTraceEvidence,
    mockFs,
    mockPath,
    mockProcess,
    0,
    1000,
    [],
    (callback, delay) => setTimeout(callback, delay === 1000 ? 1000 : 0),
    clearTimeout,
  );
  await main();
  const sidecar = JSON.parse(writes.get("trace.json.capture.json"));
  assert.equal(sidecar.valid, true);
  assert.equal(sidecar.target.id, "tab-id");
  assert.equal(sidecar.target.rootFrameId, "different-root");
  assert.equal(sidecar.targetFrameBinding.source, "Page.getFrameTree");
  assert.deepEqual(sidecar.targetFrameBinding.frameIds, [
    "different-root",
    "child",
  ]);
  assert.equal(
    resolveTargetFrameBinding("tab-id", sidecar.targetFrameBinding).valid,
    true,
  );
  assert.deepEqual(methods, [
    "Page.getFrameTree",
    "Tracing.start",
    "Tracing.end",
    "Page.getFrameTree",
    "IO.read",
    "IO.close",
  ]);
  assert.equal(closed, true);
});

test("wheel production WebSocket preserves dataCollected IDs before fallback serialization", async () => {
  const source = fs.readFileSync(
    new URL("./wheel-benchmark.mjs", import.meta.url),
    "utf8",
  );
  const connectSource = source.slice(
    source.indexOf("function connect("),
    source.indexOf("async function evaluate(session,"),
  );
  class MockSocket {
    static instance;
    listeners = new Map();
    constructor() {
      MockSocket.instance = this;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) ?? [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    }
    emit(name, event) {
      for (const callback of this.listeners.get(name) ?? []) callback(event);
    }
    close() {
      this.emit("close", {});
    }
  }
  const connect = new Function(
    "WebSocket",
    "parseTraceJson",
    `${connectSource}; return connect;`,
  )(MockSocket, parseTraceJson);
  const session = await connect("ws://mock", 1000);
  try {
    let collected;
    session.onEvent("Tracing.dataCollected", (params) => {
      collected = params.value;
    });
    MockSocket.instance.emit("message", {
      data: '{"method":"Tracing.dataCollected","params":{"value":[{"args":{"chrome_graphics_pipeline":{"surface_frame_trace_id":-7549611329979386641,"display_trace_id":-7549611329979386642}}}]}}',
    });
    assert.equal(
      collected[0].args.chrome_graphics_pipeline.surface_frame_trace_id,
      "-7549611329979386641",
    );
    assert.equal(
      collected[0].args.chrome_graphics_pipeline.display_trace_id,
      "-7549611329979386642",
    );
    const fallback = parseTraceJson(JSON.stringify({ traceEvents: collected }));
    assert.deepEqual(fallback.traceEvents, collected);
  } finally {
    session.close();
  }
});

test("CPU diagnostics filter explicit unrelated frames and GPU work requires an owner", () => {
  const frames = [
    { frame: "target", processId: 10 },
    { frame: "sibling", processId: 10 },
  ];
  const events = [
    traceStart(frames),
    {
      name: "FunctionCall",
      ph: "X",
      pid: 10,
      tid: 1,
      ts: 200,
      dur: 60000,
      args: { data: { frame: "target", functionName: "owned" } },
    },
    {
      name: "FunctionCall",
      ph: "X",
      pid: 10,
      tid: 1,
      ts: 300,
      dur: 90000,
      args: { data: { frame: "sibling", functionName: "other" } },
    },
    {
      name: "GPUTask",
      ph: "X",
      pid: 20,
      tid: 2,
      ts: 400,
      dur: 1000,
      args: { data: { renderer_pid: 10 } },
    },
    {
      name: "GPUTask",
      ph: "X",
      pid: 20,
      tid: 2,
      ts: 500,
      dur: 1000,
      args: { data: { renderer_pid: 13 } },
    },
    {
      name: "SwapBuffers",
      ph: "X",
      pid: 20,
      tid: 2,
      ts: 600,
      dur: 1000,
      args: {},
    },
  ];
  const result = analyzeTrace(
    { traceEvents: events },
    50,
    { applied: false },
    null,
    "target",
  );
  assert.equal(result.longTasks.count, 1);
  assert.equal(result.longTasks.top[0].args.data.functionName, "owned");
  assert.equal(result.evidence.gpu.eventCount, 1);
  assert.equal(result.targetDiagnostics.unassignedGpuEventCount, 2);
  assert.equal(result.performanceKpi.valid, false);
});

test("capture sidecar requires explicit no-loss and observed buffer capacity", () => {
  const trace = { traceEvents: [traceStart()] };
  const usage = [{ percentFull: 0.1 }];
  const good = buildCaptureTraceEvidence(
    trace,
    { dataLossOccurred: false },
    usage,
  );
  assert.equal(good.completeness.valid, true);
  assert.equal(good.bufferUsage.maximumPercentFull, 0.1);
  assert.equal(
    buildCaptureTraceEvidence(trace, {}, usage).completeness.valid,
    false,
  );
  assert.equal(
    buildCaptureTraceEvidence(trace, { dataLossOccurred: true }, usage)
      .completeness.valid,
    false,
  );
  assert.equal(
    buildCaptureTraceEvidence(trace, { dataLossOccurred: false }, [])
      .completeness.valid,
    false,
  );
  assert.equal(
    buildCaptureTraceEvidence(trace, { dataLossOccurred: false }, [
      { percentFull: 1 },
    ]).completeness.valid,
    false,
  );
});
