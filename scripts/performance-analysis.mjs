/** Shared report adapter for an upstream parsed recording; no Node or browser globals. */
function finiteNumber(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`${name} must be a finite number.`);
  return number;
}

function eventEnd(event) {
  return event.ts + Math.max(0, event.dur ?? 0);
}

function overlap(event, bounds) {
  return event.ts <= bounds.max && eventEnd(event) >= bounds.min;
}

function unionDuration(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [start, nextEnd] of sorted) {
    total += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return total / 1000;
}

function frameIdsFromCapture(capture) {
  const ids = new Set();
  for (const id of [
    capture?.mainFrameId,
    capture?.frameBefore?.frameTree?.frame?.id,
    capture?.frameAfter?.frameTree?.frame?.id,
    capture?.frameTree?.frame?.id,
    capture?.initialFrameTree?.frame?.id,
    capture?.finalFrameTree?.frame?.id,
  ]) {
    if (typeof id === "string") ids.add(id);
  }
  for (const entry of capture?.frameEvents ?? []) {
    const frame = entry.frame ?? entry.params?.frame ?? entry.data?.frame;
    if (frame?.id && !frame.parentId) ids.add(frame.id);
  }
  return ids;
}

function nativeNodeSummary(node) {
  const event = node.event;
  const callFrame = event?.callFrame ?? event?.args?.data?.stackTrace?.[0];
  return {
    id: typeof node.id === "symbol" ? node.id.description : node.id,
    name: callFrame?.functionName || event?.name || "(anonymous)",
    eventName: event?.name ?? null,
    selfMs: node.selfTime,
    totalMs: node.totalTime,
    occurrences: node.events?.length ?? 0,
    ...(callFrame
      ? {
          callFrame: {
            functionName: callFrame.functionName,
            url: callFrame.url,
            scriptId: callFrame.scriptId,
            lineNumber: callFrame.lineNumber,
            columnNumber: callFrame.columnNumber,
            locationConvention:
              "zero-based generated-source positions; source maps are not automatically fetched",
          },
        }
      : {}),
  };
}

function serializeNativeTree(root, { maxNodes, maxDepth, expand = true }) {
  const nodes = [];
  const queue = [...root.children().values()]
    .sort((a, b) => b.selfTime - a.selfTime)
    .map((node) => ({ node, parent: null, depth: 0 }));
  let cursor = 0;
  while (cursor < queue.length && nodes.length < maxNodes) {
    const { node, parent, depth } = queue[cursor++];
    const index = nodes.length;
    const hasChildren = node.hasChildren();
    nodes.push({
      ...nativeNodeSummary(node),
      index,
      parent,
      depth,
      hasChildren,
      childrenExpanded: Boolean(expand && hasChildren && depth < maxDepth),
    });
    if (expand && hasChildren && depth < maxDepth) {
      for (const child of [...node.children().values()].sort(
        (a, b) => b.selfTime - a.selfTime,
      )) {
        queue.push({ node: child, parent: index, depth: depth + 1 });
      }
    }
  }
  return {
    algorithm: `Chrome DevTools TraceEngine ${root.constructor.name}`,
    totalMs: root.totalTime,
    selfMs: root.selfTime,
    nodes,
    truncated:
      cursor < queue.length ||
      (expand &&
        nodes.some((node) => node.hasChildren && !node.childrenExpanded)),
    descendantsIncluded: expand,
    descendantsDeferred: !expand && nodes.some((node) => node.hasChildren),
    maxNodes,
    maxDepth,
  };
}

