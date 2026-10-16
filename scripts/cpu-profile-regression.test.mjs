import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  aggregate,
  buildFlamegraphData,
  buildSpeedscope,
} from "./analyze-cpu-profile.mjs";
import {
  DEFAULT_SAMPLING_INTERVAL_US,
  summarizeCoverage,
} from "./capture-cpu-profile.mjs";

function node(id, functionName, children = [], overrides = {}) {
  return {
    id,
    callFrame: {
      functionName,
      url: "https://test.invalid/app.js",
      lineNumber: functionName === "recurse" ? 10 : id,
      columnNumber: 0,
    },
    children,
    ...overrides,
  };
}

function recursiveProfile() {
  return {
    nodes: [
      node(1, "(root)", [2]),
      node(2, "recurse", [3]),
      node(3, "recurse", [4]),
      node(4, "leaf"),
    ],
    samples: [2, 3, 4],
    timeDeltas: [1000, 2000, 3000],
    startTime: 100000,
    endTime: 106000,
  };
}

test("recursive logical function total is the sampled-stack union", () => {
  const result = aggregate(recursiveProfile());
  const recurse = result.expensiveFunctions.find(
    (entry) => entry.functionName === "recurse",
  );
  assert.equal(recurse.selfUs, 3000);
  assert.equal(recurse.totalUs, 6000);
  assert.equal(recurse.nodeCount, 2);
  assert.equal(result.totalUs.get(2), 6000);
  assert.equal(result.totalUs.get(3), 5000);
  assert.equal(result.totalProfiledUs, 6000);
  assert.equal(result.quality.coverageRatio, 1);
  assert.deepEqual(result.toFunctionRow(recurse), {
    functionName: "recurse",
    url: "https://test.invalid/app.js",
    line: 11,
    column: 1,
    selfMs: 3,
    totalMs: 6,
    selfPercent: 50,
    nodeCount: 2,
  });
});

test("mutual recursion and separate call sites count once per logical stack", () => {
  const first = node(2, "A", [3]);
  const again = { ...node(4, "A"), callFrame: first.callFrame };
  const separate = { ...node(5, "A"), callFrame: first.callFrame };
  const profile = {
    nodes: [
      node(1, "(root)", [2, 5]),
      first,
      node(3, "B", [4]),
      again,
      separate,
    ],
    samples: [4, 5],
    timeDeltas: [3000, 2000],
    startTime: 0,
    endTime: 5000,
  };
  const result = aggregate(profile);
  assert.equal(
    result.expensiveFunctions.find((entry) => entry.functionName === "A")
      .totalUs,
    5000,
  );
  assert.equal(
    result.expensiveFunctions.find((entry) => entry.functionName === "B")
      .totalUs,
    3000,
  );
});

test("speedscope preserves chronological samples and recursive call-tree frames", () => {
  const profile = recursiveProfile();
  const result = aggregate(profile);
  const speedscope = buildSpeedscope(profile, result, "test");
  assert.equal(speedscope.profiles[0].unit, "microseconds");
  assert.deepEqual(speedscope.profiles[0].weights, [1000, 2000, 3000]);
  assert.deepEqual(speedscope.profiles[0].samples[1], [0, 1, 1]);
  const graph = buildFlamegraphData(profile, result);
  assert.equal(graph.unit, "ms");
  assert.equal(graph.totalMs, 6);
  assert.equal(graph.rects.filter((entry) => entry.n === "recurse").length, 2);
});

test("hitCount-only profiles report counts without invented elapsed time", () => {
  const profile = {
    nodes: [node(1, "(root)", [2]), node(2, "work", [], { hitCount: 12 })],
    startTime: 0,
    endTime: 12000,
  };
  const result = aggregate(profile);
  const row = result.toFunctionRow(result.hotFunctions[0]);
  assert.equal(result.attribution, "hitCount");
  assert.equal(result.timed, false);
  assert.equal(row.selfMs, null);
  assert.equal(row.totalMs, null);
  assert.equal(row.selfCount, 12);
  assert.equal(row.totalCount, 12);
  assert.equal(result.quality.timingAvailable, false);
  const speedscope = buildSpeedscope(profile, result, "test").profiles[0];
  assert.equal(speedscope.unit, "none");
  assert.equal(speedscope.endValue, 12);
  assert.deepEqual(speedscope.weights, [12]);
  assert.match(speedscope.name, /unordered hit counts/);
  const graph = buildFlamegraphData(profile, result);
  assert.equal(graph.totalMs, null);
  assert.equal(graph.totalCount, 12);
  assert.equal(graph.unit, "count");
});

test("samples without deltas retain sample counts and order, not milliseconds", () => {
  const profile = recursiveProfile();
  delete profile.timeDeltas;
  const result = aggregate(profile);
  assert.equal(result.attribution, "sampleCount");
  assert.equal(result.totalProfiledUs, 3);
  assert.equal(result.toFunctionRow(result.hotFunctions[0]).selfMs, null);
  assert.deepEqual(
    buildSpeedscope(profile, result, "test").profiles[0].weights,
    [1, 1, 1],
  );
});

