# Performance Evidence Contract

## Evidence classes

Keep each observation tied to the layer that generated it:

- **Input contract**: direct CDP `Input.dispatchMouseEvent` or pointer/touch
  parameters, page `isTrusted`, target element, coordinates, and event count.
- **Visual response**: before/after screenshot hash or a defined canvas ROI.
- **Scheduler diagnostic**: `requestAnimationFrame` timestamps and long tasks.
- **Trace evidence**: Chrome trace events from renderer, compositor, GPU, and
  presentation paths.
- **System evidence**: WPR/GPUView queue, Present, DWM, and GPU scheduling.
- **Workload evidence**: application draw/pass/state/geometry counters.

Never promote an observation from one class into another. In particular,
requestAnimationFrame and `Page.screencastFrame` do not prove GPU Present FPS.

## Real FPS acceptance

Call a frame-rate result a final-display presentation KPI only when all conditions hold:

1. the input and target contract is valid;
2. the trace is captured over the interaction window without unbounded capture
   gaps or parser errors;
3. the trace contains identifiable compositor/presentation events with usable
   timestamps;
4. the reported count and interval distribution are derived from those events,
   not from rAF or screencast delivery;
5. all compared samples use the same canvas, view, model anchor, browser/GPU
   state, input sequence, warm-up, and reset procedure.

If any condition fails, report `kpi.valid=false` and state the missing evidence.

The plugin also exposes a separate `frameRate.compositor` result from
`Graphics.Pipeline` `STEP_DRAW_AND_SWAP`. This is a real Chrome Viz compositor
draw/swap cadence and is available through CDP trace without kernel tracing
privilege. It answers how many frames Chrome rendered for the operation, but it
is not a DWM/monitor Present rate and must not be renamed to GPU FPS.

When a human-visible check is preferred, pass `--show-fps-counter` to
`wheel-benchmark.mjs`. The benchmark enables Chrome's native
`Overlay.setShowFPSCounter` in the same CDP session as the wheel input, so the
operator sees the same FPS overlay exposed by DevTools. The target must be
visible/foreground. The overlay is session-scoped and is removed when the
sample ends; `--fps-counter-hold <milliseconds>` keeps that session alive for
an operator-visible post-sample interval without extending the wheel timing
window. Chrome does not return that overlay's number through CDP, so the JSON
result records the overlay state but does not pretend it is a numeric API.

For final display FPS, use `scripts/present-fps.mjs wheel ...`. It wraps the
same native wheel operation with PresentMon and derives the average from
displayed ETW frames. PresentMon requires Windows `Performance Log Users` or
administrator access; the command reports that prerequisite instead of
falling back to rAF.

## Trace overhead

Tracing, screenshots, DevTools panels, draw-call logging, and CPU profiles can
change scheduling and GPU workload. Use them to attribute a problem, then run a
separate KPI sample with instrumentation disabled. Keep the raw trace and the
final KPI sample distinct and label both.

## Comparison discipline

For local/reference comparisons:

- alternate the order of targets across at least three rounds;
- reset both to the same standard view and fit state;
- prove the pointer coordinates refer to the same model anchor;
- dispatch the same real CDP wheel sequence;
- record FPS distribution, p95/p99 frame interval, long frames, input count,
  trace evidence, and invalid reasons;
- do not use synthetic DOM events, `window.scrollBy`, asymmetric reloads, or
  stale target IDs as final evidence.
