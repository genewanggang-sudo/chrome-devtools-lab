const TRACE_START_EVENT_NAME = "TracingStartedInBrowser";
const PIPELINE_EVENT_NAME = "Graphics.Pipeline";
const PIPELINE_CATEGORY = "graphics.pipeline";
const DRAW_AND_SWAP_STEP = "STEP_DRAW_AND_SWAP";
const SUBMIT_COMPOSITOR_FRAME_STEP = "STEP_SUBMIT_COMPOSITOR_FRAME";
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
  const number = finiteNumber(value);
  return number === null ? null : String(number);
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

function pipelineTraceIds(event) {
  const pipeline = event?.args?.chrome_graphics_pipeline;
  if (!isObject(pipeline)) return [];
  const values = [];
  for (const key of ["surface_frame_trace_id", "display_trace_id"]) {
    const value = traceId(pipeline[key]);
    if (value !== null) values.push(value);
  }
  if (Array.isArray(pipeline.aggregated_surface_frame_trace_ids)) {
    for (const value of pipeline.aggregated_surface_frame_trace_ids) {
      const normalized = traceId(value);
      if (normalized !== null) values.push(normalized);
    }
  }
  return [...new Set(values)];
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
  const elapsedMs =
    sorted.length > 1 ? (sorted.at(-1) - sorted[0]) / 1000 : 0;
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

export function findTargetRendererProcesses(events, targetId) {
  if (typeof targetId !== "string" || targetId.length === 0) return [];
  const processIds = new Set();
  for (const event of events) {
    if (
      eventName(event) !== TRACE_START_EVENT_NAME ||
      !isObject(event.args?.data) ||
      !Array.isArray(event.args.data.frames)
    ) {
      continue;
    }
    for (const frame of event.args.data.frames) {
      if (
        frame?.frame === targetId &&
        Number.isInteger(Number(frame.processId)) &&
        Number(frame.processId) > 0
      ) {
        processIds.add(Number(frame.processId));
      }
    }
  }
  return [...processIds].sort((left, right) => left - right);
}

export function findTraceWindow(
  events,
  { startLabel, endLabel, targetId = null } = {},
) {
  const rendererProcessIds = new Set(
    findTargetRendererProcesses(events, targetId),
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
  if (startUs === null || endUs === null || endUs <= startUs) {
    return {
      applied: false,
      startUs: null,
      endUs: null,
      source: "missing-trace-timestamp-markers",
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
    for (const value of pipelineTraceIds(event)) ids.add(value);
  }
  return ids;
}

function eventBelongsToTarget(event, targetSurfaceTraceIds, rendererProcessIds) {
  const ids = pipelineTraceIds(event);
  if (targetSurfaceTraceIds.size > 0) {
    return ids.some((value) => targetSurfaceTraceIds.has(value));
  }
  return rendererProcessIds.includes(Number(event.pid));
}

export function collectCompositorSwapEvents(
  events,
  { targetId = null, window = { applied: false } } = {},
) {
  const rendererProcessIds = findTargetRendererProcesses(events, targetId);
  const targetSurfaceTraceIds = collectTargetSurfaceTraceIds(
    events,
    rendererProcessIds,
    window,
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
      : eventBelongsToTarget(event, targetSurfaceTraceIds, rendererProcessIds),
  );
  const timestamps = uniqueSorted(
    selected
      .map(eventTimestamp)
      .filter((value) => value !== null),
  );
  return {
    candidates,
    selected,
    timestamps,
    rendererProcessIds,
    targetSurfaceTraceIds: [...targetSurfaceTraceIds],
    binding:
      targetId === null
        ? "all-trace"
        : targetSurfaceTraceIds.size > 0
          ? "surface-trace-id"
          : "renderer-pid",
    targetBound: targetId === null || rendererProcessIds.length > 0,
  };
}

export function assessCompositorSwaps(
  collection,
  window = { applied: false },
) {
  const summary = summarizeFrameTimestamps(collection.timestamps);
  const invalidReasons = [];
  if (typeof window?.applied !== "boolean") {
    invalidReasons.push("compositor-window-contract-missing");
  }
  if (collection.targetBound !== true) {
    invalidReasons.push("compositor-target-renderer-not-found");
  }
  if (
    collection.binding === "renderer-pid" &&
    collection.targetSurfaceTraceIds.length === 0
  ) {
    invalidReasons.push("compositor-surface-trace-id-missing");
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
    leadingGapMs = (summaryFrameFirst(collection.timestamps) - window.startUs) / 1000;
    trailingGapMs = (window.endUs - summaryFrameLast(collection.timestamps)) / 1000;
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
  { targetId = null, window = { applied: false } } = {},
) {
  const collection = collectCompositorSwapEvents(events, { targetId, window });
  return {
    ...assessCompositorSwaps(collection, window),
    candidateEventCount: collection.candidates.length,
    eventCount: collection.selected.length,
    rendererProcessIds: collection.rendererProcessIds,
    targetSurfaceTraceIds: collection.targetSurfaceTraceIds,
    targetBinding: collection.binding,
    targetId,
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