export class NativePerformanceAnalysis {
  constructor(native, parsedTrace, options, capture) {
    this.native = native;
    this.trace = parsedTrace;
    this.data = parsedTrace.data;
    this.options = options;
    this.capture = capture;
    this.origin = this.data.Meta.traceBounds.min;
    const duration = this.data.Meta.traceBounds.range / 1000;
    const startMs = finiteNumber(options.startMs, "startMs", 0);
    const endMs = finiteNumber(options.endMs, "endMs", duration);
    if (startMs < 0 || endMs <= startMs || startMs >= duration)
      throw new Error(
        `Invalid time range ${startMs}–${endMs}ms for ${duration}ms trace.`,
      );
    this.bounds = {
      min: this.origin + startMs * 1000,
      max: Math.min(this.origin + endMs * 1000, this.data.Meta.traceBounds.max),
    };
    this.bounds.range = this.bounds.max - this.bounds.min;
    // Match the native panel's lazy tree: calculate roots and Bottom-up hotspots
    // first. Descendant expansion can rescan all thread events for every node;
    // do that only when the caller explicitly asks for a call chain.
    this.expandCallTree = options.expandCallTree ?? false;
    if (typeof this.expandCallTree !== "boolean")
      throw new Error("expandCallTree must be a boolean.");
    this.maxNodes = finiteNumber(options.maxNodes, "maxNodes", 100);
    this.maxDepth = finiteNumber(options.maxDepth, "maxDepth", 10);
    if (
      !Number.isInteger(this.maxNodes) ||
      this.maxNodes < 1 ||
      !Number.isInteger(this.maxDepth) ||
      this.maxDepth < 0
    )
      throw new Error(
        "maxNodes must be a positive integer; maxDepth must be a nonnegative integer.",
      );
    this.frameIds = options.frameId
      ? new Set([options.frameId])
      : frameIdsFromCapture(capture);
    this.explicitFrame = this.frameIds.size > 0;
    if (!this.frameIds.size && this.data.Meta.mainFrameId)
      this.frameIds.add(this.data.Meta.mainFrameId);
    this.selectedPids = new Set();
    for (const id of this.frameIds) {
      for (const pid of this.data.Meta.rendererProcessesByFrame
        .get(id)
        ?.keys() ?? [])
        this.selectedPids.add(pid);
    }
    if (options.pid !== undefined)
      this.selectedPids = new Set([finiteNumber(options.pid, "pid")]);
    this.workerThreads = new Map();
    for (const event of this.data.Workers.workerSessionIdEvents) {
      const info = event.args?.data;
      if (info)
        this.workerThreads.set(`${event.pid}:${info.workerThreadId}`, {
          workerId: info.workerId,
          url: info.url,
          frameId: info.frame,
          attributedToSelectedFrame: this.frameIds.has(info.frame),
        });
    }
  }

  event(event) {
    return {
      name: event.name,
      category: event.cat,
      pid: event.pid,
      tid: event.tid,
      startMs: (event.ts - this.origin) / 1000,
      durationMs: Math.max(0, event.dur ?? 0) / 1000,
      selectedDurationMs:
        Math.max(
          0,
          Math.min(eventEnd(event), this.bounds.max) -
            Math.max(event.ts, this.bounds.min),
        ) / 1000,
    };
  }

  trees(entries, jsOnly = false) {
    const { TopDownRootNode, BottomUpRootNode } =
      this.native.DevTools.TraceEngine.Extras.TraceTree;
    const filters = jsOnly
      ? [
          {
            accept: (event) =>
              this.native.DevTools.TraceEngine.Types.Events.isProfileCall(
                event,
              ),
          },
        ]
      : [];
    const settings = {
      filters,
      startTime: this.bounds.min / 1000,
      endTime: this.bounds.max / 1000,
      includeInstantEvents: false,
    };
    return {
      callTree: serializeNativeTree(new TopDownRootNode(entries, settings), {
        maxNodes: this.maxNodes,
        maxDepth: this.maxDepth,
        expand: this.expandCallTree,
      }),
      bottomUp: serializeNativeTree(
        new BottomUpRootNode(entries, {
          ...settings,
          textFilter: { accept: () => true },
        }),
        { maxNodes: this.maxNodes, maxDepth: this.maxDepth, expand: false },
      ),
    };
  }

