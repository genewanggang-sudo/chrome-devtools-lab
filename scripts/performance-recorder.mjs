import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { loadDevTools } from "./devtools-runtime.mjs";
import { acquireTraceLock } from "./trace-lock.mjs";
import { writeTraceStream } from "./trace-json.mjs";
import { PerformanceSession } from "./performance-session.mjs";

const { DevTools } = await loadDevTools();

export function validateRecording(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Recording config must be an object.");
  const config = {
    host: raw.host ?? "127.0.0.1",
    port: raw.port ?? 9333,
    targetId: raw.targetId ?? null,
    url: raw.url ?? null,
    action: raw.action ?? "none",
    cache: raw.cache ?? "existing",
    screenshots: raw.screenshots ?? true,
    bufferMb: raw.bufferMb ?? 256,
    maxDurationMs: raw.maxDurationMs ?? 600000,
    durationMs: raw.durationMs ?? null,
    stopWhen: raw.stopWhen ?? null,
    stableMs: raw.stableMs ?? 500,
    pollMs: raw.pollMs ?? 500,
    milestones: raw.milestones ?? [],
    outputDir: raw.outputDir,
    applicationRevision: raw.applicationRevision ?? null,
  };
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Recorder requires a loopback CDP host.");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("Invalid CDP port.");
  if (typeof config.targetId !== "string" || !config.targetId)
    throw new Error("An exact targetId is required.");
  if (typeof config.outputDir !== "string" || !config.outputDir)
    throw new Error("outputDir is required.");
  if (!["none", "reload", "navigate"].includes(config.action))
    throw new Error("action must be none, reload, or navigate.");
  if (
    config.action === "navigate" &&
    (typeof config.url !== "string" || !/^https?:/.test(config.url))
  )
    throw new Error("navigate requires an explicit HTTP(S) url.");
  if (!["existing", "disable-http"].includes(config.cache))
    throw new Error(
      "cache must be existing or disable-http; neither clears persistent application storage.",
    );
  if (typeof config.screenshots !== "boolean")
    throw new Error("screenshots must be boolean.");
  for (const [key, min, max] of [
    ["bufferMb", 8, 2048],
    ["maxDurationMs", 100, 3600000],
    ["stableMs", 0, 60000],
    ["pollMs", 100, 10000],
  ]) {
    if (
      !Number.isInteger(config[key]) ||
      config[key] < min ||
      config[key] > max
    )
      throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  }
  if (
    config.durationMs !== null &&
    (!Number.isInteger(config.durationMs) ||
      config.durationMs < 100 ||
      config.durationMs > config.maxDurationMs)
  )
    throw new Error("durationMs must be between 100 and maxDurationMs.");
  if (
    config.stopWhen !== null &&
    (typeof config.stopWhen !== "string" || !config.stopWhen.trim())
  )
    throw new Error("stopWhen must be a JavaScript boolean expression.");
  if (
    !Array.isArray(config.milestones) ||
    config.milestones.some(
      (x) =>
        typeof x?.name !== "string" ||
        !x.name ||
        typeof x.expression !== "string" ||
        !x.expression.trim(),
    )
  )
    throw new Error("milestones require name and expression strings.");
  if (
    new Set(config.milestones.map((x) => x.name)).size !==
    config.milestones.length
  )
    throw new Error("Milestone names must be unique.");
  return { ...config, outputDir: path.resolve(config.outputDir) };
}

export function performanceCategories(screenshots) {
  return [
    ...new Set([
      "-*",
      ...DevTools.TracingDefaultCategories,
      ...DevTools.TracingOptionalCategories.JsSampling,
      ...(screenshots ? DevTools.TracingOptionalCategories.Screenshot : []),
      "blink.user_timing",
      "disabled-by-default-devtools.timeline.stack",
      "cc",
      "viz",
      "gpu",
      "disabled-by-default-gpu.service",
      "disabled-by-default-display.framedisplayed",
    ]),
  ];
}

