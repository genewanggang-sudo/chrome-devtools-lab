const TRACE_START_EVENT_NAME = "TracingStartedInBrowser";
const PIPELINE_EVENT_NAME = "Graphics.Pipeline";
const PIPELINE_CATEGORY = "graphics.pipeline";
const DRAW_AND_SWAP_STEP = "STEP_DRAW_AND_SWAP";
const SUBMIT_COMPOSITOR_FRAME_STEP = "STEP_SUBMIT_COMPOSITOR_FRAME";
const SURFACE_AGGREGATION_STEP = "STEP_SURFACE_AGGREGATION";
const MIN_COMPOSITOR_SWAP_EVENTS = 1;
const MAX_COMPOSITOR_GAP_MS = 250;
const TRACE_TIMESTAMP_EVENT_NAME = "TimeStamp";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function traceId(value) {
  if (typeof value === "string" && value.length > 0) return value;
  // Reject already-rounded IDs instead of binding an unrelated surface.
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

function eventName(event) {
  return typeof event?.name === "string" ? event.name : "(unnamed)";
}

function eventTimestamp(event) {
  return finiteNumber(event?.ts);
}

function eventCategories(event) {
  if (typeof event?.cat !== "string") return new Set();
  return new Set(
    event.cat
      .split(",")
      .map((category) => category.trim())
      .filter(Boolean),
  );
}

function pipelineStep(event) {
  return typeof event?.args?.chrome_graphics_pipeline?.step === "string"
    ? event.args.chrome_graphics_pipeline.step
    : null;
}

function inWindow(event, window) {
  if (!window?.applied) return true;
  const timestamp = eventTimestamp(event);
  return (
    timestamp !== null &&
    timestamp >= Number(window.startUs) &&
    timestamp <= Number(window.endUs)
  );
}

function timestampMessage(event) {
  const data = event?.args?.data;
  if (typeof data?.message === "string") return data.message;
  if (typeof event?.args?.message === "string") return event.args.message;
  return null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * fraction),
  );
  return sorted[index];
}

export function summarizeFrameTimestamps(timestamps) {
  const sorted = uniqueSorted(timestamps);
  const intervalsMs = [];
  for (let index = 1; index < sorted.length; index += 1) {
    intervalsMs.push((sorted[index] - sorted[index - 1]) / 1000);
  }
  const elapsedMs = sorted.length > 1 ? (sorted.at(-1) - sorted[0]) / 1000 : 0;
  return {
    timestampCount: sorted.length,
    elapsedMs,
    meanFps: elapsedMs > 0 ? ((sorted.length - 1) * 1000) / elapsedMs : null,
    p50FrameIntervalMs: quantile(intervalsMs, 0.5),
    p95FrameIntervalMs: quantile(intervalsMs, 0.95),
    maxFrameIntervalMs:
      intervalsMs.length > 0 ? Math.max(...intervalsMs) : null,
    longFrameCount: intervalsMs.filter((value) => value > 16.667).length,
    intervalsMs,
  };
}

export async function readTargetFrameTree(session) {
  try {
    const response = await session.send("Page.getFrameTree");
    return { ...response, observedAtEpochMs: Date.now() };
  } catch (error) {
    return {
      frameTree: null,
      observedAtEpochMs: Date.now(),
      error: String(error?.message ?? error),
    };
  }
}

function frameTreeSnapshot(response) {
  const frames = [];
  const invalidReasons = [];
  const seen = new Set();
  const visit = (tree, parentId) => {
    const frame = tree?.frame;
    if (
      typeof frame?.id !== "string" ||
      frame.id.length === 0 ||
      typeof frame.loaderId !== "string" ||
      seen.has(frame.id)
    ) {
      invalidReasons.push("invalid-or-duplicate-frame-record");
      return;
    }
    seen.add(frame.id);
    if (frame.parentId !== undefined && frame.parentId !== parentId)
      invalidReasons.push(`frame-parent-mismatch:${frame.id}`);
    frames.push({
      id: frame.id,
      parentId,
      loaderId: frame.loaderId,
      url: typeof frame.url === "string" ? frame.url : null,
    });
    if (tree.childFrames !== undefined && !Array.isArray(tree.childFrames)) {
      invalidReasons.push(`invalid-child-frame-list:${frame.id}`);
      return;
    }
    for (const child of tree.childFrames ?? []) visit(child, frame.id);
  };
  if (response?.error)
    invalidReasons.push(`page-frame-tree-error:${response.error}`);
  visit(response?.frameTree, null);
  return { rootFrameId: frames[0]?.id ?? null, frames, invalidReasons };
}

