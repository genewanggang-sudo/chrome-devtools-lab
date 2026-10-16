import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativePerformanceRun } from "./native-performance-run.mjs";
import { NativePerformancePanel } from "./performance-panel.mjs";
import { main } from "./performance.mjs";

const config = { targetId: "A".repeat(32), outputDir: "new-native-evidence", stopWhen: "window.ready === true" };

test("native workflow rejects unsafe contracts before recording", () => {
    for (const invalid of [
        { targetId: "unknown" }, { host: "0.0.0.0" }, { stopWhen: "" },
        { stopWhen: "bad syntax !" }, { initScript: "function(" },
        { pollMs: 0 }, { maxDurationMs: 0 }, { stableMs: -1 }, { undock: "yes" },
        { analysisQueries: [{ name: "../escape" }] },
        { analysisQueries: [{ name: "one", output: "existing.json" }] },
        { analysisQueries: [{ name: "same" }, { name: "same" }] },
        { unexpected: true },
        { analysisQueries: [{ name: "loading", typo: true }] },
    ]) assert.throws(() => NativePerformanceRun.validate({ ...config, ...invalid }));
});

test("native CLI rejects unknown options before touching Chrome or output", async () => {
    await assert.rejects(main(["native-record", "--unexpected"]), /Unknown native-record option/);
    await assert.rejects(main(["analyze-current", "--output-dir", "unused-evidence", "--unexpected"]), /Unknown analyze-current option/);
});

test("native summaries are saved before full archive and all queries reuse Chrome's parse", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-native-run-"));
    const run = new NativePerformanceRun({ ...config, outputDir: directory, analysisQueries: [{ name: "loading" }, { name: "graphics" }] });
    run.state = { valid: true, invalidReasons: [], queries: [], timings: run.timings };
    const calls = [];
    const session = {
        timings: { parseCount: 0, reusedNativeParse: true },
        query: async options => {
            calls.push(`query:${options.name}`);
            const report = { threads: [], network: { requests: [], webSockets: [] }, insights: { sets: [] },
                integrity: {}, marks: [], gc: { events: [], threadTimeMs: [] }, screenshots: { count: 0 },
                artifacts: { report: options.output }, window: { startMs: 0, endMs: 50 },
                processing: { parseCount: 0, reusedNativeParse: true } };
            await fs.writeFile(options.output, JSON.stringify(report));
            return report;
        },
        archive: async capture => {
            calls.push("archiveReports");
            assert.equal(capture.valid, true);
        },
        close: async () => { calls.push("close"); },
    };
    run.openAnalysis = async () => session;
    const panel = { exportTrace: async output => {
        calls.push("export");
        const saved = JSON.parse(await fs.readFile(path.join(directory, "run.json"), "utf8"));
        assert.equal(saved.queries.length, 2);
        assert.ok(saved.timings.firstSummaryMs >= 0);
        assert.equal(saved.queries[0].processing.parseCount, 0);
        assert.equal(saved.queries[0].processing.reusedNativeParse, true);
        return { output, capturePath: `${output}.capture.json`, bytes: 10, sha256: "fixture" };
    } };
    try {
        await run.analyzeRecording(panel, performance.now());
        assert.deepEqual(calls, ["query:loading", "query:graphics", "export", "archiveReports", "close"]);
        assert.equal(run.state.analysisTimings.parseCount, 0);
        assert.equal(run.timings.parse, undefined);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("failed native query still archives raw evidence and releases its session", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-native-error-"));
    const run = new NativePerformanceRun({ ...config, outputDir: directory });
    run.state = { valid: true, invalidReasons: [], queries: [], timings: run.timings };
    const calls = [];
    run.openAnalysis = async () => ({ timings: {}, query: async () => { throw new Error("unsupported native query"); },
        archive: async () => { calls.push("archiveReports"); }, close: async () => { calls.push("close"); } });
    const panel = { exportTrace: async output => {
        calls.push("export");
        return { output, capturePath: `${output}.capture.json` };
    } };
    try {
        await assert.rejects(run.analyzeRecording(panel, performance.now()), /unsupported native query/);
        assert.deepEqual(calls, ["export", "archiveReports", "close"]);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("native session is released when raw export fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-native-export-error-"));
    const run = new NativePerformanceRun({ ...config, outputDir: directory });
    run.state = { valid: true, invalidReasons: [], queries: [], timings: run.timings };
    let closed = false;
    run.openAnalysis = async () => ({ timings: {}, query: async () => { throw new Error("query failed"); },
        close: async () => { closed = true; } });
    try {
        await assert.rejects(run.analyzeRecording({ exportTrace: async () => { throw new Error("export failed"); } }, performance.now()), error => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors.map(entry => entry.message), ["query failed", "export failed"]);
            return true;
        });
        assert.equal(closed, true);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("native readiness excludes an already ready previous document", async () => {
    const run = new NativePerformanceRun({ ...config, pollMs: 50, stableMs: 0 });
    const values = [
        { origin: 1000, ready: true, now: 5000 },
        { origin: 2000, ready: false, now: 5 },
        { origin: 2000, ready: true, now: 250 },
    ];
    let calls = 0;
    run.page = { send: async () => ({ result: { value: values[calls++] } }) };
    assert.equal((await run.waitReady(1000)).now, 250);
    assert.equal(calls, 3);
});

test("native readiness times out and propagates broken application expressions", async () => {
    const run = new NativePerformanceRun({ ...config, maxDurationMs: 100, pollMs: 50 });
    run.page = { send: async () => ({ result: { value: { origin: 2000, ready: false } } }) };
    await assert.rejects(run.waitReady(1000), /timed out/);
    run.page.send = async () => ({ exceptionDetails: { text: "ReferenceError: missing probe" } });
    await assert.rejects(run.waitReady(1000), /missing probe/);
});

test("viewport changes invalidate diagnostic comparison", () => {
    const before = { width: 1200, height: 900, dpr: 1.25 };
    assert.equal(NativePerformanceRun.sameViewport(before, { ...before }), true);
    assert.equal(NativePerformanceRun.sameViewport(before, { ...before, width: 320 }), false);
    assert.equal(NativePerformanceRun.sameViewport(before, { ...before, dpr: 1 }), false);
});

test("native export batches preserve every byte including Unicode and empty chunks", () => {
    const chunks = ["", "{", '"label":"大装配😀",', '"events":[]', "}"];
    const iterator = chunks.values();
    const batches = [];
    let calls = 0, chunkCount = 0;
    while (true) {
        // Execute exactly the function text sent over CDP against the iterator.
        const read = Function(`return (${NativePerformancePanel.exportBatch.toString()})`)();
        const batch = read.call(iterator, 12);
        calls++;
        chunkCount += batch.chunkCount;
        batches.push(batch.value);
        if (batch.done) break;
    }
    assert.deepEqual(Buffer.from(batches.join("")), Buffer.from(chunks.join("")));
    assert.equal(chunkCount, chunks.length);
    assert.ok(calls < chunks.length);
});
