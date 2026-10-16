import assert from "node:assert/strict";
import test from "node:test";
import { NativePerformancePanel } from "./performance-panel.mjs";

const measure = (name, startTime, duration) => ({ name, startTime, duration });

test("native stop metrics separate engine phases from nested insight costs", () => {
  const result = NativePerformancePanel.summarizeProcessingMeasures({
    since: 100,
    observedAt: 500,
    measures: [
      measure("TraceLoad", 10, 50),
      measure("TraceLoad", 110, 350),
      measure("total", 140, 300),
      measure("parse", 140, 100),
      measure("insights", 240, 200),
      measure("insights:createLanternContext", 250, 150),
      measure("parse:Renderer:finalize", 170, 30),
      measure("unrelated-app-measure", 120, 370),
    ],
  });
  assert.equal(result.status, "complete");
  assert.equal(result.traceLoadMs, 350);
  assert.equal(result.engineTotalMs, 300);
  assert.deepEqual(result.nonOverlappingPhases.map(({ name, durationMs }) => ({ name, durationMs })), [
    { name: "beforeEngine", durationMs: 30 },
    { name: "engineParse", durationMs: 100 },
    { name: "engineInsights", durationMs: 200 },
    { name: "afterEngine", durationMs: 20 },
  ]);
  assert.equal(result.unassignedTraceLoadMs, 0);
  assert.deepEqual(result.nestedHotspots, [
    { name: "insights:createLanternContext", durationMs: 150 },
    { name: "parse:Renderer:finalize", durationMs: 30 },
  ]);
  assert.match(result.interpretation, /must not be added/);
});

test("deferred or missing native measurements remain partial without reusing an old trace", () => {
  const result = NativePerformancePanel.summarizeProcessingMeasures({
    since: 100,
    observedAt: 400,
    measures: [
      measure("TraceLoad", 10, 80),
      measure("total", 140, 250),
      measure("parse", 140, 100),
      measure("insights", 240, 150),
    ],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.traceLoadMs, null);
  assert.equal(result.engineTotalMs, 250);
  assert.deepEqual(result.nonOverlappingPhases.map(entry => entry.name), ["engineParse", "engineInsights"]);
  assert.equal(result.unassignedTraceLoadMs, null);
});

test("incompatible or overlapping native phase measurements are not presented as additive", () => {
  const result = NativePerformancePanel.summarizeProcessingMeasures({
    since: 100,
    observedAt: 500,
    measures: [
      measure("TraceLoad", 110, 350),
      measure("total", 140, 300),
      measure("parse", 140, 170),
      measure("insights", 240, 200),
      measure("parse:invalid", 200, -10),
      measure("insights:future", 450, 100),
    ],
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.nonOverlappingPhases, []);
  assert.equal(result.unassignedTraceLoadMs, null);
  assert.deepEqual(result.nestedHotspots, []);
});

test("native stop succeeds when optional frontend metrics cannot be read", async () => {
  const panel = new NativePerformancePanel({ targetId: "0".repeat(32) });
  let inspections = 0;
  let clicked = 0;
  panel.inspect = async () => ++inspections === 1
    ? { bound: true, state: "Recording", active: null }
    : { bound: true, state: "Idle", active: { index: 1 } };
  panel.evaluate = async () => 100;
  panel.clickToolbar = async action => {
    assert.equal(action, "record");
    clicked++;
    return { label: "Stop" };
  };
  panel.processingMeasures = async () => { throw new Error("Unsupported frontend measures"); };
  const result = await panel.stop();
  assert.equal(clicked, 1);
  assert.equal(result.state, "Idle");
  assert.deepEqual(result.active, { index: 1 });
  assert.deepEqual(result.nativeProcessing, { status: "unavailable", reason: "Unsupported frontend measures" });
  assert.ok(result.timings.nativeProcessingWaitMs >= 0);
  assert.ok(result.timings.readNativeMeasuresMs >= 0);
});