  selectedThread(pid, tid) {
    if (this.options.tid !== undefined)
      return (
        tid === finiteNumber(this.options.tid, "tid") &&
        (!this.selectedPids.size || this.selectedPids.has(pid))
      );
    if (
      this.options.pid === undefined &&
      this.workerThreads.get(`${pid}:${tid}`)?.attributedToSelectedFrame
    )
      return true;
    return !this.selectedPids.size || this.selectedPids.has(pid);
  }

  sampling(profile, integratedCallCount) {
    return {
      source: "TraceEngine Samples handler / native CPUProfileDataModel",
      profileId: profile.profileId,
      sampleCount: profile.rawProfile.samples?.length ?? 0,
      nodeCount: profile.rawProfile.nodes?.length ?? 0,
      startMs: profile.parsedProfile.profileStartTime - this.origin / 1000,
      endMs: profile.parsedProfile.profileEndTime - this.origin / 1000,
      integratedCallCount,
      largestSampleGapMs: (profile.rawProfile.timeDeltas ?? []).reduce(
        (largest, value) => Math.max(largest, value / 1000),
        0,
      ),
      gapInterpretation:
        "A gap is not by itself proof of dropped samples or idle time.",
    };
  }

  standaloneSampleCalls(profile, pid, tid) {
    // Workers can be sampled outside the Renderer handler's frame-process map.
    // Use the native CPUProfileDataModel frame iterator, as the upstream Samples
    // handler does for CPU-only profiles. Do not rebuild sample timing ourselves.
    const calls = [];
    const stack = [];
    profile.parsedProfile.forEachFrame(
      (_depth, node, sampleIndex, timestampMs) => {
        const call = {
          cat: "",
          name: "ProfileCall",
          ph: "X",
          pid,
          tid,
          ts: timestampMs * 1000,
          dur: 0,
          args: {},
          nodeId: node.id,
          callFrame: node.callFrame,
          sampleIndex,
          profileId: profile.profileId,
        };
        calls.push(call);
        stack.push(call);
      },
      (_depth, _node, _sampleIndex, _timestampMs, durationMs) => {
        const call = stack.pop();
        if (call) call.dur = durationMs * 1000;
      },
    );
    this.native.DevTools.TraceEngine.Helpers.Trace.sortTraceEventsInPlace(
      calls,
    );
    return calls;
  }