export function buildTargetFrameBinding(targetId, before, after) {
  const beforeSnapshot = frameTreeSnapshot(before);
  const afterSnapshot = frameTreeSnapshot(after);
  const invalidReasons = [
    ...beforeSnapshot.invalidReasons.map((reason) => `before:${reason}`),
    ...afterSnapshot.invalidReasons.map((reason) => `after:${reason}`),
  ];
  if (typeof targetId !== "string" || targetId.length === 0)
    invalidReasons.push("target-id-missing");
  if (beforeSnapshot.rootFrameId !== afterSnapshot.rootFrameId)
    invalidReasons.push("target-root-frame-changed");
  const beforeFrames = new Map(
    beforeSnapshot.frames.map((frame) => [frame.id, frame]),
  );
  const afterFrames = new Map(
    afterSnapshot.frames.map((frame) => [frame.id, frame]),
  );
  if (
    beforeFrames.size !== afterFrames.size ||
    [...beforeFrames.keys()].some((id) => !afterFrames.has(id))
  )
    invalidReasons.push("target-frame-family-changed");
  for (const [id, frame] of beforeFrames) {
    const next = afterFrames.get(id);
    if (
      next &&
      (frame.parentId !== next.parentId || frame.loaderId !== next.loaderId)
    )
      invalidReasons.push(`target-frame-document-changed:${id}`);
  }
  return {
    source: "Page.getFrameTree",
    targetId,
    rootFrameId: beforeSnapshot.rootFrameId,
    frameIds: [...beforeFrames.keys()],
    valid: invalidReasons.length === 0,
    invalidReasons,
    before,
    after,
  };
}

export function resolveTargetFrameBinding(targetId, frameBinding = null) {
  if (targetId === null)
    return {
      valid: true,
      source: "all-trace",
      targetId,
      rootFrameId: null,
      frameIds: [],
      invalidReasons: [],
      assumption: null,
    };
  if (frameBinding === null || frameBinding === undefined)
    return {
      valid: false,
      source: "legacy-unverified-target-id-assumption",
      targetId,
      rootFrameId: targetId,
      frameIds: [],
      invalidReasons: ["target-frame-binding-missing"],
      assumption:
        "targetId equals rootFrameId; diagnostic only, not confirmed ownership",
    };
  const checked = buildTargetFrameBinding(
    targetId,
    frameBinding.before,
    frameBinding.after,
  );
  if (frameBinding.source !== "Page.getFrameTree")
    checked.invalidReasons.push("target-frame-binding-source-invalid");
  if (frameBinding.targetId !== targetId)
    checked.invalidReasons.push("target-frame-binding-target-mismatch");
  if (frameBinding.rootFrameId !== checked.rootFrameId)
    checked.invalidReasons.push("target-frame-binding-root-mismatch");
  if (frameBinding.valid !== true)
    checked.invalidReasons.push("target-frame-binding-not-confirmed");
  checked.valid = checked.invalidReasons.length === 0;
  return {
    ...checked,
    rootFrameId: checked.valid ? checked.rootFrameId : null,
    assumption: null,
  };
}

/** The second argument is a Page frame ID, never an unverified CDP target ID. */
export function findTargetFrames(events, targetId) {
  if (typeof targetId !== "string" || targetId.length === 0) return [];
  const frames = new Map();
  for (const event of events) {
    if (
      eventName(event) !== TRACE_START_EVENT_NAME ||
      !isObject(event.args?.data) ||
      !Array.isArray(event.args.data.frames)
    ) {
      continue;
    }
    for (const frame of event.args.data.frames) {
      if (typeof frame?.frame === "string") frames.set(frame.frame, frame);
    }
  }
  const targetFrames = new Set([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const frame of frames.values()) {
      if (targetFrames.has(frame.parent) && !targetFrames.has(frame.frame)) {
        targetFrames.add(frame.frame);
        changed = true;
      }
    }
  }
  return [...frames.values()].filter((frame) => targetFrames.has(frame.frame));
}

