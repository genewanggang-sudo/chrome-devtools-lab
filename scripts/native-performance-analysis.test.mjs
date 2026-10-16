import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativePerformanceTraceSession } from "./native-performance-analysis.mjs";

const targetId = "A".repeat(32);
const panelTargetId = "B".repeat(32);

function activeRecording() {
    return { index: 0, eventCount: 42, bounds: { min: 1000, max: 5000 }, mainFrameId: "main-frame" };
}

function reportFixture() {
    return {
        schemaVersion: 1, window: { startMs: 0, endMs: 4, durationMs: 4 }, scope: {},
        integrity: { rawEventCount: 42 }, coverage: {}, threads: [], marks: [],
        network: { requests: [], webSockets: [] }, gc: { events: [], threadTimeMs: [] },
        insights: { sets: [] }, nativeSummary: "Native summary",
    };
}

function fakePanel() {
    const calls = [];
    const state = { bound: true, state: "Idle", active: activeRecording() };
    const remote = {
        api: {
            resolvePerformanceWindow: (_trace, options) => options,
            NativePerformanceAnalysis: class {
                report() { return reportFixture(); }
            },
        },
        native: {}, trace: {}, reportJSON: null,
        assertSelected() { if (!this.selected) throw new Error("Selected native recording changed during analysis."); },
        selected: true,
    };
    const panel = {
        targetId, panelTargetId, version: { Browser: "Chrome/test" }, calls, state, remote,
        inspect: async () => state,
        panel: { send: async (method, params) => {
            calls.push({ method, params });
            if (method === "Runtime.evaluate") return { result: { objectId: "remote-session" } };
            if (method === "Runtime.releaseObjectGroup") return {};
            assert.equal(method, "Runtime.callFunctionOn");
            assert.equal(params.objectId, "remote-session");
            try {
                const operation = Function(`return (${params.functionDeclaration});`)();
                return { result: { value: operation.apply(remote, params.arguments.map(argument => argument.value)) } };
            } catch (error) {
                return { exceptionDetails: { exception: { description: error.message } } };
            }
        } },
    };
    return panel;
}