  threads() {
    const result = new Map();
    for (const [pid, threads] of this.data.Meta.threadsInProcess) {
      for (const [tid, entry] of threads)
        result.set(`${pid}:${tid}`, {
          pid,
          tid,
          name: entry.args?.name ?? String(tid),
          processName: this.data.Meta.processNames.get(pid)?.args?.name ?? null,
          selected: this.selectedThread(pid, tid),
          eventCount: 0,
        });
    }
    for (const [pid, process] of this.data.Renderer.processes) {
      for (const [tid, thread] of process.threads) {
        const key = `${pid}:${tid}`;
        const item = result.get(key) ?? {
          pid,
          tid,
          name: thread.name,
          selected: this.selectedThread(pid, tid),
        };
        const entries = thread.entries;
        const inWindow = entries.filter((event) => overlap(event, this.bounds));
        item.processURL = process.url;
        item.worker = this.workerThreads.get(key) ?? null;
        item.isMainFrameProcess = process.isOnMainFrame;
        item.isMainThread = thread.name === "CrRendererMain";
        item.eventCount = entries.length;
        item.selectedEventCount = inWindow.length;
        const tasks = entries
          .filter(
            (event) =>
              this.native.DevTools.TraceEngine.Types.Events.isRunTask(event) &&
              overlap(event, this.bounds),
          )
          .filter((event) => {
            let parent = this.data.Renderer.entryToNode.get(event)?.parent;
            while (parent) {
              if (
                this.native.DevTools.TraceEngine.Types.Events.isRunTask(
                  parent.entry,
                )
              )
                return false;
              parent = parent.parent;
            }
            return true;
          });
        item.topLevelTasks = tasks.map((event) => this.event(event));
        item.taskTimeMs = unionDuration(
          tasks.map((event) => [
            Math.max(event.ts, this.bounds.min),
            Math.min(eventEnd(event), this.bounds.max),
          ]),
        );
        const longTasks = tasks.filter((event) => event.dur > 50_000);
        item.longTaskCount = longTasks.length;
        item.blockingTimeMs = unionDuration(
          longTasks.map((event) => [
            Math.max(event.ts + 50_000, this.bounds.min),
            Math.min(eventEnd(event), this.bounds.max),
          ]),
        );
        const profile = this.data.Samples.profilesInProcess.get(pid)?.get(tid);
        item.sampling = profile
          ? this.sampling(profile, thread.profileCalls?.length ?? 0)
          : null;
        if (
          item.selected &&
          (item.isMainThread || profile || this.options.tid !== undefined)
        ) {
          item.activity = this.trees(entries);
          if (profile) item.javascript = this.trees(entries, true);
        }
        result.set(key, item);
      }
    }
    for (const [pid, profiles] of this.data.Samples.profilesInProcess) {
      for (const [tid, profile] of profiles) {
        const key = `${pid}:${tid}`;
        const item = result.get(key) ?? {
          pid,
          tid,
          name: String(tid),
          selected: this.selectedThread(pid, tid),
          eventCount: 0,
        };
        if (item.sampling) continue;
        item.worker = this.workerThreads.get(key) ?? null;
        item.sampling = this.sampling(profile, 0);
        item.activityAvailability =
          "Sample-only: no Renderer frame-process timeline was available; task timings are not inferred.";
        if (item.selected)
          item.javascript = this.trees(
            this.standaloneSampleCalls(profile, pid, tid),
            true,
          );
        result.set(key, item);
      }
    }
    return [...result.values()].sort(
      (a, b) =>
        Number(b.selected) - Number(a.selected) ||
        Number(b.isMainThread ?? false) - Number(a.isMainThread ?? false) ||
        a.pid - b.pid ||
        a.tid - b.tid,
    );
  }

  network() {
    const requests = this.data.NetworkRequests.byTime
      .filter((event) => overlap(event, this.bounds))
      .map((event) => {
        const data = event.args.data;
        return {
          ...this.event(event),
          requestId: data.requestId,
          url: data.url,
          method: data.requestMethod,
          resourceType: data.resourceType,
          statusCode: data.statusCode,
          mimeType: data.mimeType,
          encodedDataLength: data.encodedDataLength,
          decodedBodyLength: data.decodedBodyLength,
          frameId: data.frame,
          fromCache: data.fromCache,
          fromServiceWorker: data.fromServiceWorker,
          priority: data.priority,
          timing: data.timing,
          syntheticData: data.syntheticData,
        };
      });
    const webSockets = this.data.NetworkRequests.webSocket
      .map((socket) => ({
        identifier: socket.webSocketIdentifier,
        frameId: socket.frame,
        workerId: socket.workerId,
        events: socket.events
          .filter((event) => overlap(event, this.bounds))
          .map((event) => ({
            ...this.event(event),
            url: event.args?.data?.url,
            encodedDataLength: event.args?.data?.dataLength,
          })),
      }))
      .filter((socket) => socket.events.length);
    return {
      requests,
      webSockets,
      scope:
        "All requests in the trace window; frameId is preserved. WebSocket payload bodies are not reproduced.",
      intervalMeaning:
        "Request lifetime includes network and server/queue latency; it is not server CPU time.",
    };
  }

