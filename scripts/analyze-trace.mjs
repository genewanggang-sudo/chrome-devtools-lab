#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  analyzeCompositorFps,
  collectCompositorSwapEvents,
  compositorFrameRateContract,
} from "./frame-rate.mjs";

const PRESENTATION_EVENT_NAME = "Display::FrameDisplayed";
const PRESENTATION_REQUIRED_CATEGORIES = [
  "benchmark",
  "viz",
  "disabled-by-default-display.framedisplayed",
];
const PRESENTATION_PHASE = "I";
const PRESENTATION_SCOPE = "t";
const PRESENTATION_PROCESS_NAME = "GPU Process";
const PRESENTATION_THREAD_NAME = "VizCompositorThread";
const PRESENTATION_MARKER_NAME = "FramePresented";
const MIN_PRESENTATION_EVENTS = 10;
const MAX_PRESENTATION_GAP_MS = 250;
const MAX_PRESENTATION_ALIGNMENT_MS = 50;
const MIN_PRESENTATION_CORRELATION = 0.9;
const TRACE_START_EVENT_NAME = "TracingStartedInBrowser";
const TRACE_START_CATEGORY = "disabled-by-default-devtools.timeline";
const TRACE_LOSS_STAT_PATTERN =
  /data_loss|dataloss|packet_loss|packets_dropped|dropped_packets|chunks_discarded|chunks_overwritten|bytes_overwritten|writer_abort|write_wrap_count|buffer.*overflow|trace.*overflow|parser_error|parse_errors|tokenizer_errors|tokenizer_skipped_packets|truncated|corrupt|final_flush_failed|flushes_failed|invalid_packets/i;
const COMPOSITOR_PATTERN =
  /beginframe|drawframe|submitcompositorframe|activatelayertree|compositorframe/i;