export function findTargetRendererProcesses(events, targetId) {
  const processIds = new Set();
  for (const frame of findTargetFrames(events, targetId)) {
    if (
      Number.isInteger(Number(frame.processId)) &&
      Number(frame.processId) > 0
    )
      processIds.add(Number(frame.processId));
  }
  return [...processIds].sort((left, right) => left - right);
}

function findAmbiguousRendererProcesses(events, targetId, rendererProcessIds) {
  if (targetId === null) return [];
  const targetFrameIds = new Set(
    findTargetFrames(events, targetId).map((frame) => frame.frame),
  );
  const processIds = new Set(rendererProcessIds);
  const ambiguous = new Set();
  for (const event of events) {
    if (
      eventName(event) !== TRACE_START_EVENT_NAME ||
      !Array.isArray(event.args?.data?.frames)
    )
      continue;
    for (const frame of event.args.data.frames) {
      const processId = Number(frame?.processId);
      if (processIds.has(processId) && !targetFrameIds.has(frame?.frame))
        ambiguous.add(processId);
    }
  }
  return [...ambiguous].sort((left, right) => left - right);
}

export function findTraceWindow(
  events,
  { startLabel, endLabel, targetId = null, frameBinding = null } = {},
) {
  const binding = resolveTargetFrameBinding(targetId, frameBinding);
  const rendererProcessIds = new Set(
    findTargetRendererProcesses(events, binding.rootFrameId),
  );
  const marker = (label) =>
    events
      .filter(
        (event) =>
          ((eventName(event) === TRACE_TIMESTAMP_EVENT_NAME &&
            timestampMessage(event) === label) ||
            eventName(event) === label) &&
          (targetId === null || rendererProcessIds.has(Number(event.pid))),
      )
      .map(eventTimestamp)
      .filter((value) => value !== null)
      .sort((left, right) => left - right)[0] ?? null;
  const startUs = marker(startLabel);
  const endUs = marker(endLabel);
  if (
    !binding.valid ||
    startUs === null ||
    endUs === null ||
    endUs <= startUs
  ) {
    return {
      applied: false,
      startUs: null,
      endUs: null,
      source: !binding.valid
        ? "target-frame-binding-invalid"
        : "missing-trace-timestamp-markers",
      invalidReasons: binding.invalidReasons,
      startLabel,
      endLabel,
    };
  }
  return {
    applied: true,
    startUs,
    endUs,
    source: "console.timeStamp/performance.mark",
    startLabel,
    endLabel,
  };
}

function collectTargetSurfaceTraceIds(events, rendererProcessIds, window) {
  const processSet = new Set(rendererProcessIds);
  const ids = new Set();
  for (const event of events) {
    if (
      eventName(event) !== PIPELINE_EVENT_NAME ||
      pipelineStep(event) !== SUBMIT_COMPOSITOR_FRAME_STEP ||
      !processSet.has(Number(event.pid)) ||
      !inWindow(event, window)
    ) {
      continue;
    }
    const value = traceId(
      event.args?.chrome_graphics_pipeline?.surface_frame_trace_id,
    );
    if (value !== null) ids.add(value);
  }
  return ids;
}

function collectTargetDisplayTraceIds(
  events,
  targetSurfaceTraceIds,
  rendererProcessIds,
) {
  const displayIds = new Set();
  const sources = new Set();
  const processIds = new Set(rendererProcessIds);
  for (const event of events) {
    const reporter = event?.args?.frame_reporter;
    if (
      eventName(event) === "PipelineReporter" &&
      event.ph === "b" &&
      processIds.has(Number(event.pid)) &&
      reporter?.state === "STATE_PRESENTED_ALL" &&
      targetSurfaceTraceIds.has(traceId(reporter.surface_frame_trace_id))
    ) {
      const displayId = traceId(reporter.display_trace_id);
      if (displayId !== null) {
        displayIds.add(displayId);
        sources.add("PipelineReporter.STATE_PRESENTED_ALL");
      }
    }
    const pipeline = event?.args?.chrome_graphics_pipeline;
    if (
      eventName(event) === PIPELINE_EVENT_NAME &&
      pipeline?.step === SURFACE_AGGREGATION_STEP &&
      Array.isArray(pipeline.aggregated_surface_frame_trace_ids) &&
      pipeline.aggregated_surface_frame_trace_ids.some((value) =>
        targetSurfaceTraceIds.has(traceId(value)),
      )
    ) {
      const displayId = traceId(pipeline.display_trace_id);
      if (displayId !== null) {
        displayIds.add(displayId);
        sources.add("Graphics.Pipeline.STEP_SURFACE_AGGREGATION");
      }
    }
  }
  return { displayIds, sources };
}

