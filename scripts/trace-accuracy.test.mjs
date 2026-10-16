import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeTrace } from "./analyze-trace.mjs";
import {
  parseTraceJson,
  readTraceJsonFile,
  writeTraceStream,
} from "./trace-json.mjs";

function analyze(events, window = { applied: false }) {
  return analyzeTrace({ traceEvents: events }, 50, window, null, null);
}

function duration(name, ts, dur, { pid = 10, tid = 1, ...extra } = {}) {
  return { name, ph: "X", ts, dur, pid, tid, ...extra };
}

async function temporaryTrace(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chrome-trace-accuracy-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "trace.json");
}

test("one outer scheduler task does not multiply into nested JavaScript long tasks", () => {
  const result = analyze([
    duration("ThreadControllerImpl::RunTask", 100, 120000, { cat: "toplevel" }),
    duration("FunctionCall", 200, 100000),
    duration("EventDispatch", 300, 90000),
    duration("EvaluateScript", 400, 80000),
    duration("ThreadControllerImpl::RunTask", 130000, 40000, {
      cat: "toplevel",
    }),
  ]);
  assert.equal(result.longTasks.count, 1);
  assert.equal(result.longTasks.topLevelTaskCount, 1);
  assert.equal(result.longTasks.selectedDurationMs, 120);
  assert.equal(result.longTasks.top[0].name, "ThreadControllerImpl::RunTask");
});

test("outermost tasks are selected independently by both process and thread", () => {
  const result = analyze([
    duration("RunTask", 100, 100000),
    duration("FunctionCall", 200, 90000),
    duration("RunTask", 100, 110000, { tid: 2 }),
    duration("FunctionCall", 200, 90000, { tid: 2 }),
    duration("RunTask", 100, 120000, { pid: 20 }),
  ]);
  assert.equal(result.longTasks.count, 3);
  assert.equal(result.longTasks.selectedDurationMs, 330);
  assert.equal(result.longTasks.inferredRootCount, 0);
});

test("B/E nesting is converted per thread before selecting roots", () => {
  const result = analyze([
    { name: "RunTask", ph: "B", ts: 100, pid: 10, tid: 1 },
    { name: "EventDispatch", ph: "B", ts: 200, pid: 10, tid: 1 },
    duration("FunctionCall", 300, 70000),
    { ph: "E", ts: 80000, pid: 10, tid: 1 },
    { ph: "E", ts: 100100, pid: 10, tid: 1 },
    { ph: "E", ts: 100200, pid: 10, tid: 2 },
    { name: "FunctionCall", ph: "B", ts: 100300, pid: 10, tid: 2 },
  ]);
  assert.equal(result.longTasks.count, 1);
  assert.equal(result.longTasks.top[0].fullDurationMs, 100);
  assert.equal(result.longTasks.unmatchedBeginCount, 1);
  assert.equal(result.longTasks.unmatchedEndCount, 1);
});

test("standalone JavaScript is explicitly inferred and nested inferred roots count once", () => {
  const result = analyze([
    duration("FunctionCall", 100, 100000),
    duration("EvaluateScript", 200, 80000),
  ]);
  assert.equal(result.longTasks.count, 1);
  assert.equal(result.longTasks.inferredRootCount, 1);
  assert.equal(result.longTasks.topLevelTaskCount, 0);
  assert.equal(result.longTasks.top[0].source, "inferred-root-duration-event");
});

test("window crossing tasks retain full qualification and clip only overlapping time", () => {
  const result = analyze(
    [duration("RunTask", 100, 100000), duration("FunctionCall", 20000, 70000)],
    { applied: true, startUs: 40000, endUs: 60000 },
  );
  assert.equal(result.longTasks.top[0].name, "RunTask");
  assert.equal(result.longTasks.top[0].durationMs, 20);
  assert.equal(result.longTasks.top[0].fullDurationMs, 100);
  assert.equal(result.longTasks.top[0].timestampUs, 40000);
  assert.equal(result.longTasks.top[0].originalTimestampUs, 100);
  assert.equal(result.longTasks.top[0].clippedToWindow, true);
  assert.equal(result.traceCoverage.lastTimestampUs, 100100);
  assert.equal(result.analysisWindow.invalidReasons.length, 0);
  // Both intersecting slices are visible, but only the outer task counts.
  assert.equal(result.analysisEventCount, 2);
});