class EventFile {
  constructor(file) {
    this.stream = createWriteStream(file, { flags: "wx" });
    this.count = 0;
    this.dropped = 0;
    this.pendingBytes = 0;
    this.error = null;
    this.stream.on("error", (error) => {
      this.error = error;
    });
  }
  append(value) {
    if (this.error || this.pendingBytes > 16 * 1024 * 1024) {
      this.dropped++;
      return;
    }
    const text = JSON.stringify(value) + "\n";
    this.pendingBytes += Buffer.byteLength(text);
    this.count++;
    this.stream.write(text, () => {
      this.pendingBytes -= Buffer.byteLength(text);
    });
  }
  async close() {
    await new Promise((resolve) => {
      if (this.stream.destroyed) resolve();
      else this.stream.end(resolve);
    });
    if (this.error) throw this.error;
  }
}

/** Browser-native Performance tracing with a persistent start/stop session. */
export class PerformanceRecorder {
  constructor(config) {
    this.config = validateRecording(config);
    this.state = {
      schemaVersion: 1,
      status: "starting",
      pid: process.pid,
      startedAt: null,
      targetId: this.config.targetId,
      outputDir: this.config.outputDir,
    };
    this.warnings = [];
    this.errors = [];
    this.milestones = [];
    this.targets = [];
    this.frames = [];
    this.buffer = [];
    this.scripts = [];
    this.tasks = new Set();
    this.attached = new Map();
    this.controlToken = randomUUID();
    this.started = false;
    this.stopping = false;
    this.stopPromise = new Promise((resolve) => {
      this.requestStop = (reason) => {
        this.stopReason ??= reason;
        resolve();
      };
    });
  }
  async saveState() {
    const file = path.join(this.config.outputDir, "session.json");
    await fs.writeFile(file + ".next", JSON.stringify(this.state, null, 2));
    await fs.rename(file + ".next", file);
  }
  track(promise) {
    this.tasks.add(promise);
    void promise
      .catch((error) => this.warnings.push(String(error.message)))
      .finally(() => this.tasks.delete(promise));
  }
  async run() {
    const { config } = this;
    const base = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
    let lock, connection, server, network;
    let completionResolve;
    const completePromise = new Promise((resolve) => {
      completionResolve = resolve;
    });
    const begin = Date.now();
    let timer;
    try {
      const [version, targetList] = await Promise.all([
        fetch(base + "/json/version").then((r) => r.json()),
        fetch(base + "/json/list").then((r) => r.json()),
      ]);
      const target = targetList.find(
        (x) => x.id === config.targetId && x.type === "page",
      );
      if (!target)
        throw new Error("Exact page target is missing; list targets again.");
      this.target = target;
      this.version = version;
      lock = await acquireTraceLock({
        host: config.host,
        port: config.port,
        timeoutMs: 0,
        staleMs: config.maxDurationMs + 120000,
        metadata: { script: "performance", targetId: target.id },
      });
      connection = await new PerformanceSession(60000).connect(
        version.webSocketDebuggerUrl,
      );
      this.connection = connection;
      network = new EventFile(path.join(config.outputDir, "network.ndjson"));
      connection.on("event", (message) => {
        const { method, params = {}, sessionId } = message;
        if (method.startsWith("Network.")) {
          const allowed = [
            "requestWillBeSent",
            "responseReceived",
            "loadingFinished",
            "loadingFailed",
            "requestServedFromCache",
            "webSocketCreated",
            "webSocketClosed",
            "webSocketFrameSent",
            "webSocketFrameReceived",
          ];
          const kind = method.slice(8);
          if (!allowed.includes(kind)) return;
          const { requestId, timestamp, loaderId, frameId, type } = params;
          network.append({
            method,
            sessionId,
            targetId: this.attached.get(sessionId)?.targetId,
            requestId,
            timestamp,
            loaderId,
            frameId,
            type,
            ...(params.request
              ? {
                  request: {
                    url: params.request.url,
                    method: params.request.method,
                    initialPriority: params.request.initialPriority,
                  },
                }
              : {}),
            ...(params.response && kind === "responseReceived"
              ? {
                  response: {
                    url: params.response.url,
                    status: params.response.status,
                    mimeType: params.response.mimeType,
                    protocol: params.response.protocol,
                    timing: params.response.timing,
                    fromDiskCache: params.response.fromDiskCache,
                    fromServiceWorker: params.response.fromServiceWorker,
                  },
                }
              : {}),
            ...(kind.startsWith("webSocketFrame")
              ? {
                  frame: {
                    opcode: params.response?.opcode,
                    payloadCharacters:
                      params.response?.payloadData?.length ?? 0,
                  },
                }
              : {}),
            ...(params.url ? { url: params.url } : {}),
            ...(params.encodedDataLength !== undefined
              ? { encodedDataLength: params.encodedDataLength }
              : {}),
            ...(params.errorText ? { errorText: params.errorText } : {}),
          });
        } else if (method === "Page.frameNavigated")
          this.frames.push({ at: Date.now(), sessionId, ...params });
        else if (method === "Debugger.scriptParsed") {
          if (this.scripts.length < 50000)
            this.scripts.push({
              sessionId,
              scriptId: params.scriptId,
              url: params.url,
              sourceMapURL: params.sourceMapURL,
              hash: params.hash,
              startLine: params.startLine,
              startColumn: params.startColumn,
            });
          else this.scriptOverflow = true;
        } else if (method === "Runtime.exceptionThrown") {
          this.runtimeErrors ??= [];
          this.runtimeErrors.push({
            sessionId,
            text: params.exceptionDetails?.text,
          });
        } else if (method === "Target.attachedToTarget") {
          this.attached.set(params.sessionId, params.targetInfo);
          this.targets.push({
            event: "attached",
            at: Date.now(),
            parentSessionId: sessionId ?? null,
            sessionId: params.sessionId,
            ...params.targetInfo,
          });
          this.track(this.enableTarget(params.sessionId, params.targetInfo));
        } else if (method === "Target.detachedFromTarget")
          this.targets.push({ event: "detached", at: Date.now(), ...params });
      });
      connection.on("Tracing.bufferUsage", (value) => {
        this.buffer.push(value);
        if (value.percentFull >= 0.95) this.requestStop("buffer-limit");
      });
      connection.on("Tracing.tracingComplete", completionResolve);
      connection.on("closed", () => {
        if (!this.stopping) {
          this.errors.push("Browser connection closed during recording.");
          this.requestStop("browser-disconnected");
        }
      });
      const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId: target.id,
        flatten: true,
      });
      this.pageSessionId = sessionId;
      this.attached.set(sessionId, target);
      await this.enableTarget(sessionId, target);
      const environment = await connection.evaluate(
        "({url:location.href,visibility:document.visibilityState,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},timeOrigin:performance.timeOrigin})",
        sessionId,
      );
      this.environment = environment;
      this.frameBefore = await connection.send(
        "Page.getFrameTree",
        {},
        sessionId,
      );
      this.categories = performanceCategories(config.screenshots);
      await connection.send(
        "Tracing.start",
        {
          transferMode: "ReturnAsStream",
          bufferUsageReportingInterval: 500,
          traceConfig: {
            recordMode: "recordUntilFull",
            traceBufferSizeInKb: config.bufferMb * 1024,
            excludedCategories: ["*"],
            includedCategories: this.categories.filter(
              (category) => category !== "-*",
            ),
            enableSampling: true,
          },
        },
        sessionId,
      );
      this.started = true;
      this.state.startedAt = new Date().toISOString();
      this.recordingStart = Date.now();
      server = http.createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${this.controlToken}`) {
          res.writeHead(403).end();
          return;
        }
        if (req.method === "POST" && req.url === "/stop") {
          res.writeHead(202).end("stopping");
          this.requestStop("manual");
        } else if (req.method === "GET" && req.url === "/status") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(this.state));
        } else res.writeHead(404).end();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      this.state = {
        ...this.state,
        status: "recording",
        controlPort: server.address().port,
        controlToken: this.controlToken,
        targetUrl: target.url,
      };
      await this.saveState();
      timer = setTimeout(
        () => this.requestStop(config.durationMs ? "duration" : "deadline"),
        config.durationMs ?? config.maxDurationMs,
      );
      if (config.action === "reload")
        await connection.send(
          "Page.reload",
          { ignoreCache: config.cache === "disable-http" },
          sessionId,
        );
      if (config.action === "navigate") {
        const navigation = await connection.send(
          "Page.navigate",
          { url: config.url },
          sessionId,
        );
        if (navigation.errorText)
          throw new Error(`Navigation failed: ${navigation.errorText}`);
      }
      if (config.stopWhen || config.milestones.length)
        this.pollTask = this.poll();
      await this.stopPromise;
    } catch (error) {
      this.errors.push(String(error.stack ?? error));
      this.stopReason ??= "error";
    } finally {
      clearTimeout(timer);
      this.stopping = true;
      this.recordingEnd = Date.now();
      this.state.status = "stopping";
      await this.saveState().catch((error) =>
        this.errors.push(`Cannot save stopping state: ${error.message}`),
      );
      let traceSaved = false,
        complete = null;
      if (this.started && connection) {
        try {
          await connection.send("Tracing.end", {}, this.pageSessionId);
          complete = await Promise.race([
            completePromise,
            new Promise((_, reject) => {
              const t = setTimeout(
                () => reject(new Error("Trace completion timed out")),
                120000,
              );
              t.unref();
            }),
          ]);
          if (!complete.stream)
            throw new Error("Chrome did not provide a trace stream.");
          const traceSession = {
            send: (method, params) =>
              connection.send(method, params, this.pageSessionId),
          };
          this.traceTransfer = await writeTraceStream(
            traceSession,
            complete.stream,
            path.join(config.outputDir, "trace.json"),
          );
          traceSaved = true;
        } catch (error) {
          this.errors.push(String(error.stack ?? error));
        }
      }
      await this.pollTask?.catch((error) => this.warnings.push(error.message));
      if (connection && this.pageSessionId) {
        this.frameAfter = await connection
          .send("Page.getFrameTree", {}, this.pageSessionId)
          .catch(() => null);
        if (config.cache === "disable-http")
          await connection
            .send(
              "Network.setCacheDisabled",
              { cacheDisabled: false },
              this.pageSessionId,
            )
            .catch(() => {});
      }
      await Promise.allSettled([...this.tasks]);
      connection?.close();
      await network?.close().catch((error) => this.errors.push(error.message));
      if (server) await new Promise((resolve) => server.close(resolve));
      await lock
        ?.release()
        .catch((error) =>
          this.errors.push(`Cannot release trace lock: ${error.message}`),
        );
      const goodReason = ["manual", "duration", "condition"].includes(
        this.stopReason,
      );
      const invalidReasons = [...this.errors];
      if (!goodReason)
        invalidReasons.push(`Recording stopped: ${this.stopReason}`);
      if (!traceSaved) invalidReasons.push("No complete trace stream saved.");
      if (complete?.dataLossOccurred !== false)
        invalidReasons.push("Chrome dataLossOccurred is true or unavailable.");
      if (network?.dropped)
        invalidReasons.push(`Network metadata overflow: ${network.dropped}`);
      const capture = {
        schemaVersion: 1,
        mode: "native-performance-diagnostic",
        valid: invalidReasons.length === 0,
        invalidReasons,
        config,
        target: this.target,
        browser: this.version,
        environment: this.environment,
        startedAt: this.state.startedAt,
        finishedAt: new Date().toISOString(),
        wallDurationMs: Date.now() - begin,
        recordingDurationMs: this.recordingStart
          ? this.recordingEnd - this.recordingStart
          : 0,
        stopReason: this.stopReason,
        categories: this.categories,
        traceSaved,
        traceTransfer: this.traceTransfer,
        dataLossOccurred: complete?.dataLossOccurred ?? null,
        maxBufferUsage: Math.max(
          0,
          ...this.buffer.map((x) => x.percentFull ?? 0),
        ),
        bufferUsage: this.buffer,
        mainFrameId: this.frameBefore?.frameTree?.frame?.id,
        frameBefore: this.frameBefore,
        frameAfter: this.frameAfter,
        frameEvents: this.frames,
        targets: this.targets,
        milestones: this.milestones,
        runtimeErrors: this.runtimeErrors ?? [],
        errors: this.errors,
        warnings: this.warnings,
        network: {
          events: network?.count ?? 0,
          dropped: network?.dropped ?? 0,
          bodiesAndHeadersSaved: false,
        },
        scripts: this.scripts,
        scriptMetadataOverflow: this.scriptOverflow ?? false,
        coverage:
          "Browser trace includes all recorded processes; analysis must filter by frame/process ownership. Related target attachment metadata is observed, not proof of complete worker CPU samples.",
        cacheScope:
          config.cache === "disable-http"
            ? "HTTP cache disabled in this session; IndexedDB, service worker, OS, DNS and upstream caches not cleared."
            : "Existing page/session caches retained; this is not proof of cold loading.",
        paths: {
          trace: path.join(config.outputDir, "trace.json"),
          network: path.join(config.outputDir, "network.ndjson"),
        },
      };
      await fs.writeFile(
        path.join(config.outputDir, "capture.json"),
        JSON.stringify(capture, null, 2),
      );
      this.state = {
        ...this.state,
        status: capture.valid ? "complete" : "failed",
        valid: capture.valid,
        stopReason: this.stopReason,
        finishedAt: capture.finishedAt,
        capturePath: path.join(config.outputDir, "capture.json"),
        invalidReasons,
      };
      delete this.state.controlToken;
      delete this.state.controlPort;
      await this.saveState();
      return capture;
    }
  }
  async enableTarget(sessionId, target) {
    this.enabled ??= new Map();
    if (this.enabled.has(sessionId)) return this.enabled.get(sessionId);
    const enabling = this.enableTargetDomains(sessionId, target);
    this.enabled.set(sessionId, enabling);
    return enabling;
  }
  async enableTargetDomains(sessionId, target) {
    for (const method of [
      "Runtime.enable",
      "Network.enable",
      "Debugger.enable",
    ]) {
      await this.connection
        .send(method, {}, sessionId)
        .catch((error) =>
          this.warnings.push(`${target.type} ${method}: ${error.message}`),
        );
    }
    if (target.type === "page" || target.type === "iframe") {
      await this.connection.send("Page.enable", {}, sessionId);
      if (this.config.cache === "disable-http")
        await this.connection.send(
          "Network.setCacheDisabled",
          { cacheDisabled: true },
          sessionId,
        );
    }
    await this.connection
      .send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      )
      .catch(() => {});
  }
  async poll() {
    let stableSince = null;
    let documentOrigin = null;
    const seen = new Set();
    while (!this.stopping && !this.stopReason) {
      try {
        const expression = `({ready:${this.config.stopWhen ? `Boolean(${this.config.stopWhen})` : "false"}, milestones:[${this.config.milestones.map((x) => `Boolean(${x.expression})`).join(",")}], now:performance.now(), origin:performance.timeOrigin})`;
        const value = await this.connection.evaluate(
          expression,
          this.pageSessionId,
        );
        if (
          this.config.action !== "none" &&
          value.origin === this.environment?.timeOrigin
        ) {
          stableSince = null;
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.pollMs),
          );
          continue;
        }
        if (value.origin !== documentOrigin) {
          documentOrigin = value.origin;
          stableSince = null;
          seen.clear();
        }
        for (const [i, milestone] of this.config.milestones.entries()) {
          if (value.milestones[i] && !seen.has(milestone.name)) {
            seen.add(milestone.name);
            this.milestones.push({
              name: milestone.name,
              observedAtPageMs: value.now,
              timeOrigin: value.origin,
              resolutionMs: this.config.pollMs,
            });
            await this.connection.evaluate(
              `performance.mark(${JSON.stringify("lab:" + milestone.name)})`,
              this.pageSessionId,
            );
          }
        }
        if (value.ready) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= this.config.stableMs)
            this.requestStop("condition");
        } else stableSince = null;
      } catch (error) {
        if (
          !/context|navigat|Cannot find|Execution was terminated/i.test(
            error.message,
          )
        ) {
          this.errors.push(`Condition evaluation failed: ${error.message}`);
          this.requestStop("condition-error");
        }
        stableSince = null;
      }
      if (!this.stopReason)
        await new Promise((resolve) => setTimeout(resolve, this.config.pollMs));
    }
  }
}