export function collectCompositorSwapEvents(
  events,
  { targetId = null, window = { applied: false }, frameBinding = null } = {},
) {
  const resolvedFrameBinding = resolveTargetFrameBinding(
    targetId,
    frameBinding,
  );
  const rootFrameId = resolvedFrameBinding.rootFrameId;
  const rendererProcessIds = findTargetRendererProcesses(events, rootFrameId);
  const traceFrameIds = new Set(
    findTargetFrames(events, rootFrameId).map((frame) => frame.frame),
  );
  const targetFrameCorrelationInvalidReasons = [];
  if (targetId !== null && resolvedFrameBinding.valid) {
    const capturedIds = new Set(resolvedFrameBinding.frameIds);
    for (const id of capturedIds)
      if (!traceFrameIds.has(id))
        targetFrameCorrelationInvalidReasons.push(
          `captured-frame-missing-from-trace:${id}`,
        );
    for (const id of traceFrameIds)
      if (!capturedIds.has(id))
        targetFrameCorrelationInvalidReasons.push(
          `uncaptured-target-frame-in-trace:${id}`,
        );
  }
  const ambiguousRendererProcessIds = findAmbiguousRendererProcesses(
    events,
    rootFrameId,
    rendererProcessIds,
  );
  // Submit events identify a process and surface, not the owning document.
  // A shared renderer cannot certify an exact target even if one surface maps
  // cleanly to a display; that surface may belong to the unrelated document.
  const targetSurfaceTraceIds =
    ambiguousRendererProcessIds.length > 0 ||
    targetFrameCorrelationInvalidReasons.length > 0
      ? new Set()
      : collectTargetSurfaceTraceIds(events, rendererProcessIds, window);
  const targetDisplays = collectTargetDisplayTraceIds(
    events,
    targetSurfaceTraceIds,
    rendererProcessIds,
  );
  const candidates = events.filter(
    (event) =>
      eventName(event) === PIPELINE_EVENT_NAME &&
      eventCategories(event).has(PIPELINE_CATEGORY) &&
      pipelineStep(event) === DRAW_AND_SWAP_STEP &&
      inWindow(event, window),
  );
  const selected = candidates.filter((event) =>
    targetId === null
      ? true
      : targetDisplays.displayIds.has(
          traceId(event.args?.chrome_graphics_pipeline?.display_trace_id),
        ),
  );
  const timestamps = uniqueSorted(
    selected.map(eventTimestamp).filter((value) => value !== null),
  );
  return {
    candidates,
    selected,
    timestamps,
    rendererProcessIds,
    ambiguousRendererProcessIds,
    frameBinding: resolvedFrameBinding,
    targetFrameCorrelationInvalidReasons,
    targetSurfaceTraceIds: [...targetSurfaceTraceIds],
    targetDisplayTraceIds: [...targetDisplays.displayIds],
    targetCorrelationSources: [...targetDisplays.sources],
    binding:
      targetId === null
        ? "all-trace"
        : ambiguousRendererProcessIds.length > 0
          ? "ambiguous-renderer-pid"
          : targetSurfaceTraceIds.size > 0 && targetDisplays.displayIds.size > 0
            ? "surface-trace-id"
            : "renderer-pid",
    targetBound: targetId === null || rendererProcessIds.length > 0,
  };
}