  gc() {
    const events = [];
    for (const [pid, process] of this.data.Renderer.processes) {
      for (const [tid, thread] of process.threads) {
        if (!this.selectedThread(pid, tid)) continue;
        const matching = thread.entries.filter(
          (event) =>
            /^(?:MajorGC|MinorGC|GCEvent|V8\.GC|v8\.gc)/.test(event.name) &&
            event.dur > 0 &&
            overlap(event, this.bounds),
        );
        events.push(...matching.map((event) => this.event(event)));
      }
    }
    const byThread = new Map();
    for (const event of events) {
      const key = `${event.pid}:${event.tid}`;
      const intervals = byThread.get(key) ?? [];
      intervals.push([
        Math.max(event.startMs * 1000 + this.origin, this.bounds.min),
        Math.min(
          (event.startMs + event.durationMs) * 1000 + this.origin,
          this.bounds.max,
        ),
      ]);
      byThread.set(key, intervals);
    }
    return {
      events,
      threadTimeMs: [...byThread].map(([thread, intervals]) => ({
        thread,
        durationMs: unionDuration(intervals),
      })),
      meaning:
        "Nested GC intervals are unioned per thread; values across threads are CPU-track elapsed time, not whole-page wall time.",
    };
  }

  insights() {
    const sets = [];
    for (const [id, set] of this.trace.insights ?? []) {
      const models = [];
      for (const [name, model] of Object.entries(set.model ?? {})) {
        let output;
        try {
          output = this.native.getInsightOutput(
            { parsedTrace: this.trace, insights: this.trace.insights },
            id,
            name,
          );
        } catch (error) {
          output = { error: error.message };
        }
        models.push({
          name,
          state: model?.state,
          title: model?.title,
          description: model?.description,
          ...output,
        });
      }
      sets.push({
        id,
        url: set.url,
        frameId: set.frameId,
        bounds: set.bounds,
        models,
        errors: Object.entries(set.modelErrors ?? {}).map(([name, error]) => ({
          name,
          error: error?.message ?? String(error),
        })),
      });
    }
    return {
      scope:
        "Native navigation insight sets can span outside the selected query window; each set retains its native bounds.",
      sets,
    };
  }

