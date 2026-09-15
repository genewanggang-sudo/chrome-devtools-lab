---
name: chrome-performance-lab
description: Profile and compare Chrome rendering, WebGL, scrolling, zoom, input latency, JavaScript, compositor, GPU, and presentation performance with repeatable evidence. Use when FPS is disputed, browser traces are needed, draw calls must be compared, or a bottleneck must be attributed before changing production code.
---

# Chrome Performance Lab

## Locating the bundled scripts

The bundled scripts live in `scripts/` at the plugin root. Resolve them
relative to this SKILL.md file: `<this-skill-directory>/../../scripts/`.
Both Codex and ZCode install the plugin with `skills/` and `scripts/`
co-located, so the relative path is host-independent. In the examples
below, `<plugin-root>` stands for the resolved plugin root directory (the
parent of `skills/`).

Use this skill for performance diagnosis. Do not reduce the task to a single
page timer or a single FPS sample.

## Evidence layers

Keep these layers separate:

| Layer            | Tool                                       | What it proves                                                   |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Input            | direct CDP `wheel-probe`, `pointer`        | exact target, native CDP event, trusted delivery                 |
| Page diagnostics | MCP console/network/snapshot plus page runtime snapshot | page state, errors, requests, DOM/UI state, heap/DOM/resource/runtime deltas |
| CPU              | `capture-cpu-profile.mjs` + `analyze-cpu-profile.mjs` (V8 profile) | function-level self/total time, hot source locations, flame graph |
| Line frequency   | `capture-cpu-profile.mjs --coverage`       | statement-level execution counts per line (not time)             |
| Trace            | `capture-trace.mjs` + `analyze-trace.mjs`  | compositor work, long tasks, target-correlated browser display cadence |
| System GPU       | WPR/GPUView                                | queue, GPU scheduling, Present/DWM attribution                   |
| WebGL work       | app instrumentation or a graphics debugger | draw calls, passes, state changes, GPU workload                  |

Do not call rAF FPS, screencast FPS, draw-call count, or GPU utilization by
itself "real FPS". The plugin reports separate frame-rate layers:
`frameRate.compositor` from Chrome's `Graphics.Pipeline` /
`STEP_DRAW_AND_SWAP`, target-correlated browser presentation cadence from
`Display::FrameDisplayed`, and optional Windows ETW/DWM data from PresentMon.
Keep those values separate; browser presentation cadence is the numeric Chrome
trace counterpart to the DevTools FPS workflow, but it is not an independent
physical-monitor measurement.

## Test contract

Before sampling, record and freeze:

- browser build, plugin version, application revision, and GPU/driver state;
- exact target IDs and whether the target is visible, background, or leased;
- canvas CSS dimensions, device pixel ratio, viewport, window geometry, and
  model/camera state;
- warm-up duration, input coordinates, delta sequence, event count, interval,
  direction, sample duration, and settle time;
- instrumentation state. Disable tracing, overlays, draw-call logging, and
  DevTools panels for the final KPI sample unless the contract explicitly
  measures that overhead.

## Automatic FPS workflow

When the user asks for FPS, frame rate, scrolling performance, wheel zoom
performance, or a local-versus-reference performance comparison, treat that as
an instruction to run the FPS workflow. Enable Chrome's native DevTools FPS
counter with `--show-fps-counter` during the interaction unless the user
explicitly disables the visible overlay. Keep the same overlay state on every
compared target.

For a repeatable two-target comparison, place exact URLs, readiness checks,
setup actions, and the sample contract in an application-owned scenario JSON:

```powershell
node scripts/compare-wheel.mjs --config <absolute-scenario.json> --output-dir <evidence-dir>
```

The plugin contains no site presets, URL heuristics, menu selectors, or loader
logic. The scenario must explicitly select `windows-native` when the physical
Windows wheel path is required and must define any application readiness beyond
a visible Canvas. Windows routes this input to the foreground render widget,
so targets are activated and sampled sequentially. The plugin locks the cursor
only for each measurement window and restores the previous clipping range.

After a strict run has refreshed and aligned both targets, a single rapid
follow-up can use `--reuse-ready-state`. It rebinds exact targets and repeats
visible-surface, canvas/DPR, and paired-anchor gates, but skips reload/resize.
It is explicitly a prepared-state sample, not a fresh-reload comparison; it
cannot retry after input because wheel interaction can change the camera state.

If its minimal FPS trace lacks complete target-correlated display evidence,
the runner preserves the input and visual sample but marks the browser
presentation metric invalid. It neither repeats a slow full trace implicitly
nor fills the gap with rAF or the visual overlay value. Run an explicit full
trace profile only after reading the recorded failure reason.

Use `--skip-midpoint-screenshot` for numeric trace samples so
`Page.captureScreenshot` cannot stall the measured wheel window. Run visual
input proof as a separate preflight, or use the post-window canvas hash recorded
by the benchmark. The result must report
`visualChange.measurementWindowContainsCanvasScreenshot=false` before it is
accepted as a numeric sample.

For local-versus-reference comparisons, alternate targets and use the same
state reset, fit, camera, anchor, input, and duration for every round. Reject
samples that violate any part of the contract instead of averaging them in.

## Recommended sequence

1. Use the MCP performance category for an exploratory trace or page-level
   diagnosis. Discover the available trace tools from the connected MCP
   server; do not assume a tool is available when the server was configured
   without its category.