test("durations touching a selection boundary contribute zero and are excluded", () => {
  const result = analyze(
    [
      duration("RunTask", 100, 60000),
      duration("RunTask", 120100, 60000),
      { name: "TimeStamp", ph: "I", ts: 60100, pid: 10, tid: 1 },
    ],
    { applied: true, startUs: 60100, endUs: 120100 },
  );
  assert.equal(result.longTasks.count, 0);
  assert.equal(result.analysisEventCount, 1);
});

test("duplicate task slices are not double-counted and crossing roots are reported", () => {
  const result = analyze([
    duration("RunTask", 100, 100000),
    duration("RunTask", 100, 100000),
    duration("FunctionCall", 80000, 60000),
  ]);
  assert.equal(result.longTasks.count, 2);
  assert.equal(result.longTasks.overlappingRootCount, 1);
});

test("stream IO writes each raw chunk to disk before requesting the next", async (t) => {
  const output = await temporaryTrace(t);
  const chunks = [
    Buffer.from('{"traceEvents":['),
    Buffer.from('{"name":"加载"}'),
    Buffer.from("]}"),
  ];
  let next = 0;
  let closed = false;
  const session = {
    async send(method, params) {
      if (method === "IO.close") {
        closed = true;
        return {};
      }
      assert.equal(method, "IO.read");
      assert.equal(params.size, 64);
      assert.equal(
        (await fs.readFile(output)).toString(),
        Buffer.concat(chunks.slice(0, next)).toString(),
      );
      const chunk = chunks[next++];
      return {
        data: chunk.toString("base64"),
        base64Encoded: true,
        eof: next === chunks.length,
      };
    },
  };
  const result = await writeTraceStream(session, "handle", output, {
    chunkBytes: 64,
  });
  assert.equal(result.bytesWritten, Buffer.concat(chunks).length);
  assert.equal(result.chunkCount, 3);
  assert.equal(result.streamClosed, true);
  assert.equal(closed, true);
  assert.equal((await readTraceJsonFile(output)).traceEvents[0].name, "加载");
});

test("failed stream transfer retains the partial raw file and closes the Chrome handle", async (t) => {
  const output = await temporaryTrace(t);
  let next = 0;
  let closed = false;
  const session = {
    async send(method) {
      if (method === "IO.close") {
        closed = true;
        return {};
      }
      if (next++ === 0) return { data: '{"traceEvents":[', eof: false };
      throw new Error("mock transport failure");
    },
  };
  await assert.rejects(writeTraceStream(session, "handle", output), (error) => {
    assert.equal(error.traceOutput, output);
    assert.equal(error.bytesWritten, 16);
    return /mock transport failure/.test(error.message);
  });
  assert.equal(await fs.readFile(output, "utf8"), '{"traceEvents":[');
  assert.equal(closed, true);
});

test("full-memory analysis limit preserves a complete trace for Chrome import", async (t) => {
  const output = await temporaryTrace(t);
  const text = '{"traceEvents":[{"id":-7549611329979386641}]}';
  await writeTraceStream(
    {
      async send(method) {
        return method === "IO.read" ? { data: text, eof: true } : {};
      },
    },
    "handle",
    output,
  );
  await assert.rejects(
    readTraceJsonFile(output, { maxBytes: 10 }),
    (error) =>
      error.code === "TRACE_ANALYSIS_SIZE_LIMIT" &&
      /raw trace is preserved/.test(error.message),
  );
  assert.equal(await fs.readFile(output, "utf8"), text);
  assert.equal(
    (await readTraceJsonFile(output, { maxBytes: 1000 })).traceEvents[0].id,
    "-7549611329979386641",
  );
  assert.throws(() => parseTraceJson(text, { maxBytes: 10 }), {
    code: "TRACE_ANALYSIS_SIZE_LIMIT",
  });
});

test("capture never silently overwrites an existing raw recording", async (t) => {
  const output = await temporaryTrace(t);
  await fs.writeFile(output, "previous recording");
  const calls = [];
  await assert.rejects(
    writeTraceStream(
      {
        async send(method) {
          calls.push(method);
          return {};
        },
      },
      "handle",
      output,
    ),
    { code: "EEXIST" },
  );
  assert.equal(await fs.readFile(output, "utf8"), "previous recording");
  assert.deepEqual(calls, ["IO.close"]);
});