  report() {
    const threads = this.threads();
    const timing = this.data.UserTimings;
    const marks = [
      ...timing.performanceMarks,
      ...timing.performanceMeasures,
      ...timing.consoleTimings,
      ...timing.timestampEvents,
    ]
      .filter((event) => overlap(event, this.bounds))
      .map((event) => this.event(event));
    const screenshotEvents =
      this.data.Screenshots.screenshots ??
      this.data.Screenshots.legacySyntheticScreenshots ??
      [];
    const screenshots = screenshotEvents
      .filter((event) => overlap(event, this.bounds))
      .map((event) => ({
        ...this.event(event),
        imageData:
          "Stored in the original trace; open it in Chrome Performance to inspect the filmstrip.",
      }));
    let nativeSummary;
    try {
      nativeSummary = this.native.getTraceSummary({
        parsedTrace: this.trace,
        insights: this.trace.insights,
      });
    } catch (error) {
      nativeSummary = `Native summary unavailable: ${error.message}`;
    }
    const dataLossEvents = this.trace.traceEvents
      .filter((event) =>
        /(?:TraceBufferOverflow|TracingDataLoss|DataLoss)/i.test(event.name),
      )
      .map((event) => this.event(event));
    return {
      schemaVersion: 1,
      engine: {
        name: "Chrome DevTools TraceEngine",
        package: "chrome-devtools-mcp",
        version: this.native.runtime?.version ?? null,
        parser: "upstream chunked byte-buffer parser",
        treeAlgorithms: ["TopDownRootNode", "BottomUpRootNode"],
        timingUnit: "milliseconds",
        rawEventTimestampUnit: "microseconds",
        sourcePositions:
          "zero-based generated JavaScript; no automatic external source-map fetch",
        ...this.native.analysisEngine,
      },
      window: {
        startMs: (this.bounds.min - this.origin) / 1000,
        endMs: (this.bounds.max - this.origin) / 1000,
        durationMs: this.bounds.range / 1000,
        traceDurationMs: this.data.Meta.traceBounds.range / 1000,
        traceOriginUs: this.origin,
      },
      scope: {
        targetId:
          this.options.targetId ??
          this.capture?.target?.id ??
          this.capture?.targetId ??
          null,
        frameIds: [...this.frameIds],
        rendererPids: [...this.selectedPids],
        attribution: this.selectedPids.size
          ? this.explicitFrame
            ? "explicit captured frame metadata"
            : "native trace main-frame metadata"
          : "unattributed; all renderer processes are included",
        tid: this.options.tid ?? null,
        warnings:
          this.explicitFrame && !this.selectedPids.size
            ? [
                "The requested frame has no renderer mapping; results must not be attributed to that target.",
              ]
            : [],
      },
      integrity: {
        rawEventCount: this.trace.traceEvents.length,
        dataLossEvents,
        dataLossAssessment:
          dataLossEvents.length || this.capture?.dataLossOccurred
            ? "Trace or capture explicitly reports data loss."
            : "No known data-loss marker was found; this alone does not prove complete collection.",
        captureStatus: this.capture?.status ?? null,
        captureValid: this.capture?.valid ?? null,
        captureInvalidReasons: this.capture?.invalidReasons ?? null,
        dataLossOccurred: this.capture?.dataLossOccurred ?? null,
        maxBufferUsage: this.capture?.maxBufferUsage ?? null,
        streamClosed: this.capture?.traceTransfer?.streamClosed ?? null,
      },
      coverage: {
        threadCount: threads.length,
        sampledThreadCount: threads.filter(
          (thread) => thread.sampling?.sampleCount > 0,
        ).length,
        selectedThreadCount: threads.filter((thread) => thread.selected).length,
        selectedSampledThreadCount: threads.filter(
          (thread) => thread.selected && thread.sampling?.sampleCount > 0,
        ).length,
        scope:
          "threadCount and sampledThreadCount cover the complete trace. Selected counts use the report's frame/process/thread attribution; they do not guarantee samples inside the selected time window. networkRequests and screenshotCount cover the complete trace; markCount covers the selected time window.",
        networkRequests: this.data.NetworkRequests.byTime.length,
        screenshotCount: screenshotEvents.length,
        markCount: marks.length,
        limitations: [
          "CPU samples estimate execution; they are not instrumented function timings.",
          "GPU-process trace activity is not GPU hardware execution time.",
          "Concurrent thread times must not be added to infer page elapsed time.",
          "Unavailable tracks are reported as missing rather than inferred.",
          "Raw recording is preserved for Chrome Performance import; this report is an analysis adapter, not a replacement DevTools UI.",
        ],
      },
      threads,
      network: this.network(),
      gc: this.gc(),
      marks,
      screenshots,
      insights: this.insights(),
      nativeSummary,
    };
  }
}

/** A bounded first pass over an existing report; no trace parsing or tree expansion. */
export class PerformanceSummary {
  constructor(report) {
    this.report = report;
    this.selectedThreads = report.threads.filter((thread) => thread.selected);
    this.truncatedTextCount = 0;
  }

  text(value, maxLength = 1024) {
    if (typeof value !== "string" || value.length <= maxLength) return value;
    this.truncatedTextCount++;
    return `${value.slice(0, maxLength)}… [truncated; see full report]`;
  }

  hotspot(node, thread) {
    const frame = node.callFrame;
    return {
      pid: thread.pid,
      tid: thread.tid,
      thread: this.text(thread.name, 256),
      name: this.text(node.name, 256),
      selfMs: node.selfMs,
      totalMs: node.totalMs,
      ...(frame
        ? {
            url: this.text(frame.url),
            lineNumber: frame.lineNumber,
            columnNumber: frame.columnNumber,
          }
        : {}),
    };
  }