2. Bind the exact target with direct CDP and run a strict input/visual probe.
3. Capture a trace on a disposable or controlled target:

   ```powershell
   node "<plugin-root>\scripts\capture-trace.mjs" `
     --target-exact "TARGET_ID" --duration 5000 `
     --output "$env:TEMP\chrome-trace.json"
   ```

   For a real wheel sample with input and trace bound to one target, use the
   plugin's combined sampler. It does not report GPU FPS by itself:

   ```powershell
  node "<plugin-root>\scripts\wheel-benchmark.mjs" `
    --target-exact "TARGET_ID" --x 768 --y 504 --count 120 `
    --duration 2000 --delta-y 40 `
    --input-backend windows-native --legacy-mousewheel-bridge `
    --show-fps-counter --fps-counter-hold 10000 `
    --skip-midpoint-screenshot `
    --expected-dpr 1 --expected-viewport-width 1192 `
    --expected-viewport-height 1028 --expected-canvas-x 0 `
    --expected-canvas-y 0 --expected-canvas-width 1192 `
    --expected-canvas-height 1028 `
    --output "$env:TEMP\wheel-sample.json" `
    --trace-output "$env:TEMP\wheel-sample.trace.json"
  ```

  `--show-fps-counter` shows Chrome's own DevTools FPS overlay during the native
  wheel operation and is the default for FPS-keyword requests. The overlay exists
  only for the benchmark's CDP session and is removed when the sample ends.
  Use `--fps-counter-hold <milliseconds>` to keep that same session alive
  after the sample so an operator can inspect the visible result; the hold is
  after trace collection and is not part of the wheel timing window.
  It is a visual Chrome overlay, not a numeric CDP response; the benchmark
  records that it was enabled and keeps its trace-derived numeric metrics
  separate.

  The expected DPR, viewport, and canvas rectangle are required. Use each
  target's own page coordinates and viewport values; do not reuse another
  target's page origin. Analyze the saved trace separately and pass the
  combined sample as the capture sidecar. The analyzer automatically uses
  `capture-result.trace.frameRateWindow`; explicit `--window-start-us` and
  `--window-end-us` still take precedence.

4. Analyze it:

   ```powershell
  node "<plugin-root>\scripts\analyze-trace.mjs" `
    --input "$env:TEMP\wheel-sample.trace.json" `
    --capture-result "$env:TEMP\wheel-sample.json" `
    --output "$env:TEMP\chrome-trace-summary.json"
   ```

   The analyzed trace reports `Display::FrameDisplayed` only when the event
   density, trace integrity, and target correlation gates pass. For an optional
   independent Windows ETW/DWM cross-check around the same wheel operation:

   ```powershell
   node "<plugin-root>\scripts\present-fps.mjs" wheel `
     --target-exact "TARGET_ID" --x 768 --y 504 --count 120 `
     --duration 2000 --delta-y 40 --expected-dpr 1 `
     --expected-viewport-width 1192 --expected-viewport-height 1028 `
     --expected-canvas-x 0 --expected-canvas-y 0 `
     --expected-canvas-width 1192 --expected-canvas-height 1028
   ```

   This optional command requires Windows Performance Log Users/admin access.
   A permission failure blocks only the independent system-level cross-check;
   it does not invalidate already qualified Chrome trace presentation data and
   is never replaced with rAF or compositor cadence.

5. Inspect input delivery, page runtime deltas, top long tasks,
   compositor/GPU event counts, frame interval distributions, trace integrity,
   and missing evidence. Long-task entries in the trace summary carry
   `args.data` with `functionName`, `url`, and `lineNumber` (DevTools 0-based
   convention) identifying the code that owned the task. Only then choose a
   code path to inspect.
6. Attribute the time inside long tasks with a separate CPU sample:
   `capture-cpu-profile.mjs` (optionally `--reload`, and `--coverage` for
   statement-level execution counts) plus `analyze-cpu-profile.mjs` for
   per-function self/total time, hot source locations, and flame graph output.
   Sampling time is function-level; coverage counts are line-level but are
   frequencies, not time, and inflate timings.
7. Preserve raw trace, summary, contract, invalid reasons, and exact commands
   as evidence. Never overwrite an earlier sample with a rerun.

## Reporting contract

The plugin collects evidence; the calling agent turns it into the
deliverable. The final answer to the user is an analysis, never raw data:

- Lead with the conclusion in the user's language, then the measured numbers
  that support it: long tasks with their owning `functionName`/`url`/`line`,
  hot functions by self time, hot lines by execution count when coverage was
  captured.
- Render the evidence the user cannot read directly: open generated flame
  graph or report HTML in the controlled Chrome, screenshot it, read the
  screenshot, and include the image path in the answer. Do not tell the user
  to open a JSON file to understand the result.
- Keep raw artifacts (trace, cpuprofile, summaries, screenshots) on disk and
  list their paths as supporting evidence, labeled as such.
- Raw JSON is input to the agent's analysis, not the report. If a capture was
  invalid, say why instead of presenting numbers from it.

## Attribution rules

- Long renderer tasks point to CPU/main-thread pressure; use the long task's
  `args.data` stack, the V8 CPU profile, or coverage counts to find the owning
  code. Sampling profiles give per-function time; coverage gives per-line
  execution counts.
- Compositor or renderer frame gaps without long JavaScript tasks require a
  trace/GPU queue check, not a speculative TypeScript optimization.
- High draw calls identify workload volume, not the cause or the achievable
  presentation rate. Compare pass, state, geometry, and instance semantics.
- GPUView can show GPU queue and Present/DWM behavior but cannot identify a
  TypeScript function. Pair it with a Chrome/V8 trace.
- Do not change shader, LOD, pass topology, draw order, VAO/BufferSet, or
  occurrence semantics based only on one count or one screenshot.