const GPU_PATTERN = /swapbuffers|gputask|raster|gpu\./i;
const LONG_TASK_PATTERN =
  /runtask|functioncall|evaluatescript|eventdispatch|taskqueue|longtask/i;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function numberOption(options, name, fallback) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid --${name}: ${options[name]}`);
  }
  return value;
}

function optionalNumberOption(options, name) {
  if (options[name] == null) return null;
  return numberOption(options, name, null);
}

function parseAnalysisWindow(options) {
  const startUs = optionalNumberOption(options, "window-start-us");
  const endUs = optionalNumberOption(options, "window-end-us");
  if ((startUs === null) !== (endUs === null)) {
    throw new Error(
      "--window-start-us and --window-end-us must be provided together.",
    );
  }
  if (startUs !== null && endUs <= startUs) {
    throw new Error(
      `Invalid analysis window: ${startUs} us through ${endUs} us. The end must be greater than the start.`,
    );
  }
  return {
    applied: startUs !== null,
    startUs,
    endUs,
    source: startUs !== null ? "explicit-cli" : null,
  };
}

function analysisWindowFromCaptureResult(captureResult) {
  const captureWindow = captureResult?.trace?.frameRateWindow;
  if (captureWindow?.applied !== true) {
    return { applied: false, startUs: null, endUs: null, source: null };
  }
  const startUs = Number(captureWindow.startUs);
  const endUs = Number(captureWindow.endUs);
  if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs <= startUs) {
    throw new Error(
      "Invalid capture-result trace.frameRateWindow; expected finite startUs < endUs.",
    );
  }
  return {
    applied: true,
    startUs,
    endUs,
    source: "capture-result.trace.frameRateWindow",
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventName(event) {
  return typeof event?.name === "string" ? event.name : "(unnamed)";
}

function timestamp(event) {
  return Number.isFinite(Number(event?.ts)) ? Number(event.ts) : null;
}

function durationMs(event) {
  return Number.isFinite(Number(event?.dur)) ? Number(event.dur) / 1000 : 0;
}

function categories(event) {
  if (typeof event?.cat !== "string") return new Set();
  return new Set(
    event.cat
      .split(",")
      .map((category) => category.trim())
      .filter(Boolean),
  );
}

function eventInWindow(event, window) {
  if (!window.applied) return true;
  const value = timestamp(event);
  return value !== null && value >= window.startUs && value <= window.endUs;
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

function summarizeIntervals(timestamps) {
  const sorted = [...new Set(timestamps)].sort((left, right) => left - right);
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
  };
}

function metadataNameMaps(events) {
  const processNames = new Map();
  const threadNames = new Map();
  for (const event of events) {
    if (event?.ph !== "M" || typeof event.args?.name !== "string") continue;
    if (event.name === "process_name" && Number.isFinite(Number(event.pid))) {
      processNames.set(Number(event.pid), event.args.name);
    }
    if (
      event.name === "thread_name" &&
      Number.isFinite(Number(event.pid)) &&
      Number.isFinite(Number(event.tid))
    ) {
      threadNames.set(
        `${Number(event.pid)}:${Number(event.tid)}`,
        event.args.name,
      );
    }
  }
  return { processNames, threadNames };
}

function validatePresentationEvent(event, nameMaps) {
  const invalidReasons = [];
  const eventCategories = categories(event);
  for (const category of PRESENTATION_REQUIRED_CATEGORIES) {
    if (!eventCategories.has(category)) {
      invalidReasons.push(`missing-category:${category}`);
    }
  }
  if (event.ph !== PRESENTATION_PHASE) {
    invalidReasons.push(`unexpected-phase:${event.ph ?? "missing"}`);
  }
  if (event.s !== PRESENTATION_SCOPE) {
    invalidReasons.push(`unexpected-scope:${event.s ?? "missing"}`);
  }
  const eventTimestamp = timestamp(event);
  if (eventTimestamp === null || eventTimestamp <= 0) {
    invalidReasons.push("invalid-timestamp");
  }
  if (!Number.isInteger(Number(event.pid)) || Number(event.pid) < 0) {
    invalidReasons.push("invalid-pid");
  }
  if (!Number.isInteger(Number(event.tid)) || Number(event.tid) < 0) {
    invalidReasons.push("invalid-tid");
  }
  if (!isObject(event.args)) invalidReasons.push("invalid-args");
  const processName = nameMaps.processNames.get(Number(event.pid));
  if (processName !== PRESENTATION_PROCESS_NAME) {
    invalidReasons.push(
      `unexpected-process:${processName ?? "missing-metadata"}`,
    );
  }
  const threadName = nameMaps.threadNames.get(
    `${Number(event.pid)}:${Number(event.tid)}`,
  );
  if (threadName !== PRESENTATION_THREAD_NAME) {
    invalidReasons.push(
      `unexpected-thread:${threadName ?? "missing-metadata"}`,
    );
  }
  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
}

function collectPositiveLossStats(value, prefix = "") {
  const findings = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      findings.push(
        ...collectPositiveLossStats(value[index], `${prefix}[${index}]`),
      );
    }
    return findings;
  }
  if (!isObject(value)) return findings;
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    // Perfetto reports chunks discarded while closing a tracing session. This
    // is not buffer loss; the per-buffer data-loss counters remain authoritative.
    if (key === "traced_chunks_discarded") continue;
    if (
      TRACE_LOSS_STAT_PATTERN.test(key) &&
      ((typeof child === "number" && child > 0) || child === true)
    ) {
      findings.push({ path: childPath, value: child });
    }
    if (isObject(child) || Array.isArray(child)) {
      findings.push(...collectPositiveLossStats(child, childPath));
    }
  }
  return findings;
}

function summarizeTraceBuffers(traceProcessorStats) {
  const buffers = Array.isArray(traceProcessorStats?.traced_buf)
    ? traceProcessorStats.traced_buf
    : [];
  return buffers.map((buffer, index) => {
    const bufferSize = Number(buffer?.buffer_size);
    const bytesWritten = Number(buffer?.bytes_written);
    return {
      index,
      bufferSizeBytes: Number.isFinite(bufferSize) ? bufferSize : null,
      bytesWritten: Number.isFinite(bytesWritten) ? bytesWritten : null,
      bytesRead: Number.isFinite(Number(buffer?.bytes_read))
        ? Number(buffer.bytes_read)
        : null,
      writtenToCapacityRatio:
        Number.isFinite(bufferSize) &&
        bufferSize > 0 &&
        Number.isFinite(bytesWritten)
          ? bytesWritten / bufferSize
          : null,
      writeWrapCount: Number.isFinite(Number(buffer?.write_wrap_count))
        ? Number(buffer.write_wrap_count)
        : null,
      bytesOverwritten: Number.isFinite(Number(buffer?.bytes_overwritten))
        ? Number(buffer.bytes_overwritten)
        : null,
      chunksOverwritten: Number.isFinite(Number(buffer?.chunks_overwritten))
        ? Number(buffer.chunks_overwritten)
        : null,
      chunksDiscarded: Number.isFinite(Number(buffer?.chunks_discarded))
        ? Number(buffer.chunks_discarded)
        : null,
    };
  });
}

function assessTraceIntegrity(payload, events, captureResult) {
  const invalidReasons = [];
  const malformedEventCount = events.filter((event) => !isObject(event)).length;
  if (malformedEventCount > 0) {
    invalidReasons.push(
      `trace-malformed-events:${malformedEventCount} event records are not objects`,
    );
  }
  const traceStartEvents = events.filter(
    (event) =>
      event?.name === TRACE_START_EVENT_NAME &&
      categories(event).has(TRACE_START_CATEGORY) &&
      event.ph === "I" &&
      timestamp(event) !== null &&
      isObject(event.args?.data) &&
      Array.isArray(event.args.data.frames),
  );
  if (traceStartEvents.length !== 1) {
    invalidReasons.push(
      `trace-start-contract:${traceStartEvents.length} validated ${TRACE_START_EVENT_NAME} events found`,
    );
  }
  const traceProcessorStats = payload?.metadata?.trace_processor_stats;
  if (!isObject(traceProcessorStats)) {
    invalidReasons.push(
      "trace-integrity-metadata-missing:trace_processor_stats",
    );
  }
  const lossStats = collectPositiveLossStats(traceProcessorStats);
  for (const finding of lossStats) {
    invalidReasons.push(
      `trace-data-loss:${finding.path}=${String(finding.value)}`,
    );
  }

  const captureTrace = captureResult?.trace;
  const captureCompleteness = captureTrace?.completeness;
  const captureBufferUsage = captureTrace?.bufferUsage;
  if (!isObject(captureResult)) {
    invalidReasons.push(
      "capture-result-missing:Tracing.tracingComplete and live buffer usage are unproven",
    );
  } else {
    if (captureResult.valid !== true) {
      invalidReasons.push("capture-contract-invalid:sidecar valid is not true");
    }
    if (!isObject(captureCompleteness)) {
      invalidReasons.push("capture-completeness-missing");
    } else {
      if (captureCompleteness.tracingCompleteReceived !== true) {
        invalidReasons.push("tracing-complete-not-confirmed");
      }
      if (captureCompleteness.dataLossOccurred !== false) {
        invalidReasons.push(
          `tracing-data-loss-uncertain-or-reported:${String(captureCompleteness.dataLossOccurred)}`,
        );
      }
      if (captureCompleteness.bufferCapacityReached !== false) {
        invalidReasons.push(
          `tracing-buffer-capacity-uncertain-or-reached:${String(captureCompleteness.bufferCapacityReached)}`,
        );
      }
      if (captureCompleteness.traceEventArrayPresent !== true) {
        invalidReasons.push("capture-trace-event-array-not-confirmed");
      }
      if (Number(captureCompleteness.traceEventCount) !== events.length) {
        invalidReasons.push(
          `capture-trace-event-count-mismatch:${String(captureCompleteness.traceEventCount)}!=${events.length}`,
        );
      }
      if (captureCompleteness.valid !== true) {
        invalidReasons.push("capture-completeness-invalid");
      }
    }
    if (!isObject(captureBufferUsage)) {
      invalidReasons.push("tracing-buffer-usage-missing");
    } else {
      const sampleCount = Number(captureBufferUsage.sampleCount);
      const maximumPercentFull = Number(captureBufferUsage.maximumPercentFull);
      if (!Number.isInteger(sampleCount) || sampleCount < 1) {
        invalidReasons.push(
          `tracing-buffer-usage-samples-insufficient:${String(captureBufferUsage.sampleCount)}`,
        );
      }
      if (!Number.isFinite(maximumPercentFull)) {
        invalidReasons.push("tracing-buffer-maximum-percent-full-missing");
      } else if (maximumPercentFull >= 1) {
        invalidReasons.push(
          `tracing-buffer-capacity-reached:${maximumPercentFull}`,
        );
      }
    }
  }

  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
    malformedEventCount,
    validatedTraceStartEventCount: traceStartEvents.length,
    traceProcessorStatsPresent: isObject(traceProcessorStats),
    lossStats,
    buffers: summarizeTraceBuffers(traceProcessorStats),
    captureSidecarProvided: isObject(captureResult),
    tracingCompleteReceived:
      captureCompleteness?.tracingCompleteReceived === true,
    dataLossOccurred: captureCompleteness?.dataLossOccurred ?? null,
    liveBufferUsage: isObject(captureBufferUsage) ? captureBufferUsage : null,
  };
}

function assessWindow(window, firstTimestamp, lastTimestamp, eventCount) {
  const invalidReasons = [];
  if (!window.applied) return invalidReasons;
  if (
    firstTimestamp === null ||
    lastTimestamp === null ||
    window.startUs < firstTimestamp ||
    window.endUs > lastTimestamp
  ) {
    invalidReasons.push(
      `analysis-window-outside-trace:${window.startUs}-${window.endUs} us is not contained by ${firstTimestamp ?? "missing"}-${lastTimestamp ?? "missing"} us`,
    );
  }
  if (eventCount === 0) {
    invalidReasons.push(
      "analysis-window-empty:no trace events in requested window",
    );
  }
  return invalidReasons;
}

function assessPresentation(
  presentation,
  validatedEvents,
  rejectedEvents,
  window,
  targetCorrelation,
) {
  const invalidReasons = [];
  if (rejectedEvents.length > 0) {
    invalidReasons.push(
      `presentation-event-contract:${rejectedEvents.length} exact-name events failed validation`,
    );
  }
  if (presentation.timestampCount < MIN_PRESENTATION_EVENTS) {
    invalidReasons.push(
      `presentation-event-count:${presentation.timestampCount} usable events; at least ${MIN_PRESENTATION_EVENTS} required`,
    );
  }
  if (presentation.maxFrameIntervalMs === null) {
    invalidReasons.push(
      `presentation-max-gap:missing ms; limit ${MAX_PRESENTATION_GAP_MS} ms`,
    );
  }
  if (!targetCorrelation.valid) {
    invalidReasons.push(...targetCorrelation.invalidReasons);
    if (
      presentation.maxFrameIntervalMs !== null &&
      presentation.maxFrameIntervalMs > MAX_PRESENTATION_GAP_MS
    ) {
      invalidReasons.push(
        `presentation-max-gap:${presentation.maxFrameIntervalMs} ms; limit ${MAX_PRESENTATION_GAP_MS} ms without target correlation`,
      );
    }
  }
  const lanes = new Set(
    validatedEvents.map((event) => `${Number(event.pid)}:${Number(event.tid)}`),
  );
  if (lanes.size > 1) {
    invalidReasons.push(
      `presentation-lane-ambiguous:${lanes.size} GPU presentation lanes`,
    );
  }
  const presentationTimestamps = validatedEvents
    .map(timestamp)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  let leadingGapMs = null;
  let trailingGapMs = null;
  if (window.applied && presentationTimestamps.length > 0) {
    leadingGapMs = (presentationTimestamps[0] - window.startUs) / 1000;
    trailingGapMs = (window.endUs - presentationTimestamps.at(-1)) / 1000;
    if (leadingGapMs > MAX_PRESENTATION_GAP_MS && !targetCorrelation.valid) {
      invalidReasons.push(
        `presentation-leading-gap:${leadingGapMs} ms; limit ${MAX_PRESENTATION_GAP_MS} ms`,
      );
    }
    if (trailingGapMs > MAX_PRESENTATION_GAP_MS && !targetCorrelation.valid) {
      invalidReasons.push(
        `presentation-trailing-gap:${trailingGapMs} ms; limit ${MAX_PRESENTATION_GAP_MS} ms`,
      );
    }
  }
  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
    laneCount: lanes.size,
    leadingGapMs,
    trailingGapMs,
  };
}

function nearestDistanceMs(sortedTimestamps, targetTimestamp) {
  if (sortedTimestamps.length === 0) return null;
  let low = 0;
  let high = sortedTimestamps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedTimestamps[middle] < targetTimestamp) low = middle + 1;
    else high = middle;
  }
  const candidates = [sortedTimestamps[low - 1], sortedTimestamps[low]].filter(
    (value) => value !== undefined,
  );
  return Math.min(
    ...candidates.map((value) => Math.abs(value - targetTimestamp) / 1000),
  );
}

function assessPresentationTargetCorrelation(
  presentationTimestamps,
  compositorCollection,
) {
  const presentation = [...new Set(presentationTimestamps)].sort(
    (left, right) => left - right,
  );
  const compositor = [...new Set(compositorCollection.timestamps)].sort(
    (left, right) => left - right,
  );
  const presentationOffsets = presentation
    .map((value) => nearestDistanceMs(compositor, value))
    .filter((value) => value !== null);
  const compositorOffsets = compositor
    .map((value) => nearestDistanceMs(presentation, value))
    .filter((value) => value !== null);
  const presentationCoverage =
    presentation.length === 0
      ? 0
      : presentationOffsets.filter(
          (value) => value <= MAX_PRESENTATION_ALIGNMENT_MS,
        ).length / presentation.length;
  const compositorCoverage =
    compositor.length === 0
      ? 0
      : compositorOffsets.filter(
          (value) => value <= MAX_PRESENTATION_ALIGNMENT_MS,
        ).length / compositor.length;
  const invalidReasons = [];
  if (compositorCollection.targetBound !== true) {
    invalidReasons.push("presentation-target-renderer-not-found");
  }
  if (compositorCollection.binding !== "surface-trace-id") {
    invalidReasons.push(
      `presentation-target-binding:${compositorCollection.binding}; expected surface-trace-id`,
    );
  }
  if (presentationCoverage < MIN_PRESENTATION_CORRELATION) {
    invalidReasons.push(
      `presentation-to-compositor-correlation:${presentationCoverage}; minimum ${MIN_PRESENTATION_CORRELATION}`,
    );
  }
  if (compositorCoverage < MIN_PRESENTATION_CORRELATION) {
    invalidReasons.push(
      `compositor-to-presentation-correlation:${compositorCoverage}; minimum ${MIN_PRESENTATION_CORRELATION}`,
    );
  }
  return {
    valid: invalidReasons.length === 0,
    invalidReasons,
    maximumAlignmentMs: MAX_PRESENTATION_ALIGNMENT_MS,
    minimumCoverage: MIN_PRESENTATION_CORRELATION,
    presentationEventCount: presentation.length,
    targetCompositorEventCount: compositor.length,
    presentationCoverage,
    compositorCoverage,
    presentationNearestOffsetP95Ms: quantile(presentationOffsets, 0.95),
    presentationNearestOffsetMaxMs:
      presentationOffsets.length > 0 ? Math.max(...presentationOffsets) : null,
    compositorNearestOffsetP95Ms: quantile(compositorOffsets, 0.95),
    compositorNearestOffsetMaxMs:
      compositorOffsets.length > 0 ? Math.max(...compositorOffsets) : null,
    targetBinding: compositorCollection.binding,
    targetSurfaceTraceIds: compositorCollection.targetSurfaceTraceIds,
  };
}

function topCounts(events, selector, limit = 20) {
  const counts = new Map();
  for (const event of events) {
    if (!selector(event)) continue;
    const name = eventName(event);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function summarizeLongTasks(events, thresholdMs, limit = 25) {
  return events
    .filter(
      (event) =>
        event.ph === "X" &&
        durationMs(event) >= thresholdMs &&
        LONG_TASK_PATTERN.test(eventName(event)),
    )
    .sort((left, right) => durationMs(right) - durationMs(left))
    .slice(0, limit)
    .map((event) => ({
      name: eventName(event),
      category: event.cat || "",
      durationMs: durationMs(event),
      timestampUs: timestamp(event),
      pid: event.pid ?? null,
      tid: event.tid ?? null,
      args: event.args || {},
    }));
}

function analyzeTrace(
  payload,
  thresholdMs,
  requestedWindow,
  captureResult,
  targetId,
) {
  const events = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.traceEvents)
      ? payload.traceEvents
      : null;
  if (!events)
    throw new Error("Input is not a Chrome trace with traceEvents[]");

  const traceTimestamps = events
    .map(timestamp)
    .filter((value) => value !== null && value > 0)
    .sort((left, right) => left - right);
  const firstTimestamp = traceTimestamps[0] ?? null;
  const lastTimestamp = traceTimestamps.at(-1) ?? null;
  const traceDurationMs =
    firstTimestamp !== null && lastTimestamp !== null
      ? (lastTimestamp - firstTimestamp) / 1000
      : null;
  const analysisEvents = events.filter((event) =>
    eventInWindow(event, requestedWindow),
  );
  const windowInvalidReasons = assessWindow(
    requestedWindow,
    firstTimestamp,
    lastTimestamp,
    analysisEvents.length,
  );
  const nameMaps = metadataNameMaps(events);
  const presentationCandidates = analysisEvents.filter(
    (event) => eventName(event) === PRESENTATION_EVENT_NAME,
  );
  const validatedPresentationEvents = [];
  const rejectedPresentationEvents = [];
  for (const event of presentationCandidates) {
    const assessment = validatePresentationEvent(event, nameMaps);
    if (assessment.valid) validatedPresentationEvents.push(event);
    else {
      rejectedPresentationEvents.push({
        timestampUs: timestamp(event),
        pid: event?.pid ?? null,
        tid: event?.tid ?? null,
        invalidReasons: assessment.invalidReasons,
      });
    }
  }
  const presentationMarkers = analysisEvents.filter(
    (event) => eventName(event) === PRESENTATION_MARKER_NAME,
  );
  const compositorEvents = analysisEvents.filter((event) =>
    COMPOSITOR_PATTERN.test(eventName(event)),
  );
  const gpuEvents = analysisEvents.filter((event) =>
    GPU_PATTERN.test(eventName(event)),
  );
  const presentationTimestamps = validatedPresentationEvents
    .map(timestamp)
    .filter((value) => value !== null);
  const presentationIntervals = summarizeIntervals(presentationTimestamps);
  const presentationWindowDurationMs = requestedWindow.applied
    ? (requestedWindow.endUs - requestedWindow.startUs) / 1000
    : null;
  const presentation = {
    windowDurationMs: presentationWindowDurationMs,
    averageFps:
      presentationWindowDurationMs !== null && presentationWindowDurationMs > 0
        ? (presentationIntervals.timestampCount * 1000) /
          presentationWindowDurationMs
        : presentationIntervals.meanFps,
    averageFpsDefinition:
      presentationWindowDurationMs === null
        ? "inter-frame-timestamp-cadence"
        : "frame-displayed-events-divided-by-analysis-window-duration",
    cadenceGapExceedsThreshold:
      presentationIntervals.maxFrameIntervalMs !== null &&
      presentationIntervals.maxFrameIntervalMs > MAX_PRESENTATION_GAP_MS,
    ...presentationIntervals,
  };
  const compositorCollection = collectCompositorSwapEvents(events, {
    targetId,
    window: requestedWindow,
  });
  const compositorFrameRate = analyzeCompositorFps(events, {
    targetId,
    window: requestedWindow,
  });
  const presentationTargetCorrelation = assessPresentationTargetCorrelation(
    presentationTimestamps,
    compositorCollection,
  );
  const traceIntegrity = assessTraceIntegrity(payload, events, captureResult);
  const presentationAssessment = assessPresentation(
    presentation,
    validatedPresentationEvents,
    rejectedPresentationEvents,
    requestedWindow,
    presentationTargetCorrelation,
  );
  const invalidReasons = [
    ...traceIntegrity.invalidReasons,
    ...windowInvalidReasons,
    ...presentationAssessment.invalidReasons,
  ];
  const performanceKpiValid = invalidReasons.length === 0;
  return {
    schemaVersion: 2,
    traceEventCount: events.length,
    analysisEventCount: analysisEvents.length,
    traceCoverage: {
      firstTimestampUs: firstTimestamp,
      lastTimestampUs: lastTimestamp,
      durationMs: traceDurationMs,
    },
    analysisWindow: {
      ...requestedWindow,
      durationMs: requestedWindow.applied
        ? (requestedWindow.endUs - requestedWindow.startUs) / 1000
        : traceDurationMs,
      eventTimestampFilter: "inclusive-start-and-end",
      invalidReasons: windowInvalidReasons,
    },
    traceIntegrity,
    evidence: {
      presentation: {
        sourceEventNames:
          presentationCandidates.length > 0 ? [PRESENTATION_EVENT_NAME] : [],
        candidateEventCount: presentationCandidates.length,
        eventCount: validatedPresentationEvents.length,
        rejectedEventCount: rejectedPresentationEvents.length,
        rejectedEvents: rejectedPresentationEvents,
        requiredContract: {
          exactName: PRESENTATION_EVENT_NAME,
          categories: PRESENTATION_REQUIRED_CATEGORIES,
          phase: PRESENTATION_PHASE,
          scope: PRESENTATION_SCOPE,
          processName: PRESENTATION_PROCESS_NAME,
          threadName: PRESENTATION_THREAD_NAME,
          minimumEventCount: MIN_PRESENTATION_EVENTS,
          maximumGapMs: MAX_PRESENTATION_GAP_MS,
          maximumTargetAlignmentMs: MAX_PRESENTATION_ALIGNMENT_MS,
          minimumTargetCorrelation: MIN_PRESENTATION_CORRELATION,
        },
        targetCorrelation: presentationTargetCorrelation,
        laneCount: presentationAssessment.laneCount,
        leadingWindowGapMs: presentationAssessment.leadingGapMs,
        trailingWindowGapMs: presentationAssessment.trailingGapMs,
        ...presentation,
      },
      presentationMarkers: {
        role: "marker-only-not-used-for-fps",
        eventCount: presentationMarkers.length,
        sourceEventNames:
          presentationMarkers.length > 0 ? [PRESENTATION_MARKER_NAME] : [],
      },
      compositor: {
        eventCount: compositorEvents.length,
        topEvents: topCounts(analysisEvents, (event) =>
          COMPOSITOR_PATTERN.test(eventName(event)),
        ),
      },
      compositorFrameRate,
      gpu: {
        eventCount: gpuEvents.length,
        topEvents: topCounts(analysisEvents, (event) =>
          GPU_PATTERN.test(eventName(event)),
        ),
      },
    },
    performanceKpi: {
      valid: performanceKpiValid,
      fps: performanceKpiValid ? presentation.averageFps : null,
      invalidReasons,
      reason: performanceKpiValid
        ? "Derived from validated, target-correlated Display::FrameDisplayed timestamps over the fixed analysis window in a complete trace."
        : invalidReasons.join("; ") +
          " FramePresented markers, rAF, and screencast are not substituted.",
    },
    frameRate: {
      compositor: compositorFrameRate,
      presentation: {
        valid: performanceKpiValid,
        fps: performanceKpiValid ? presentation.averageFps : null,
        source: "Display::FrameDisplayed",
        isFinalDisplayPresentFps: true,
        averageFpsDefinition: presentation.averageFpsDefinition,
        p95FrameIntervalMs: presentation.p95FrameIntervalMs,
        maxFrameIntervalMs: presentation.maxFrameIntervalMs,
        cadenceGapExceedsThreshold: presentation.cadenceGapExceedsThreshold,
        targetCorrelation: presentationTargetCorrelation,
      },
    },
    longTasks: {
      thresholdMs,
      count: analysisEvents.filter(
        (event) =>
          event.ph === "X" &&
          durationMs(event) >= thresholdMs &&
          LONG_TASK_PATTERN.test(eventName(event)),
      ).length,
      top: summarizeLongTasks(analysisEvents, thresholdMs),
    },
    eventCounts: {
      presentation: topCounts(
        analysisEvents,
        (event) => eventName(event) === PRESENTATION_EVENT_NAME,
      ),
      presentationMarkers: topCounts(
        analysisEvents,
        (event) => eventName(event) === PRESENTATION_MARKER_NAME,
      ),
      compositor: topCounts(analysisEvents, (event) =>
        COMPOSITOR_PATTERN.test(eventName(event)),
      ),
      gpu: topCounts(analysisEvents, (event) =>
        GPU_PATTERN.test(eventName(event)),
      ),
    },
    limitations: [
      "Only validated Display::FrameDisplayed events can produce the presentation KPI; FramePresented is retained as a marker only.",
      `Chrome compositor FPS is derived from ${compositorFrameRateContract.eventName} with step ${compositorFrameRateContract.step}; it is a real compositor draw/swap cadence, not a final DWM/monitor Present rate.`,
      "rAF and screencast delivery are diagnostics and are never treated as GPU or presentation FPS.",
      "A trace presentation KPI is not a substitute for WPR/GPUView when system Present or DWM attribution is required.",
      "Draw-call counts require separate application or graphics instrumentation and are not inferred from trace event counts.",
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options.input !== "string" || options.input.length === 0) {
    throw new Error("Trace analysis requires --input <trace.json>.");
  }
  const thresholdMs = numberOption(options, "long-task-ms", 50);
  const explicitWindow = parseAnalysisWindow(options);
  const targetId =
    typeof options["target-id"] === "string" ? options["target-id"] : null;
  let captureResult = null;
  if (typeof options["capture-result"] === "string") {
    captureResult = JSON.parse(
      await fs.readFile(path.resolve(options["capture-result"]), "utf8"),
    );
  }
  const requestedWindow = explicitWindow.applied
    ? explicitWindow
    : analysisWindowFromCaptureResult(captureResult);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(options.input), "utf8"),
  );
  const summary = analyzeTrace(
    payload,
    thresholdMs,
    requestedWindow,
    captureResult,
    targetId || captureResult?.target?.id || null,
  );
  const output = options.output;
  if (typeof output === "string" && output.length > 0) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(
      path.resolve(output),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ...summary, output: output ? path.resolve(output) : null }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