async function withDirectory(operation) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-lab-native-session-"));
    try { await operation(directory); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function writer(capture = {}) {
    const session = new NativePerformanceTraceSession();
    session.capture = capture;
    session.timings = { writeMs: 0 };
    return session;
}

test("native sessions refuse unbound, incomplete and mismatched targets before evaluating", async () => {
    for (const change of [{ bound: false }, { state: "Recording" }, { active: null }]) {
        const panel = fakePanel();
        Object.assign(panel.state, change);
        await assert.rejects(NativePerformanceTraceSession.open({ panel }), /completed recording/);
        assert.equal(panel.calls.length, 0);
    }
    const panel = fakePanel();
    await assert.rejects(NativePerformanceTraceSession.open({ panel, capture: { targetId: "other" } }), /does not match/);
    assert.equal(panel.calls.length, 0);
});

test("native initialization errors release their remote object group", async () => {
    const panel = fakePanel();
    const send = panel.panel.send;
    panel.panel.send = async (method, params) => method === "Runtime.evaluate"
        ? { exceptionDetails: { text: "Unsupported native frontend" } } : send(method, params);
    await assert.rejects(NativePerformanceTraceSession.open({ panel }), /Unsupported native frontend/);
    assert.equal(panel.calls.at(-1).method, "Runtime.releaseObjectGroup");
    assert.match(panel.calls.at(-1).params.objectGroup, /^chrome-lab-native-analysis-/);
});

test("native queries reject changed recording, detached target and closed handles", async () => {
    const panel = fakePanel();
    const session = await NativePerformanceTraceSession.open({ panel });
    try {
        await assert.rejects(session.query({ targetId: "other" }), /does not match/);
        await assert.rejects(session.query({ input: "another-trace.json" }), /selected recording/);
        panel.remote.selected = false;
        await assert.rejects(session.query(), /recording changed/);
        panel.remote.selected = true;
        panel.state.bound = false;
        await assert.rejects(session.query(), /no longer bound/);
        panel.state.bound = true;
    } finally { await session.close(); }
    await assert.rejects(session.call("function() {}"), /closed/);
    assert.equal(panel.calls.at(-1).method, "Runtime.releaseObjectGroup");
});

test("native query transfers Unicode in bounded chunks and keeps archive provenance pending", async () => {
    const panel = fakePanel();
    const summaryText = "大装配😀".repeat(300000);
    panel.remote.api.NativePerformanceAnalysis = class {
        report() { return { ...reportFixture(), nativeSummary: summaryText }; }
    };
    const session = await NativePerformanceTraceSession.open({ panel });
    try {
        const report = await session.query();
        assert.equal(report.nativeSummary, summaryText);
        assert.equal(report.processing.parseCount, 0);
        assert.equal(report.processing.reusedNativeParse, true);
        assert.equal(report.source.archiveStatus, "pending");
        assert.equal(report.source.originalPreserved, false);
        assert.equal(panel.remote.reportJSON, null);
        assert.ok(panel.calls.filter(call => call.params?.functionDeclaration?.includes("reportJSON.slice")).length > 1);
    } finally { await session.close(); }
});

test("native query and archive reject concurrency while a report transfer owns the session", async () => {
    const panel = fakePanel();
    const session = await NativePerformanceTraceSession.open({ panel });
    let releaseTransfer, transferStarted;
    const transferGate = new Promise(resolve => { releaseTransfer = resolve; });
    const enteredTransfer = new Promise(resolve => { transferStarted = resolve; });
    const send = panel.panel.send;
    panel.panel.send = async (method, params) => {
        const result = await send(method, params);
        if (params.functionDeclaration?.includes("reportJSON.slice")) {
            transferStarted();
            await transferGate;
        }
        return result;
    };
    try {
        const first = session.query();
        await enteredTransfer;
        await assert.rejects(session.query(), /sequentially/);
        await assert.rejects(session.archive({}), /sequentially/);
        assert.notEqual(panel.remote.reportJSON, null);
        releaseTransfer();
        assert.equal((await first).processing.queryIndex, 1);
        assert.equal(session.busy, false);
        assert.equal(panel.remote.reportJSON, null);
        assert.equal((await session.query()).processing.queryIndex, 2);
    } finally { releaseTransfer(); await session.close(); }
});

test("archive matching rejects target, panel, event and timing differences", () => {
    const before = { targetId, panelTargetId, active: activeRecording() };
    const matching = { ...before, status: "complete", active: structuredClone(before.active) };
    assert.doesNotThrow(() => NativePerformanceTraceSession.assertSameRecording(before, matching));
    for (const after of [
        { ...matching, status: "failed" }, { ...matching, targetId: "other" },
        { ...matching, panelTargetId: "other" },
        { ...matching, active: { ...matching.active, index: 1 } },
        { ...matching, active: { ...matching.active, eventCount: 43 } },
        { ...matching, active: { ...matching.active, bounds: { min: 999, max: 5000 } } },
        { ...matching, active: { ...matching.active, bounds: { min: 1000, max: 5001 } } },
    ]) assert.throws(() => NativePerformanceTraceSession.assertSameRecording(before, after), /does not match/);
});

test("native output conflicts leave both existing evidence and absent partners unchanged", async () =>
    withDirectory(async directory => {
        const session = writer();
        const output = path.join(directory, "report.json");
        const summary = path.join(directory, "summary.json");
        for (const existing of [output, summary]) {
            await fs.writeFile(existing, "existing evidence");
            await assert.rejects(session.write({ output, report: reportFixture(), overwrite: false }, true), { code: "EEXIST" });
            assert.equal(await fs.readFile(existing, "utf8"), "existing evidence");
            await assert.rejects(fs.stat(existing === output ? summary : output), { code: "ENOENT" });
            await fs.unlink(existing);
        }
    }));

test("reservation races remove a newly reserved report and preserve competing summary", async t =>
    withDirectory(async directory => {
        const output = path.join(directory, "report.json");
        const summary = path.join(directory, "summary.json");
        const originalOpen = fs.open;
        const mock = t.mock.method(fs, "open", async (file, flags, ...rest) => {
            if (file === summary && flags === "wx") await fs.writeFile(summary, "competing evidence");
            return originalOpen(file, flags, ...rest);
        });
        try {
            await assert.rejects(writer().write({ output, report: reportFixture(), overwrite: false }, true), { code: "EEXIST" });
            await assert.rejects(fs.stat(output), { code: "ENOENT" });
            assert.equal(await fs.readFile(summary, "utf8"), "competing evidence");
        } finally { mock.mock.restore(); }
    }));

test("failed overwrite reservation never truncates the first existing artifact", async t =>
    withDirectory(async directory => {
        const output = path.join(directory, "report.json");
        const summary = path.join(directory, "summary.json");
        await fs.writeFile(output, "previous report");
        await fs.writeFile(summary, "previous summary");
        const originalOpen = fs.open;
        const mock = t.mock.method(fs, "open", async (file, flags, ...rest) => {
            if (file === summary) throw Object.assign(new Error("Reservation denied"), { code: "EACCES" });
            return originalOpen(file, flags, ...rest);
        });
        try {
            await assert.rejects(writer().write({ output, report: reportFixture(), overwrite: true }, true), { code: "EACCES" });
            assert.equal(await fs.readFile(output, "utf8"), "previous report");
            assert.equal(await fs.readFile(summary, "utf8"), "previous summary");
        } finally { mock.mock.restore(); }
    }));

test("native outputs protect raw recordings and refuse non-file destinations", async () =>
    withDirectory(async directory => {
        const raw = path.join(directory, "trace.json");
        await fs.writeFile(raw, "original trace");
        await assert.rejects(writer({ output: raw }).write({ output: raw, report: reportFixture(), overwrite: true }, true), /original recording/);
        assert.equal(await fs.readFile(raw, "utf8"), "original trace");
        const output = path.join(directory, "report.json");
        const summary = path.join(directory, "summary.json");
        await fs.mkdir(summary);
        await assert.rejects(writer().write({ output, report: reportFixture(), overwrite: true }, true), /regular file/);
        await assert.rejects(fs.stat(output), { code: "ENOENT" });
    }));

test("native archive updates both report files only for the analyzed recording", async () =>
    withDirectory(async directory => {
        const panel = fakePanel();
        const session = await NativePerformanceTraceSession.open({ panel });
        try {
            const output = path.join(directory, "report.json");
            await session.query({ output });
            await session.archive({ status: "complete", targetId, panelTargetId, active: activeRecording(),
                output: path.join(directory, "trace.json"), bytes: 1234, sha256: "test-sha", valid: true });
            for (const file of [output, path.join(directory, "summary.json")]) {
                const report = JSON.parse(await fs.readFile(file, "utf8"));
                assert.equal(report.source.archiveStatus, "complete");
                assert.equal(report.source.originalPreserved, true);
                assert.equal(report.source.sha256, "test-sha");
                assert.equal(report.integrity.captureValid, true);
            }
            await assert.rejects(session.archive({ status: "complete", targetId: "other" }), /does not match/);
            assert.equal(JSON.parse(await fs.readFile(output, "utf8")).source.targetId, targetId);
        } finally { await session.close(); }
    }));

test("a rejected initial query cannot overwrite existing artifacts during later archive", async () =>
    withDirectory(async directory => {
        const panel = fakePanel();
        const session = await NativePerformanceTraceSession.open({ panel });
        const output = path.join(directory, "report.json");
        const summary = path.join(directory, "summary.json");
        await fs.writeFile(output, "previous report evidence");
        await fs.writeFile(summary, "previous summary evidence");
        try {
            await assert.rejects(session.query({ output }), { code: "EEXIST" });
            await session.archive({ status: "complete", targetId, panelTargetId, active: activeRecording(),
                output: path.join(directory, "trace.json"), bytes: 1234, sha256: "test-sha" });
            assert.equal(await fs.readFile(output, "utf8"), "previous report evidence");
            assert.equal(await fs.readFile(summary, "utf8"), "previous summary evidence");
        } finally { await session.close(); }
    }));
