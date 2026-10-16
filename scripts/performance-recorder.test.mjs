import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRecording,
  performanceCategories,
  PerformanceRecorder,
} from "./performance-recorder.mjs";
import { PerformanceSession } from "./performance-session.mjs";

const valid = { targetId: "EXACT", outputDir: "out/new" };
test("manual recording uses native diagnostic categories and an exact target", () => {
  const config = validateRecording(valid);
  assert.equal(config.action, "none");
  assert.equal(config.cache, "existing");
  assert.equal(config.screenshots, true);
  const categories = performanceCategories(true);
  assert.ok(categories.some((x) => x.includes("cpu_profiler")));
  assert.ok(categories.some((x) => x.includes("screenshot")));
  assert.ok(categories.includes("loading"));
  assert.equal(
    performanceCategories(false).some((x) => x.includes("screenshot")),
    false,
  );
});
test("invalid recording contracts fail before touching Chrome", () => {
  for (const invalid of [
    { targetId: null },
    { host: "0.0.0.0" },
    { port: 0 },
    { action: "navigate" },
    { cache: "cold" },
    { screenshots: "yes" },
    { durationMs: -1 },
    { maxDurationMs: 0 },
    { stopWhen: true },
    { milestones: [{ name: "ready" }] },
  ]) {
    assert.throws(() => validateRecording({ ...valid, ...invalid }));
  }
});
test("load conditions are explicit and bounded, duplicate milestones rejected", () => {
  const config = validateRecording({
    ...valid,
    action: "reload",
    stopWhen: "window.ready === true",
    stableMs: 750,
    maxDurationMs: 60000,
    milestones: [
      { name: "first-model", expression: "window.firstDraw === true" },
    ],
  });
  assert.equal(config.action, "reload");
  assert.equal(config.stableMs, 750);
  assert.throws(() =>
    validateRecording({
      ...valid,
      milestones: [
        { name: "same", expression: "true" },
        { name: "same", expression: "false" },
      ],
    }),
  );
});

test("reload readiness excludes the old document and resets stability on a new document", async () => {
  const recorder = new PerformanceRecorder({
    ...valid,
    action: "reload",
    stopWhen: "window.ready",
    stableMs: 100,
    pollMs: 100,
  });
  recorder.environment = { timeOrigin: 1000 };
  const origins = [1000, 2000, 3000, 3000];
  let evaluations = 0;
  recorder.connection = {
    evaluate: async () => ({
      ready: true,
      milestones: [],
      now: 10,
      origin: origins[evaluations++] ?? 3000,
    }),
  };
  await recorder.poll();
  assert.equal(evaluations, 4);
  assert.equal(recorder.stopReason, "condition");
});

test("commands fail immediately when the CDP socket is not open", async () => {
  const session = new PerformanceSession(60000);
  await assert.rejects(session.send("Tracing.end"), /not open/);
});
