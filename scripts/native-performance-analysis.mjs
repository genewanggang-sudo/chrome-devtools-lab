import fs from "node:fs/promises";
import path from "node:path";
import { browserAnalysisSource, PerformanceSummary } from "./performance-analysis.mjs";

/** Queries Chrome's existing parsed recording; owns only a bounded remote handle. */
export class NativePerformanceTraceSession {
    static async open({ panel, capture = {} }) {
        const started = performance.now();
        const state = await panel.inspect();
        if (!state.bound || state.state !== "Idle" || !state.active) throw new Error("Select a completed recording in the exact page's native Performance panel.");
        if (capture.targetId && capture.targetId !== panel.targetId) throw new Error("Capture target does not match the native panel.");
        const session = new NativePerformanceTraceSession();
        session.panel = panel;
        session.group = `chrome-lab-native-analysis-${crypto.randomUUID()}`;
        session.capture = { ...capture, targetId: panel.targetId, panelTargetId: panel.panelTargetId, browserVersion: panel.version.Browser, active: state.active, mainFrameId: state.active.mainFrameId };
        session.timings = { parseCount: 0, reusedNativeParse: true, openMs: 0, queryMs: 0, transferMs: 0, writeMs: 0, queryCount: 0 };
        session.reports = [];
        try {
            const result = await panel.panel.send("Runtime.evaluate", {
                expression: `(async () => {
                    const timeline = await import('./panels/timeline/timeline.js');
                    const TraceEngine = await import('./models/trace/trace.js');
                    const sdk = await import('./core/sdk/sdk.js');
                    let ai, formatterError;
                    try { ai = await import('./models/ai_assistance/ai_assistance.js'); }
                    catch (error) { formatterError = error.message; }
                    const panel = timeline.TimelinePanel.TimelinePanel.instance();
                    const model = typeof panel.model === 'function' ? panel.model() : panel.model;
                    const trace = model.parsedTrace(${state.active.index});
                    if (trace?.traceEvents.length !== ${state.active.eventCount} || trace?.data.Meta.traceBounds.min !== ${state.active.bounds.min} || trace?.data.Meta.traceBounds.max !== ${state.active.bounds.max}) throw new Error('Selected native recording changed while opening analysis.');
                    const assertSelected = () => {
                        if (!sdk.TargetManager.TargetManager.instance().targets().some(target => target.id() === ${JSON.stringify(panel.targetId)})) throw new Error('Native panel is no longer bound to the exact page.');
                        if (panel.state !== 'Idle' || !panel.hasActiveTrace() || trace?.traceEvents !== panel.getTraceEngineRawTraceEventsForLayoutTests()) throw new Error('Selected native recording changed during analysis.');
                    };
                    assertSelected();
                    if (!TraceEngine.Extras?.TraceTree?.TopDownRootNode || !TraceEngine.Extras?.TraceTree?.BottomUpRootNode) throw new Error('Native Chrome TraceTree APIs are unsupported.');
                    const api = ${browserAnalysisSource()};
                    const native = {
                        DevTools: { TraceEngine },
                        analysisEngine: { package: null, version: ${JSON.stringify(panel.version.Browser)}, parser: 'existing Chrome Performance parsedTrace; no export or reparse', runtime: 'native DevTools frontend' },
                        getTraceSummary({ parsedTrace }) {
                            if (!ai?.AIContext?.AgentFocus || !ai?.PerformanceTraceFormatter?.PerformanceTraceFormatter) throw new Error(formatterError ?? 'Native trace text formatter unavailable');
                            return new ai.PerformanceTraceFormatter.PerformanceTraceFormatter(ai.AIContext.AgentFocus.fromParsedTrace(parsedTrace)).formatTraceSummary();
                        },
                        getInsightOutput({ parsedTrace, insights }, id, name) {
                            if (!ai?.AIContext?.AgentFocus || !ai?.PerformanceInsightFormatter?.PerformanceInsightFormatter) return { error: formatterError ?? 'Native insight text formatter unavailable' };
                            const insight = insights?.get(id)?.model?.[name];
                            if (!insight) return { error: 'Native insight is unavailable' };
                            return { output: new ai.PerformanceInsightFormatter.PerformanceInsightFormatter(ai.AIContext.AgentFocus.fromParsedTrace(parsedTrace), insight).formatInsight() };
                        },
                    };
                    return { api, native, trace, assertSelected, reportJSON: null };
                })()`,
                awaitPromise: true, objectGroup: session.group,
            });
            session.remoteId = session.remoteObject(result);
            session.timings.openMs = performance.now() - started;
            return session;
        } catch (error) { await session.close(); throw error; }
    }

    remoteObject(result) {
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        if (!result.result?.objectId) throw new Error("Native analysis did not return a remote session.");
        return result.result.objectId;
    }