  reportSummary() {
    const report = this.report;
    const threadLimit = 20;
    const hotspotLimit = 20;
    const detailLimit = 10;
    const threads = [...this.selectedThreads].sort(
      (a, b) =>
        Number(b.isMainThread ?? false) - Number(a.isMainThread ?? false) ||
        Number(Boolean(b.sampling)) - Number(Boolean(a.sampling)) ||
        (b.taskTimeMs ?? 0) - (a.taskTimeMs ?? 0),
    );
    const hotspots = this.selectedThreads
      .flatMap((thread) =>
        (thread.javascript?.bottomUp.nodes ?? []).map((node) =>
          this.hotspot(node, thread),
        ),
      )
      .sort((a, b) => b.selfMs - a.selfMs);
    const longTasks = this.selectedThreads
      .flatMap((thread) =>
        (thread.topLevelTasks ?? [])
          .filter((task) => task.durationMs > 50)
          .map((task) => ({
            pid: thread.pid,
            tid: thread.tid,
            thread: this.text(thread.name, 256),
            startMs: task.startMs,
            durationMs: task.durationMs,
            selectedDurationMs: task.selectedDurationMs,
          })),
      )
      .sort((a, b) => b.selectedDurationMs - a.selectedDurationMs);
    const requests = [...report.network.requests].sort(
      (a, b) => b.selectedDurationMs - a.selectedDurationMs,
    );
    const treeTruncation = [];
    for (const thread of this.selectedThreads) {
      for (const kind of ["activity", "javascript"]) {
        for (const type of ["callTree", "bottomUp"]) {
          const tree = thread[kind]?.[type];
          if (tree && (tree.truncated || tree.descendantsDeferred))
            treeTruncation.push({
              pid: thread.pid,
              tid: thread.tid,
              kind,
              type,
              nodes: tree.nodes.length,
              maxNodes: tree.maxNodes,
              maxDepth: tree.maxDepth,
              descendantsDeferred: tree.descendantsDeferred ?? false,
            });
        }
      }
    }
    const insightStates = {};
    const insightFindings = [];
    let insightErrorCount = 0;
    for (const set of report.insights.sets) {
      insightErrorCount += set.errors.length;
      for (const model of set.models) {
        const state = model.state ?? "unknown";
        insightStates[state] = (insightStates[state] ?? 0) + 1;
        if (state !== "pass")
          insightFindings.push({
            setId: this.text(set.id, 256),
            frameId: set.frameId,
            bounds: set.bounds,
            name: model.name,
            state,
            title: this.text(model.title, 256),
          });
      }
    }
    return {
      schemaVersion: 1,
      purpose:
        "Bounded first-pass summary; inspect the saved report or query a narrower window for details.",
      artifacts: report.artifacts ?? null,
      source: report.source,
      processing: report.processing ?? null,
      window: report.window,
      scope: report.scope,
      integrity: {
        rawEventCount: report.integrity.rawEventCount,
        dataLossAssessment: report.integrity.dataLossAssessment,
        captureStatus: report.integrity.captureStatus,
        captureValid: report.integrity.captureValid,
        captureInvalidReasons: report.integrity.captureInvalidReasons,
      },
      coverage: report.coverage,
      threads: threads.slice(0, threadLimit).map((thread) => ({
        pid: thread.pid,
        tid: thread.tid,
        name: this.text(thread.name, 256),
        isMainThread: thread.isMainThread ?? false,
        eventCount: thread.eventCount,
        selectedEventCount: thread.selectedEventCount,
        taskTimeMs: thread.taskTimeMs,
        longTaskCount: thread.longTaskCount,
        blockingTimeMs: thread.blockingTimeMs,
        sampleCount: thread.sampling?.sampleCount ?? 0,
        activityAvailability: thread.activityAvailability,
      })),
      javascriptHotspots: hotspots.slice(0, hotspotLimit),
      javascriptHotspotsByTotal: [...hotspots].sort((a, b) => b.totalMs - a.totalMs).slice(0, hotspotLimit),
      hotspotMeaning: "selfMs excludes child calls; totalMs includes child calls and overlaps other rows. Rankings use the bounded native Bottom-up roots saved in this report.",
      marks: report.marks.slice(0, 50),
      longTasks: longTasks.slice(0, detailLimit),
      network: {
        requestCount: requests.length,
        webSocketCount: report.network.webSockets.length,
        scope: report.network.scope,
        interpretation: report.network.intervalMeaning,
        slowestRequests: requests.slice(0, detailLimit).map((request) => ({
          url: this.text(request.url),
          statusCode: request.statusCode,
          resourceType: request.resourceType,
          startMs: request.startMs,
          durationMs: request.durationMs,
          selectedDurationMs: request.selectedDurationMs,
          encodedDataLength: request.encodedDataLength,
          frameId: request.frameId,
        })),
      },
      gc: {
        eventCount: report.gc.events.length,
        threadTimeMs: [...report.gc.threadTimeMs]
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, threadLimit),
        meaning: report.gc.meaning,
      },
      insights: {
        scope: report.insights.scope,
        setCount: report.insights.sets.length,
        modelStates: insightStates,
        errorCount: insightErrorCount,
        findings: insightFindings.slice(0, detailLimit),
      },
      truncation: {
        summaryThreadsOmitted: Math.max(0, threads.length - threadLimit),
        javascriptHotspotsOmitted: Math.max(0, hotspots.length - hotspotLimit),
        longTasksOmitted: Math.max(0, longTasks.length - detailLimit),
        requestsOmitted: Math.max(0, requests.length - detailLimit),
        gcThreadsOmitted: Math.max(
          0,
          report.gc.threadTimeMs.length - threadLimit,
        ),
        insightFindingsOmitted: Math.max(
          0,
          insightFindings.length - detailLimit,
        ),
        textValuesShortened: this.truncatedTextCount,
        nativeTrees: treeTruncation,
        note: "Summary limits affect presentation only. Native tree limits also apply to report.json; raw trace events remain unchanged. Call-tree descendants are deferred unless --expand-call-tree is requested. Bottom-up reports function totals without expanding caller chains. Thread times overlap and must not be added into page elapsed time.",
      },
    };
  }
}

