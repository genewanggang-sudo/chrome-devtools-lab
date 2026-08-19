---
name: chrome-performance-lab
description: Profile and compare Chrome rendering, WebGL, scrolling, zoom, input latency, JavaScript, compositor, GPU, and presentation performance with repeatable evidence. Use when FPS is disputed, browser traces are needed, draw calls must be compared, or a bottleneck must be attributed before changing production code.
---

# Chrome Performance Lab

Use this skill for performance diagnosis. Do not reduce the task to a single
page timer or a single FPS sample.

## Evidence layers

Keep these layers separate:

| Layer            | Tool                                       | What it proves                                                   |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Input            | direct CDP `wheel-probe`, `pointer`        | exact target, native CDP event, trusted delivery                 |
| Page diagnostics | MCP console/network/snapshot               | page state, errors, requests, DOM/UI state                       |
| CPU              | MCP performance tools or a V8 profile      | JavaScript and renderer CPU attribution                          |
| Trace            | `capture-trace.mjs` + `analyze-trace.mjs`  | compositor, renderer, GPU, frame and present events when present |
| System GPU       | WPR/GPUView                                | queue, GPU scheduling, Present/DWM attribution                   |
| WebGL work       | app instrumentation or a graphics debugger | draw calls, passes, state changes, GPU workload                  |

Do not call rAF FPS, screencast FPS, draw-call count, or GPU utilization by
itself "real FPS". The plugin reports two explicit frame-rate layers:
`frameRate.compositor` from Chrome's `Graphics.Pipeline` /
`STEP_DRAW_AND_SWAP`, and final display FPS from the optional PresentMon
backend. Keep those values separate; compositor FPS is not DWM/monitor Present
FPS.

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
   node "$env:USERPROFILE\plugins\chrome-devtools-lab\scripts\capture-trace.mjs" `
     --target-exact "TARGET_ID" --duration 5000 `
     --output "$env:TEMP\chrome-trace.json"
   ```

   For a real wheel sample with input and trace bound to one target, use the
   plugin's combined sampler. It does not report GPU FPS by itself:

   ```powershell
  node "$env:USERPROFILE\plugins\chrome-devtools-lab\scripts\wheel-benchmark.mjs" `
    --target-exact "TARGET_ID" --x 768 --y 504 --count 120 `
    --duration 2000 --delta-y 40 `
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

  The expected DPR, viewport, and canvas rectangle are required. Use the
  Onshape page coordinates and viewport values for the reference target; do
  not reuse the local values. Analyze the saved trace separately and pass the
  combined sample as the capture sidecar. The analyzer automatically uses
  `capture-result.trace.frameRateWindow`; explicit `--window-start-us` and
  `--window-end-us` still take precedence.

4. Analyze it:

   ```powershell
  node "$env:USERPROFILE\plugins\chrome-devtools-lab\scripts\analyze-trace.mjs" `
    --input "$env:TEMP\wheel-sample.trace.json" `
    --capture-result "$env:TEMP\wheel-sample.json" `
    --output "$env:TEMP\chrome-trace-summary.json"
   ```

   For a final display-rate sample around the same wheel operation:

   ```powershell
   node "$env:USERPROFILE\plugins\chrome-devtools-lab\scripts\present-fps.mjs" wheel `
     --target-exact "TARGET_ID" --x 768 --y 504 --count 120 `
     --duration 2000 --delta-y 40 --expected-dpr 1 `
     --expected-viewport-width 1192 --expected-viewport-height 1028 `
     --expected-canvas-x 0 --expected-canvas-y 0 `
     --expected-canvas-width 1192 --expected-canvas-height 1028
   ```

   This command requires Windows Performance Log Users/admin access. A
   permission failure is a blocked final-display KPI, not a substitute for
   rAF or compositor cadence.

5. Inspect top long tasks, compositor/GPU event counts, frame interval
   distribution, and missing evidence. Only then choose a code path to inspect.
6. Run CPU, draw-call, and system GPU captures as separate follow-up samples.
7. Preserve raw trace, summary, contract, invalid reasons, and exact commands
   as evidence. Never overwrite an earlier sample with a rerun.

## Attribution rules

- Long renderer tasks point to CPU/main-thread pressure; use the call stack or
  CPU profile to find the owning code.
- Compositor or renderer frame gaps without long JavaScript tasks require a
  trace/GPU queue check, not a speculative TypeScript optimization.
- High draw calls identify workload volume, not the cause or the achievable
  presentation rate. Compare pass, state, geometry, and instance semantics.
- GPUView can show GPU queue and Present/DWM behavior but cannot identify a
  TypeScript function. Pair it with a Chrome/V8 trace.
- Do not change shader, LOD, pass topology, draw order, VAO/BufferSet, or
  occurrence semantics based only on one count or one screenshot.