test("incomplete or invalid sample timing fails instead of becoming zero time", () => {
  for (const deltas of [
    [1000],
    [1000, -1001, 3000],
    [1000, null, 3000],
    [1000, "2", 3000],
    [1000, NaN, 3000],
  ]) {
    assert.throws(
      () => aggregate({ ...recursiveProfile(), timeDeltas: deltas }),
      /timeDeltas|timing/,
    );
  }
  assert.throws(
    () => aggregate({ ...recursiveProfile(), samples: [2, 999, 4] }),
    /unknown node/,
  );
});

test("out-of-order samples use DevTools-style timestamp sorting, not zero-clamping", () => {
  const profile = { ...recursiveProfile(), timeDeltas: [1000, -8, 3000] };
  const raw = JSON.stringify(profile);
  const result = aggregate(profile);
  assert.deepEqual(result.samples, [3, 2, 4]);
  assert.deepEqual(result.timeDeltas, [992, 8, 2992]);
  assert.equal(result.totalProfiledUs, 3992);
  assert.equal(result.quality.negativeDeltaCount, 1);
  assert.equal(result.quality.reorderedSampleCount, 2);
  assert.match(
    result.quality.warnings.join(" "),
    /sorting cumulative timestamps/,
  );
  assert.equal(
    JSON.stringify(profile),
    raw,
    "normalization must not mutate the raw profile",
  );
});

test("invalid node trees fail without hanging the analyzer", () => {
  const base = { samples: [1], timeDeltas: [1000] };
  assert.throws(
    () => aggregate({ ...base, nodes: [node(1, "one", [1])] }),
    /cycle/,
  );
  assert.throws(
    () => aggregate({ ...base, nodes: [node(1, "one", [99])] }),
    /unknown child/,
  );
  assert.throws(
    () =>
      aggregate({
        ...base,
        nodes: [node(1, "one", [3]), node(2, "two", [3]), node(3, "three")],
      }),
    /multiple parent/,
  );
  assert.throws(
    () => aggregate({ ...base, nodes: [node(1, "one"), node(1, "duplicate")] }),
    /duplicate node/,
  );
});

test("large gaps and incomplete capture-window coverage are disclosed", () => {
  const result = aggregate({
    nodes: [node(1, "work")],
    samples: [1, 1, 1],
    timeDeltas: [1000, 1000, 100000],
    startTime: 0,
    endTime: 200000,
  });
  assert.equal(result.quality.largeGapCount, 1);
  assert.equal(result.quality.largeGapTimeMs, 100);
  assert.equal(result.quality.coverageRatio, 0.51);
  assert.match(result.quality.warnings.join(" "), /coverage/);
  assert.match(result.quality.warnings.join(" "), /not proof/);
});

test("coverage inline document coordinates add startLine exactly once", async () => {
  const source = "function work() {\n  return 1;\n}\n";
  const session = { send: async () => ({ scriptSource: source }) };
  const result = await summarizeCoverage(
    session,
    [
      {
        scriptId: "s1",
        url: "https://test.invalid/",
        functions: [
          {
            functionName: "work",
            ranges: [{ startOffset: 0, endOffset: source.length, count: 3 }],
          },
        ],
      },
    ],
    25,
    new Map([["s1", { startLine: 20 }]]),
  );
  const fn = result[0].functions[0];
  assert.equal(fn.scriptLine, 1);
  assert.equal(fn.line, 21);
  assert.equal(fn.documentLine, 21);
  assert.equal(result[0].hotLinesByCount[1].scriptLine, 2);
  assert.equal(result[0].hotLinesByCount[1].line, 22);
});

test("CPU capture defaults to a 1ms interval", () => {
  assert.equal(DEFAULT_SAMPLING_INTERVAL_US, 1000);
});

test("CLI keeps standard outputs and discloses count-only attribution", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cpu-profile-regression-"),
  );
  const input = path.join(directory, "fixture.cpuprofile");
  const output = path.join(directory, "summary.json");
  const speedscope = path.join(directory, "speedscope.json");
  const flamegraph = path.join(directory, "flame.html");
  await fs.writeFile(
    input,
    JSON.stringify({ nodes: [node(1, "work", [], { hitCount: 6 })] }),
  );
  const processResult = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./analyze-cpu-profile.mjs", import.meta.url)),
      "--input",
      input,
      "--output",
      output,
      "--speedscope",
      speedscope,
      "--flamegraph",
      flamegraph,
    ],
    { encoding: "utf8" },
  );
  assert.equal(processResult.status, 0, processResult.stderr);
  const summary = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(summary.ok, true);
  assert.equal(summary.meta.profiledSelfTimeMs, null);
  assert.equal(summary.meta.unit, "count");
  assert.equal(summary.meta.profiledSampleCount, 6);
  assert.equal(summary.hotFunctions[0].selfCount, 6);
  assert.match(await fs.readFile(flamegraph, "utf8"), /Aggregate call tree/);
  assert.equal(
    JSON.parse(await fs.readFile(speedscope, "utf8")).profiles[0].unit,
    "none",
  );
});