    async call(functionDeclaration, args = []) {
        if (!this.remoteId) throw new Error("Native analysis session is closed.");
        const result = await this.panel.panel.send("Runtime.callFunctionOn", {
            objectId: this.remoteId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result?.value;
    }

    async query(options = {}) {
        if (this.busy) throw new Error("Native analysis queries and archive must run sequentially.");
        this.busy = true;
        try { return await this.querySelected(options); }
        finally { this.busy = false; }
    }

    async querySelected(options) {
        if (options.targetId && options.targetId !== this.panel.targetId) throw new Error("Query target does not match the native panel.");
        if (options.input || options.session || options.capture) throw new Error("Native queries use the selected recording and session capture.");
        const state = await this.panel.inspect();
        if (!state.bound) throw new Error("Native panel is no longer bound to the exact page.");
        const result = await this.call(`function(options, capture) {
            this.assertSelected();
            const started = performance.now();
            const resolved = this.api.resolvePerformanceWindow(this.trace, options, capture);
            const report = new this.api.NativePerformanceAnalysis(this.native, this.trace, resolved, capture).report();
            this.assertSelected();
            const queryMs = performance.now() - started;
            this.reportJSON = JSON.stringify(report);
            return { queryMs, characters: this.reportJSON.length };
        }`, [options, this.capture]);
        const transferStarted = performance.now();
        const chunks = [];
        for (let offset = 0; offset < result.characters; offset += 1024 * 1024) {
            chunks.push(await this.call("function(offset, length) { return this.reportJSON.slice(offset, offset + length); }", [offset, 1024 * 1024]));
        }
        await this.call("function() { this.reportJSON = null; }");
        const report = JSON.parse(chunks.join(""));
        const transferMs = performance.now() - transferStarted;
        this.timings.queryCount++;
        this.timings.queryMs += result.queryMs;
        this.timings.transferMs += transferMs;
        report.source = this.source();
        report.processing = { parseCount: 0, reusedNativeParse: true, queryIndex: this.timings.queryCount, queryMs: result.queryMs, transferMs };
        const entry = { report, output: options.output, overwrite: Boolean(options.overwrite) };
        if (options.output) await this.write(entry, true);
        this.reports.push(entry);
        return report;
    }

    source() {
        const capture = this.capture;
        return { kind: "native-performance-panel", targetId: capture.targetId, panelTargetId: capture.panelTargetId,
            active: capture.active, browserVersion: capture.browserVersion,
            input: capture.output ?? null, bytes: capture.bytes ?? null, sha256: capture.sha256 ?? null,
            originalPreserved: capture.status === "complete", archiveStatus: capture.status === "complete" ? "complete" : "pending" };
    }

    async write(entry, initial) {
        const started = performance.now();
        const output = path.resolve(entry.output);
        const parsed = path.parse(output);
        const summary = path.join(parsed.dir, parsed.base === "report.json" ? "summary.json" : `${parsed.name}.summary.json`);
        for (const file of [output, summary]) {
            if (this.capture.output && path.resolve(file).toLowerCase() === path.resolve(this.capture.output).toLowerCase()) throw new Error("Analysis must not overwrite the original recording.");
        }
        entry.report.artifacts = { report: output, summary };
        const entries = [
            { path: output, text: `${JSON.stringify(entry.report, null, 2)}\n` },
            { path: summary, text: `${JSON.stringify(new PerformanceSummary(entry.report).reportSummary(), null, 2)}\n` },
        ];
        const overwrite = !initial || entry.overwrite;
        const checks = await Promise.allSettled(entries.map(async ({ path: file }) => {
            try {
                const stat = await fs.lstat(file);
                if (!overwrite) throw Object.assign(new Error(`EEXIST: output already exists, '${file}'`), { code: "EEXIST" });
                if (!stat.isFile()) throw new Error(`Analysis output must be a regular file: ${file}`);
                return true;
            } catch (error) {
                if (error.code === "ENOENT") return false;
                throw error;
            }
        }));
        const rejected = checks.find(check => check.status === "rejected");
        if (rejected) throw rejected.reason;
        await fs.mkdir(parsed.dir, { recursive: true });
        const files = [];
        let writing = false;
        try {
            for (const [index, entry] of entries.entries()) {
                const existed = checks[index].value;
                const file = await fs.open(entry.path, existed ? "r+" : "wx");
                files.push({ ...entry, file, created: !existed });
            }
            writing = true;
            for (const entry of files) {
                await entry.file.truncate(0);
                await entry.file.writeFile(entry.text);
            }
        } finally {
            for (const entry of files) {
                await entry.file.close();
                // Release reservations after a conflict; preserve partial evidence
                // if writing itself failed after all paths were reserved.
                if (!writing && entry.created) await fs.unlink(entry.path);
            }
        }
        this.timings.writeMs += performance.now() - started;
    }

    async archive(capture) {
        if (this.busy) throw new Error("Native analysis queries and archive must run sequentially.");
        this.busy = true;
        try { return await this.archiveSelected(capture); }
        finally { this.busy = false; }
    }

    async archiveSelected(capture) {
        await this.call("function() { this.assertSelected(); }");
        NativePerformanceTraceSession.assertSameRecording(this.capture, capture);
        this.capture = { ...this.capture, ...capture };
        for (const entry of this.reports) {
            entry.report.source = this.source();
            entry.report.integrity.captureStatus = capture.status;
            entry.report.integrity.captureValid = this.capture.valid ?? null;
            entry.report.integrity.captureInvalidReasons = this.capture.invalidReasons ?? null;
            if (entry.output) await this.write(entry, false);
        }
    }

    static assertSameRecording(before, after) {
        if (after.status !== "complete" || before.targetId !== after.targetId || before.panelTargetId !== after.panelTargetId ||
            before.active.index !== after.active?.index || before.active.eventCount !== after.active?.eventCount ||
            before.active.bounds.min !== after.active?.bounds?.min || before.active.bounds.max !== after.active?.bounds?.max) throw new Error("Export does not match the analyzed native recording.");
    }

    async close() {
        this.remoteId = null;
        await this.panel?.panel?.send("Runtime.releaseObjectGroup", { objectGroup: this.group }).catch(() => {});
    }
}