export function resolvePerformanceWindow(parsedTrace, options, capture) {
    const resolved = { ...options };
    const frameId = resolved.frameId ?? capture?.mainFrameId ?? parsedTrace.data.Meta.mainFrameId;
    for (const [key, boundary] of [["startMark", "startMs"], ["endMark", "endMs"]]) {
      if (options[key] === undefined) continue;
      if (options[boundary] !== undefined) throw new Error(`Use ${key} or ${boundary}, not both.`);
      const matches = parsedTrace.data.UserTimings.performanceMarks.filter(event =>
        event.name === options[key] && (!event.args?.data?.frame || event.args.data.frame === frameId));
      if (matches.length !== 1) throw new Error(`${key} must identify exactly one native performance mark; found ${matches.length}: ${options[key]}`);
      resolved[boundary] = (matches[0].ts - parsedTrace.data.Meta.traceBounds.min) / 1000;
    }
    return resolved;
  }

/** Self-contained expression evaluated in the native DevTools frontend. */
export function browserAnalysisSource() {
  const declarations = [
    finiteNumber, eventEnd, overlap, unionDuration, frameIdsFromCapture,
    nativeNodeSummary, serializeNativeTree, NativePerformanceAnalysis,
    PerformanceSummary, resolvePerformanceWindow,
  ].map(declaration => declaration.toString()).join("\n");
  return `(() => {\n${declarations}\nreturn { NativePerformanceAnalysis, PerformanceSummary, resolvePerformanceWindow };\n})()`;
}
