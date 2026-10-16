#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PerformanceSession } from "./performance-session.mjs";

// This adapter operates Chrome's own Performance panel. It neither starts a
// parallel Tracing session nor constructs a replacement timeline or trace parser.
export class NativePerformancePanel {
  constructor({
    targetId,
    host = "127.0.0.1",
    port = 9333,
    timeoutMs = 120000,
  }) {
    if (!/^[A-Fa-f0-9]{32}$/.test(targetId ?? ""))
      throw new Error("An exact page --target-exact ID is required.");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
      throw new Error("The Chrome endpoint must be loopback.");
    if (
      !Number.isInteger(Number(port)) ||
      Number(port) < 1 ||
      Number(port) > 65535
    )
      throw new Error("Invalid Chrome port.");
    if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0)
      throw new Error("timeoutMs must be positive.");
    this.targetId = targetId;
    this.endpoint = `http://${host}:${port}`;
    this.timeoutMs = Number(timeoutMs);
  }

  async connect({ open = false } = {}) {
    const version = await this.json("/json/version");
    this.version = version;
    this.browser = await new PerformanceSession(this.timeoutMs).connect(
      version.webSocketDebuggerUrl,
    );
    try {
      const { targetInfo } = await this.browser.send("Target.getTargetInfo", {
        targetId: this.targetId,
      });
      if (targetInfo.type !== "page" || targetInfo.url.startsWith("devtools:"))
        throw new Error(
          "The exact target must be the inspected business page, not DevTools.",
        );
      this.target = targetInfo;
      const existing = await this.browser.send("Target.getDevToolsTarget", {
        targetId: this.targetId,
      });
      this.panelTargetId = existing.targetId;
      if (!this.panelTargetId && !open)
        throw new Error(
          "No native DevTools window is open for this exact page. Run open first.",
        );
      if (open) {
        const opened = await this.browser.send("Target.openDevTools", {
          targetId: this.targetId,
          panelId: "timeline",
        });
        this.panelTargetId = opened.targetId;
      }
      const targetList = await this.json("/json/list");
      const panelTarget = targetList.find(
        (target) => target.id === this.panelTargetId,
      );
      if (!panelTarget?.webSocketDebuggerUrl)
        throw new Error(
          "Chrome did not expose the exact native DevTools frontend target.",
        );
      this.panel = await new PerformanceSession(this.timeoutMs).connect(
        panelTarget.webSocketDebuggerUrl,
      );
      await this.waitFor(async () => {
        try {
          return (await this.inspect()).bound;
        } catch {
          return false;
        }
      }, "native Performance panel initialization and exact-page binding");
      return this;
    } catch (error) {
      this.close();
      if (
        /wasn.t found|not found/.test(error.message) &&
        /DevTools/.test(error.message)
      ) {
        throw new Error(
          `This Chrome does not support Target.openDevTools/getDevToolsTarget. Upgrade Chrome; no substitute recorder was started. ${error.message}`,
        );
      }
      throw error;
    }
  }

  async json(route) {
    const response = await fetch(`${this.endpoint}${route}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(`Chrome endpoint returned HTTP ${response.status}.`);
    return response.json();
  }

  evaluate(expression) {
    return this.panel.evaluate(expression);
  }

  async waitFor(predicate, description) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for ${description}. The native window and recording are preserved.`,
    );
  }

  async inspect() {
    const state = await this.evaluate(`(async () => {
      const timeline = await import('./panels/timeline/timeline.js');
      const sdk = await import('./core/sdk/sdk.js');
      const panel = timeline.TimelinePanel.TimelinePanel.instance();
      const model = typeof panel.model === 'function' ? panel.model() : panel.model;
      const targets = sdk.TargetManager.TargetManager.instance().targets().map(target => ({ id: target.id(), type: target.type(), url: target.inspectedURL() }));
      let active = null;
      if (panel.hasActiveTrace()) {
        if (typeof panel.getTraceEngineRawTraceEventsForLayoutTests !== 'function') throw new Error('Native frontend active-trace access is unsupported by this Chrome.');
        const events = panel.getTraceEngineRawTraceEventsForLayoutTests();
        for (let index = 0; index < model.size(); index++) {
          const trace = model.parsedTrace(index);
          if (trace?.traceEvents === events) { active = { index, eventCount: events.length, metadata: { source: trace.metadata.source, startTime: trace.metadata.startTime, dataOrigin: trace.metadata.dataOrigin }, bounds: trace.data.Meta.traceBounds, mainFrameId: trace.data.Meta.mainFrameId, mainFrameURL: trace.data.Meta.mainFrameURL }; break; }
        }
        if (!active) throw new Error('Could not identify the currently selected native recording.');
      }
      return { state: panel.state, targets, active, capabilities: { nativeToolbar: Boolean(panel.toggleRecordAction && panel.recordReloadAction), nativeTraceExport: typeof timeline.SaveFileFormatter?.traceJsonGenerator === 'function' } };
    })()`);
    return {
      targetId: this.targetId,
      panelTargetId: this.panelTargetId,
      browserVersion: this.version.Browser,
      ...state,
      bound: state.targets.some((target) => target.id === this.targetId),
    };
  }

  async clickToolbar(action) {
    const button = await this.evaluate(`(async () => {
      const { TimelinePanel } = await import('./panels/timeline/timeline.js');
      const panel = TimelinePanel.TimelinePanel.instance();
      const action = ${JSON.stringify(action)};
      const title = action === 'reload' ? panel.recordReloadAction.title() : panel.toggleRecordAction.title();
      const candidates = [];
      function visit(root) {
        for (const element of root.querySelectorAll('*')) {
          if (element.tagName === 'BUTTON') {
            const label = element.getAttribute('aria-label') ?? '';
            const rect = element.getBoundingClientRect();
            if ((label === title || label.startsWith(title + ' -')) && rect.width > 0 && rect.height > 0 && !element.disabled) candidates.push({ label, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          }
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      }
      const toolbar = panel.panelToolbar.element ?? panel.panelToolbar;
      if (typeof toolbar?.querySelectorAll !== 'function') throw new Error('Native toolbar DOM is unsupported by this Chrome.');
      visit(toolbar);
      if (candidates.length !== 1) throw new Error('Expected exactly one enabled native Performance toolbar button; found ' + candidates.length);
      return candidates[0];
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.panel.send("Input.dispatchMouseEvent", {
        type,
        x: button.x,
        y: button.y,
        button: "left",
        clickCount: 1,
      });
    }
    return button;
  }

  async start({ reload = false } = {}) {
    const before = await this.inspect();
    if (!before.bound)
      throw new Error(
        "The native panel is no longer bound to the requested exact page.",
      );
    if (before.state !== "Idle")
      throw new Error(
        `Native panel is ${before.state}; an existing recording will not be replaced.`,
      );
    const button = await this.clickToolbar(reload ? "reload" : "record");
    const state = await this.waitFor(async () => {
      const next = await this.inspect();
      return next.state === "Recording" ? next : false;
    }, "the native Record button to start recording");
    return { ...state, operation: "native-toolbar-start", reload, button };
  }

  async stop() {
    const started = performance.now();
    const before = await this.inspect();
    if (!before.bound)
      throw new Error(
        "The native panel is no longer bound to the requested exact page.",
      );
    if (before.state !== "Recording")
      throw new Error(
        `Native panel is ${before.state}; no active recording was stopped.`,
      );
    let measureStart;
    try { measureStart = await this.evaluate("performance.now()"); } catch { /* Native metrics are optional. */ }
    const button = await this.clickToolbar("record");
    const requested = performance.now();
    const state = await this.waitFor(async () => {
      const next = await this.inspect();
      return next.state === "Idle" && next.active ? next : false;
    }, "native trace stop and processing");
    const completed = performance.now();
    let nativeProcessing;
    try {
      if (!Number.isFinite(measureStart)) throw new Error("Native frontend measure baseline was unavailable.");
      nativeProcessing = await this.processingMeasures(measureStart);
    } catch (error) {
      // Optional native diagnostics must never discard a completed recording.
      nativeProcessing = { status: "unavailable", reason: error.message };
    }
    return { ...state, operation: "native-toolbar-stop", button, nativeProcessing, timings: {
      inspectAndClickMs: requested - started,
      nativeProcessingWaitMs: completed - requested,
      readNativeMeasuresMs: performance.now() - completed,
      totalMs: performance.now() - started,
    } };
  }

  async processingMeasures(since) {
    const observation = await this.evaluate(`(() => ({
      since: ${Number(since)},
      observedAt: performance.now(),
      measures: performance.getEntriesByType('measure')
        .filter(entry => entry.startTime >= ${Number(since)})
        .map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })),
    }))()`);
    return NativePerformancePanel.summarizeProcessingMeasures(observation);
  }

  static summarizeProcessingMeasures({ since, observedAt, measures }) {
    const selected = measures.filter(entry =>
      Number.isFinite(entry.startTime) && Number.isFinite(entry.duration) &&
      entry.duration >= 0 && entry.startTime >= since &&
      entry.startTime + entry.duration <= observedAt + 1 &&
      /^(TraceLoad|total|parse(?::.*)?|insights(?::.*)?)$/.test(entry.name),
    );
    const latest = name => selected.filter(entry => entry.name === name).at(-1);
    const trace = latest("TraceLoad");
    const engine = latest("total");
    const parse = latest("parse");
    const insights = latest("insights");
    const phases = [];
    const add = (name, start, end) => {
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
        phases.push({ name, startTimeMs: start, durationMs: end - start });
    };
    if (trace && engine) add("beforeEngine", trace.startTime, engine.startTime);
    if (parse) add("engineParse", parse.startTime, parse.startTime + parse.duration);
    if (insights) add("engineInsights", insights.startTime, insights.startTime + insights.duration);
    if (trace && engine) add("afterEngine", engine.startTime + engine.duration, trace.startTime + trace.duration);
    const ordered = [...phases].sort((a, b) => a.startTimeMs - b.startTimeMs);
    const nonOverlapping = ordered.every((phase, index) => index === 0 ||
      phase.startTimeMs >= ordered[index - 1].startTimeMs + ordered[index - 1].durationMs - 0.001);
    const validPhases = nonOverlapping ? ordered : [];
    const phaseTotal = validPhases.reduce((total, phase) => total + phase.durationMs, 0);
    return {
      status: trace && engine && parse && insights && nonOverlapping && validPhases.length === 4 ? "complete" : selected.length ? "partial" : "unavailable",
      source: "Chrome Performance frontend performance.measure; this stop operation only",
      observedAtMs: observedAt,
      sinceMs: since,
      traceLoadMs: trace?.duration ?? null,
      engineTotalMs: engine?.duration ?? null,
      nonOverlappingPhases: validPhases,
      unassignedTraceLoadMs: trace && nonOverlapping ? Math.max(0, trace.duration - phaseTotal) : null,
      nestedHotspots: selected.filter(entry => /^(parse|insights):/.test(entry.name))
        .sort((a, b) => b.duration - a.duration).slice(0, 20)
        .map(entry => ({ name: entry.name, durationMs: entry.duration })),
      interpretation: "Phases do not overlap. Nested hotspot times are included in their parent phase and must not be added. Missing TraceLoad means its deferred UI measurement was not yet available; no recording or native processing setting was changed.",
    };
  }

  async undock() {
    await this.evaluate(`(async () => {
      const ui = await import('./ui/legacy/legacy.js');
      const controller = ui.DockController.DockController.instance();
      if (typeof controller.setDockSide !== 'function') throw new Error('Native DevTools undocking is unsupported.');
      controller.setDockSide('undocked');
    })()`);
    await this.waitFor(() => this.evaluate(`(async () => {
      const ui = await import('./ui/legacy/legacy.js');
      return ui.DockController.DockController.instance().dockSide() === 'undocked';
    })()`), "native DevTools undocking");
  }

  async exportTrace(output) {
    const started = performance.now();
    const before = await this.inspect();
    if (!before.bound || before.state !== "Idle" || !before.active)
      throw new Error(
        "Select a completed recording in this page's native Performance panel before exporting.",
      );
    if (!before.capabilities.nativeTraceExport)
      throw new Error(
        "This native frontend has no supported trace formatter. The recording is preserved.",
      );
    const outputPath = path.resolve(output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const capturePath = `${outputPath}.capture.json`;
    // Reserve both paths before accessing the recording; existing evidence is never overwritten.
    const capture = await fs.open(capturePath, "wx");
    let file;
    let iteratorId;
    const hash = createHash("sha256");
    let bytes = 0;
    let transferCalls = 0;
    let formatterChunks = 0;
    try {
      file = await fs.open(outputPath, "wx");
      const result = await this.panel.send("Runtime.evaluate", {
        expression: `(async () => {
          const timeline = await import('./panels/timeline/timeline.js');
          const panel = timeline.TimelinePanel.TimelinePanel.instance();
          if (panel.state !== 'Idle') throw new Error('Recording changed during export.');
          const events = panel.getTraceEngineRawTraceEventsForLayoutTests();
          const model = typeof panel.model === 'function' ? panel.model() : panel.model;
          const trace = model.parsedTrace(${before.active.index});
          if (trace?.traceEvents !== events || events.length !== ${before.active.eventCount}) throw new Error('Selected native recording changed during export.');
          const nativeChunks = timeline.SaveFileFormatter.traceJsonGenerator(events, trace.metadata);
          // The native formatter's metadata chunk can contain every script and
          // source map. Bound CDP transport messages without changing its output.
          return (function* () {
            for (const chunk of nativeChunks) {
              for (let offset = 0; offset < chunk.length;) {
                let end = Math.min(offset + 262144, chunk.length);
                const last = chunk.charCodeAt(end - 1);
                if (end < chunk.length && last >= 0xD800 && last <= 0xDBFF) end--;
                yield chunk.slice(offset, end);
                offset = end;
              }
            }
          })();
        })()`,
        awaitPromise: true,
        objectGroup: "performance-panel-export",
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      iteratorId = result.result?.objectId;
      if (!iteratorId)
        throw new Error("Native trace formatter did not return a generator.");
      while (true) {
        const next = await this.panel.send("Runtime.callFunctionOn", {
          objectId: iteratorId,
          functionDeclaration: NativePerformancePanel.exportBatch.toString(),
          arguments: [{ value: 1024 * 1024 }],
          returnByValue: true,
        });
        if (next.exceptionDetails)
          throw new Error(
            next.exceptionDetails.exception?.description ??
              next.exceptionDetails.text,
          );
        const chunk = next.result.value;
        transferCalls++;
        if (typeof chunk.value !== "string")
          throw new Error("Native formatter returned a non-string chunk.");
        const buffer = Buffer.from(chunk.value);
        hash.update(buffer);
        bytes += buffer.length;
        await file.writeFile(buffer);
        formatterChunks += chunk.chunkCount;
        if (chunk.done) break;
      }
      const resultInfo = {
        schemaVersion: 1,
        status: "complete",
        operation: "export-current-native-recording",
        targetId: this.targetId,
        panelTargetId: this.panelTargetId,
        target: this.target,
        browserVersion: this.version.Browser,
        output: outputPath,
        capturePath,
        bytes,
        timings: { exportMs: performance.now() - started, transferCalls, formatterChunks },
        sha256: hash.digest("hex"),
        active: before.active,
        mainFrameId: before.active.mainFrameId,
        exporter:
          "Chrome bundled TimelinePanel model + SaveFileFormatter.traceJsonGenerator",
        provenance:
          "The recording currently selected in Chrome Performance; no second recording or synthesized events.",
        compatibility:
          "Uses capability-checked internal DevTools frontend APIs; unsupported Chrome versions fail without replacing the recording.",
      };
      await capture.writeFile(JSON.stringify(resultInfo, null, 2));
      return resultInfo;
    } catch (error) {
      await capture.writeFile(
        JSON.stringify(
          {
            status: "failed",
            targetId: this.targetId,
            panelTargetId: this.panelTargetId,
            output: outputPath,
            bytes,
            error: error.message,
            partialFilesPreserved: true,
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      if (iteratorId)
        await this.panel
          .send("Runtime.releaseObjectGroup", {
            objectGroup: "performance-panel-export",
          })
          .catch(() => {});
      await file?.close();
      await capture.close();
    }
  }

  close() {
    this.panel?.close();
    this.browser?.close();
  }

  // Runs against the native formatter iterator in the DevTools frontend.
  // Batch small formatter chunks without changing a byte or making unbounded messages.
  static exportBatch = function(maxCharacters) {
    const chunks = [];
    let length = 0;
    let done = false;
    while (length < maxCharacters && chunks.length < 256) {
      const item = this.next();
      if (item.done) { done = true; break; }
      if (typeof item.value !== "string") throw new Error("Native formatter returned a non-string chunk.");
      chunks.push(item.value);
      length += item.value.length;
    }
    return { value: chunks.join(""), done, chunkCount: chunks.length };
  };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help",
    options = {};
  for (let index = 1; index < argv.length; index++) {
    if (!argv[index].startsWith("--"))
      throw new Error(`Unexpected argument: ${argv[index]}`);
    const name = argv[index].slice(2);
    options[name] =
      argv[index + 1] && !argv[index + 1].startsWith("--")
        ? argv[++index]
        : true;
  }
  if (command === "help" || options.help) {
    console.log(
      "Native Chrome Performance\n  open|status|start|stop --target-exact PAGE_ID [--port 9333]\n  start --target-exact PAGE_ID --reload\n  export --target-exact PAGE_ID --output NEW_trace.json\n\nRecord manually in the opened Chrome Performance window, or use start/stop to click its native toolbar. Export reads the currently selected completed native recording. No separate recorder or custom timeline is used. Chrome must support Target.openDevTools/getDevToolsTarget; frontend capabilities are checked at runtime.",
    );
    return;
  }
  if (!["open", "status", "start", "stop", "export"].includes(command))
    throw new Error(`Unknown native Performance command: ${command}`);
  if (command === "export" && typeof options.output !== "string")
    throw new Error("export requires --output NEW_trace.json.");
  const panel = new NativePerformancePanel({
    targetId: options["target-exact"],
    host: options.host,
    port: options.port,
    timeoutMs: options.timeout,
  });
  try {
    await panel.connect({ open: command === "open" || command === "start" });
    let result;
    if (command === "start")
      result = await panel.start({ reload: Boolean(options.reload) });
    else if (command === "stop") result = await panel.stop();
    else if (command === "export")
      result = await panel.exportTrace(options.output);
    else result = await panel.inspect();
    if (!options.quiet) console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    panel.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