export function assessCompositorSwaps(collection, window = { applied: false }) {
  const summary = summarizeFrameTimestamps(collection.timestamps);
  const invalidReasons = [];
  invalidReasons.push(...(collection.frameBinding?.invalidReasons ?? []));
  invalidReasons.push(
    ...(collection.targetFrameCorrelationInvalidReasons ?? []),
  );
  if (typeof window?.applied !== "boolean") {
    invalidReasons.push("compositor-window-contract-missing");
  }
  if (collection.targetBound !== true) {
    invalidReasons.push("compositor-target-renderer-not-found");
  }
  if (collection.ambiguousRendererProcessIds?.length > 0) {
    invalidReasons.push(
      `compositor-target-renderer-shared-with-unrelated-frame:${collection.ambiguousRendererProcessIds.join(",")}`,
    );
  }
  if (
    collection.binding === "renderer-pid" &&
    collection.targetSurfaceTraceIds.length === 0
  ) {
    invalidReasons.push("compositor-surface-trace-id-missing");
  }
  if (
    collection.binding !== "all-trace" &&
    collection.targetDisplayTraceIds?.length === 0
  ) {
    invalidReasons.push("compositor-surface-to-display-correlation-missing");
  }
  const requiredEventCount = window?.applied ? MIN_COMPOSITOR_SWAP_EVENTS : 2;
  if (summary.timestampCount < requiredEventCount) {
    invalidReasons.push(
      `compositor-frame-count:${summary.timestampCount} usable draw/swap events; at least ${requiredEventCount} required`,
    );
  }
  const windowDurationMs = window?.applied
    ? (Number(window.endUs) - Number(window.startUs)) / 1000
    : null;
  const averageFpsOverWindow =
    windowDurationMs !== null && windowDurationMs > 0
      ? (summary.timestampCount * 1000) / windowDurationMs
      : summary.meanFps;
  let leadingGapMs = null;
  let trailingGapMs = null;
  if (window?.applied && summary.timestampCount > 0) {
    leadingGapMs =
      (summaryFrameFirst(collection.timestamps) - window.startUs) / 1000;
    trailingGapMs =
      (window.endUs - summaryFrameLast(collection.timestamps)) / 1000;
  }
  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
    leadingWindowGapMs: leadingGapMs,
    trailingWindowGapMs: trailingGapMs,
    source: "chrome-trace.graphics.pipeline.STEP_DRAW_AND_SWAP",
    isFinalDisplayPresentFps: false,
    windowDurationMs,
    averageFps: averageFpsOverWindow,
    averageFpsDefinition:
      windowDurationMs === null
        ? "inter-frame-timestamp-cadence"
        : "draw-and-swap-events-divided-by-wheel-window-duration",
    cadenceGapExceedsThreshold:
      summary.maxFrameIntervalMs !== null &&
      summary.maxFrameIntervalMs > MAX_COMPOSITOR_GAP_MS,
    ...summary,
  };
}

function summaryFrameFirst(timestamps) {
  return uniqueSorted(timestamps)[0] ?? null;
}

function summaryFrameLast(timestamps) {
  const sorted = uniqueSorted(timestamps);
  return sorted.at(-1) ?? null;
}

export function analyzeCompositorFps(
  events,
  { targetId = null, window = { applied: false }, frameBinding = null } = {},
) {
  const collection = collectCompositorSwapEvents(events, {
    targetId,
    window,
    frameBinding,
  });
  return {
    ...assessCompositorSwaps(collection, window),
    candidateEventCount: collection.candidates.length,
    eventCount: collection.selected.length,
    rendererProcessIds: collection.rendererProcessIds,
    targetSurfaceTraceIds: collection.targetSurfaceTraceIds,
    targetDisplayTraceIds: collection.targetDisplayTraceIds,
    targetCorrelationSources: collection.targetCorrelationSources,
    targetBinding: collection.binding,
    targetId,
    frameBinding: collection.frameBinding,
  };
}

export const compositorFrameRateContract = Object.freeze({
  eventName: PIPELINE_EVENT_NAME,
  category: PIPELINE_CATEGORY,
  step: DRAW_AND_SWAP_STEP,
  minimumEventCount: MIN_COMPOSITOR_SWAP_EVENTS,
  maximumGapMs: MAX_COMPOSITOR_GAP_MS,
  source: "Chrome GPU/Viz compositor trace",
  finalDisplayPresent: false,
});
