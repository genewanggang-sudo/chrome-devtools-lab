import fs from "node:fs/promises";
import path from "node:path";
import { NativePerformancePanel } from "./performance-panel.mjs";
import { PerformanceSession } from "./performance-session.mjs";
import { PerformanceSummary } from "./performance-analysis.mjs";
import { NativePerformanceTraceSession } from "./native-performance-analysis.mjs";
import { acquireTraceLock } from "./trace-lock.mjs";

/** One native recording transaction; application readiness stays in the caller's config. */
export class NativePerformanceRun {
    static validate(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Native recording config must be an object.");
        const config = {
            host: "127.0.0.1", port: 9333, stableMs: 250, pollMs: 100,
            maxDurationMs: 180000, timeoutMs: 120000, undock: true,
            initScript: "", observationExpression: "null", applicationRevision: null,
            analysisQueries: [{ name: "loading" }], ...raw,
        };
        const allowed = new Set(["targetId", "outputDir", "stopWhen", "host", "port", "stableMs", "pollMs", "maxDurationMs", "timeoutMs", "undock", "initScript", "observationExpression", "applicationRevision", "analysisQueries"]);
        for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown native recording option: ${key}`);
        // Constructing validates the endpoint and exact target before any browser action.
        new NativePerformancePanel(config);
        if (typeof config.outputDir !== "string" || !config.outputDir) throw new Error("outputDir is required.");
        if (typeof config.stopWhen !== "string" || !config.stopWhen.trim()) throw new Error("stopWhen is required for automatic native recording.");
        for (const key of ["initScript", "observationExpression"]) if (typeof config[key] !== "string") throw new Error(`${key} must be a string.`);
        if (typeof config.undock !== "boolean") throw new Error("undock must be boolean.");
        for (const [key, min, max] of [["stableMs", 0, 60000], ["pollMs", 50, 10000], ["maxDurationMs", 100, 3600000]]) {
            if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}.`);
        }
        if (!Array.isArray(config.analysisQueries) || !config.analysisQueries.length || config.analysisQueries.length > 10) throw new Error("analysisQueries requires 1 to 10 queries.");
        const names = new Set();
        const queryKeys = new Set(["name", "startMs", "endMs", "startMark", "endMark", "frameId", "pid", "tid", "maxNodes", "maxDepth", "expandCallTree"]);
        for (const query of config.analysisQueries) {
            if (!query || typeof query !== "object" || Array.isArray(query) || !/^[a-z][a-z0-9-]{0,63}$/.test(query.name) || names.has(query.name)) throw new Error("Query names must be unique safe lowercase names.");
            for (const key of Object.keys(query)) if (!queryKeys.has(key)) throw new Error(`Unknown native query option: ${key}`);
            names.add(query.name);
        }
        new Function(config.initScript);
        new Function(`return (${config.stopWhen});`);
        new Function(`return (${config.observationExpression});`);
        return { ...config, outputDir: path.resolve(config.outputDir) };
    }

    constructor(config) {
        this.config = NativePerformanceRun.validate(config);
        this.timings = {};
    }

    async stage(name, operation) {
        console.error(`[native-performance] ${name}`);
        this.state.stage = name;
        await this.save();
        const started = performance.now();
        try { return await operation(); }
        finally { this.timings[name] = performance.now() - started; }
    }

    async save() {
        await fs.writeFile(path.join(this.config.outputDir, "run.json"), JSON.stringify(this.state, null, 2));
    }

    async environment() {
        return this.page.evaluate(`({ timeOrigin: performance.timeOrigin, now: performance.now(),
            width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
            visibility: document.visibilityState, url: location.href })`);
    }

    static sameViewport(before, after) {
        return ["width", "height", "dpr"].every(key => before[key] === after[key]);
    }

    async waitReady(oldOrigin) {
        const started = performance.now();
        let stableSince = null, currentOrigin = null;
        let last;
        while (performance.now() - started < this.config.maxDurationMs) {
            try {
                const result = await this.page.send("Runtime.evaluate", {
                    expression: `({ ready: Boolean(${this.config.stopWhen}), observation: (${this.config.observationExpression}), origin: performance.timeOrigin, now: performance.now() })`,
                    returnByValue: true, awaitPromise: false,
                }, undefined, Math.min(30000, Math.max(1, this.config.maxDurationMs - (performance.now() - started))));
                if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
                last = result.result?.value;
                if (last?.origin !== oldOrigin && Number.isFinite(last?.origin)) {
                    if (currentOrigin !== last.origin) { stableSince = null; currentOrigin = last.origin; }
                    if (last.ready) {
                        stableSince ??= performance.now();
                        if (performance.now() - stableSince >= this.config.stableMs) return last;
                    } else stableSince = null;
                } else stableSince = null;
            } catch (error) {
                if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) throw error;
                stableSince = null;
            }
            await new Promise(resolve => setTimeout(resolve, this.config.pollMs));
        }
        throw new Error(`Application readiness timed out after ${this.config.maxDurationMs}ms. Last observation: ${JSON.stringify(last)}`);
    }

    openAnalysis(panel, capture) {
        return NativePerformanceTraceSession.open({ panel, capture });
    }

    async analyzeRecording(panel, started) {
        const config = this.config;
        const capture = { ...this.state.stop, target: panel.target,
            valid: this.state.valid, invalidReasons: this.state.invalidReasons, cache: "existing" };
        let session, analysisError;
        try {
            session = await this.stage("reuseNativeAnalysis", () => this.openAnalysis(panel, capture));
            this.state.analysisTimings = session.timings;
            for (const [index, query] of config.analysisQueries.entries()) {
                const report = await this.stage(`query:${query.name}`, () => session.query({
                    ...query, targetId: config.targetId,
                    output: path.join(config.outputDir, index === 0 ? "report.json" : `${query.name}.report.json`),
                }));
                const summary = new PerformanceSummary(report).reportSummary();
                const result = { name: query.name, artifacts: report.artifacts, window: report.window,
                    processing: report.processing, threads: summary.threads.slice(0, 3),
                    javascriptHotspots: summary.javascriptHotspots.slice(0, 5),
                    javascriptHotspotsByTotal: summary.javascriptHotspotsByTotal.slice(0, 5) };
                this.state.queries.push(result);
                if (index === 0) this.timings.firstSummaryMs = performance.now() - started;
                await this.save();
                console.error(`[native-performance] summary ${JSON.stringify({ firstSummaryMs: this.timings.firstSummaryMs, ...result })}`);
            }
        } catch (error) {
            analysisError = error;
            throw error;
        } finally {
            // Preserve the complete recording even if native analysis is unsupported
            // or a query fails. The first summary is already available before this I/O.
            try {
                this.state.capture = await this.stage("export", () => panel.exportTrace(path.join(config.outputDir, "trace.json")));
                this.state.capture.valid = this.state.valid;
                this.state.capture.invalidReasons = this.state.invalidReasons;
                await fs.writeFile(this.state.capture.capturePath, JSON.stringify(this.state.capture, null, 2));
                if (session) await this.stage("archiveReports", () => session.archive(this.state.capture));
            } catch (archiveError) {
                if (analysisError) throw new AggregateError([analysisError, archiveError], `Native analysis failed (${analysisError.message}); raw archive failed (${archiveError.message}).`);
                throw archiveError;
            } finally {
                await session?.close();
            }
        }
    }

    async run() {
        const config = this.config;
        const started = performance.now();
        await fs.mkdir(path.dirname(config.outputDir), { recursive: true });
        await fs.mkdir(config.outputDir);
        await fs.writeFile(path.join(config.outputDir, "scenario.json"), JSON.stringify(config, null, 2), { flag: "wx" });
        this.state = { schemaVersion: 1, status: "running", targetId: config.targetId,
            outputDir: config.outputDir, applicationRevision: config.applicationRevision,
            startedAt: new Date().toISOString(), cache: "existing", timings: this.timings, queries: [] };
        const panel = new NativePerformancePanel(config);
        let ownsRecording = false;
        let lock, scriptId;
        try {
            lock = await acquireTraceLock({ host: config.host, port: config.port, timeoutMs: 0, metadata: { kind: "native-performance", targetId: config.targetId } });
            await this.stage("connect", () => panel.connect({ open: true }));
            if (config.undock) await this.stage("undock", () => panel.undock());
            const target = (await panel.json("/json/list")).find(item => item.id === config.targetId);
            if (!target?.webSocketDebuggerUrl) throw new Error("Exact page target is no longer available.");
            this.page = await new PerformanceSession(config.timeoutMs).connect(target.webSocketDebuggerUrl);
            await this.page.send("Page.enable");
            await this.page.send("Page.bringToFront");
            if (config.initScript) scriptId = (await this.page.send("Page.addScriptToEvaluateOnNewDocument", { source: config.initScript })).identifier;
            // Settle the inspected page after undocking, before freezing its geometry.
            await this.page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
            this.state.before = await this.environment();
            if (this.state.before.visibility !== "visible") throw new Error("The inspected page must be visible before recording.");
            await this.stage("startRecording", () => panel.start());
            ownsRecording = true;
            // Record-and-reload in DevTools can auto-stop at document load. Use ordinary
            // native Record plus immediate reload so application readiness owns the stop.
            await this.stage("reload", () => this.page.send("Page.reload", { ignoreCache: false }));
            this.state.ready = await this.stage("waitForApplication", () => this.waitReady(this.state.before.timeOrigin));
            this.state.stop = await this.stage("stopAndProcess", () => panel.stop());
            ownsRecording = false;
            this.state.after = await this.environment();
            this.state.valid = NativePerformanceRun.sameViewport(this.state.before, this.state.after)
                && this.state.after.visibility === "visible";
            this.state.invalidReasons = this.state.valid ? [] : ["Viewport/DPR or visibility changed during the recording."];
            this.state.screenshots = await this.stage("saveScreenshots", async () => {
                const files = {};
                for (const [name, connection] of [["page", this.page], ["performance", panel.panel]]) {
                    const screenshot = await connection.send("Page.captureScreenshot", { format: "jpeg", quality: 75 });
                    files[name] = path.join(config.outputDir, `${name}.jpeg`);
                    await fs.writeFile(files[name], Buffer.from(screenshot.data, "base64"), { flag: "wx" });
                }
                return files;
            });
            await this.analyzeRecording(panel, started);
            this.state.status = this.state.valid ? "complete" : "invalid";
        } catch (error) {
            this.state.status = "failed";
            this.state.valid = false;
            this.state.error = error.stack ?? error.message;
            if (ownsRecording) {
                try {
                    this.state.stop = await panel.stop();
                    this.state.capture = await panel.exportTrace(path.join(config.outputDir, "partial.trace.json"));
                } catch (cleanupError) { this.state.recoveryError = cleanupError.message; }
            }
            throw error;
        } finally {
            if (scriptId) await this.page?.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => {});
            this.page?.close();
            panel.close();
            await lock?.release();
            this.timings.totalMs = performance.now() - started;
            this.state.completedAt = new Date().toISOString();
            await this.save();
        }
        return this.state;
    }
}
