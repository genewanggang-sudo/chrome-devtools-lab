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

## Native Performance first

For a requested complete reload/loading diagnosis, prefer a single transaction:

```powershell
node "<plugin-root>/scripts/performance.mjs" native-record --config <project-scenario.json>
```

Supply project-owned `targetId`, a new `outputDir`, `stopWhen`, and optionally
`initScript` / `observationExpression`. Use `analysisQueries` with unique safe
`name` values and `startMark` / `endMark` (or millisecond bounds) to select the
actual loading phase. The command uses ordinary native Record + immediate reload,
waits for a new document's stable readiness, then stops and processes the same
native recording. It undocks the panel, validates viewport/DPR, and directly
queries Chrome's existing parsed result for all configured windows. The first
summary is saved and printed before the complete raw recording is exported;
there is no second parse. Every query checks the selected recording identity.
Default readiness stability is
250ms, poll interval 100ms, deadline 180s; polling resolution and recording
overhead must be disclosed. Keep URLs, selectors, observers and readiness
definitions in project configuration. Initial display is not complete refinement.

Read `run.json` for separate timings, validity, observations, query paths and
screenshots. Read the first query's `summary.json` before the full report. It
contains both self-time and inclusive-time hotspot rankings. They are sampled
estimates; inclusive rows overlap. Distinguish application loading, Chrome's
stop/processing wait, native-session setup, query and export costs. `firstSummaryMs`
ends at the first saved summary; `totalMs` includes the full evidence archive.
Native queries report `parseCount: 0` and `reusedNativeParse: true`; their source
version is the running Chrome. Do not insert agent/tool
round trips between native start, reload, readiness and stop when this automatic
transaction is applicable. Raw recordings are never trimmed to hide collection
costs. Export backfills every saved report with archive bytes, SHA-256 and capture
validity; wait for archive completion before declaring the evidence complete.

For ordinary performance diagnosis, use Chrome's actual Performance panel.
Do not create a replacement panel, flame-chart UI, or a new per-task CDP
recorder. Use the bundled `performance.mjs`:

```powershell
node "<plugin-root>/scripts/performance.mjs" open --target-exact TARGET_ID
node "<plugin-root>/scripts/performance.mjs" native-start --target-exact TARGET_ID
# Perform the requested page operation, or let the user operate Record/Stop.
node "<plugin-root>/scripts/performance.mjs" native-stop --target-exact TARGET_ID
node "<plugin-root>/scripts/performance.mjs" analyze-current --target-exact TARGET_ID --output-dir NEW_EVIDENCE_DIR
```

Reuse the panel and completed recording if the user has already recorded it.
`analyze-current` directly queries that same recording in Chrome's frontend before
automatically preserving its full raw trace; the user need not export/import it.
`result.json` separates first-summary time from total archive time. Read the bounded
`summary.json` first to explain the result. Keep the full `report.json` on disk;
query or read only the relevant section when the summary leaves a question.
Do not print a multi-megabyte report into tool output or conversation context.
Use `analyze-current --start-ms N --end-ms N` for a completed native recording,
or `analyze --input ... --start-ms N --end-ms N` for an archived file using the
pinned offline TraceEngine. Add `--pid`/`--tid` when needed. Keep the raw trace
for review; generated-source coordinates are not automatically original TS
coordinates. Do not assert that missing worker/GPU/screenshot tracks exist.
The first pass calculates native roots and Bottom-up function hotspots without
expanding call chains. Keep that default for an overview. When a caller chain
is needed, narrow the time range/thread and add `--expand-call-tree`; expansion
is bounded by `--max-nodes 100 --max-depth 10`. Larger limits are explicit opt-ins.
Expanding a large native tree can dominate analysis time.

Reuse a completed recording and its summary before capturing again. Use the
bundled commands instead of writing a new recorder or analysis script per task.
The native workflow and summary are sufficient for the first diagnosis; add a
CPU profile, coverage, FPS run or screenshot only to answer a specific remaining
question. Do not run every evidence layer for an ordinary performance request.

For unattended loading only, use `record --config <project-scenario.json>` or
`record --target-exact ID --reload --until "<explicit-ready-condition>"
--output-dir NEW_DIR`. Supported config fields are `targetId`, `outputDir`,
`action` (`none`/`reload`/`navigate`), `url`, `stopWhen`, `stableMs`, `pollMs`,
`maxDurationMs`, optional `durationMs`, `screenshots`, `bufferMb`, `cache`
(`existing`/`disable-http`), `applicationRevision`, and `milestones` containing
`name`/`expression`. A polled milestone is an observation with polling
resolution, not an exact business event. Do not treat HTTP-cache bypass as
full cold storage. Keep application readiness and model-specific probes in
the project configuration/adapter.

Existing CPU and FPS scripts below are specialized secondary tools. Full
Performance diagnosis uses the native recording's JS sampling, network,
rendering, GC, related threads and native insights together. Final KPIs use
a separate lightweight run with a matched contract.

## Evidence layers

Keep these layers separate:

| Layer            | Tool                                       | What it proves                                                   |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Input            | direct CDP `wheel-probe`, `pointer`        | exact target, native CDP event, trusted delivery                 |
| Page diagnostics | MCP console/network/snapshot plus page runtime snapshot | page state, errors, requests, DOM/UI state, heap/DOM/resource/runtime deltas |
| CPU              | `capture-cpu-profile.mjs` + `analyze-cpu-profile.mjs` (V8 profile) | function-level self/total time, hot source locations, flame graph |
| Line frequency   | `capture-cpu-profile.mjs --coverage`       | coverage range counts projected onto lines (not time)             |
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

Verify scheduling in the document that owns the Canvas under the exact sample
state. The activation gate checks only the root document: a complete 500 ms
window, at least 10 rAF callbacks, and no startup, internal, or trailing gap of
150 ms or more. This is a scheduler diagnostic, not FPS. A visible page, focus
emulation, lease, or two-frame burst cannot substitute for the gate, and a root
pass cannot prove iframe scheduling. Independently probe the exact rendering
iframe when present; reject a throttled sample and report its scope and reason.
Foreground activation requires an explicit contract, not an implicit recovery.

For drag sampling, use the bounded input transaction and validate its absolute
send deadlines, event counts, schedule errors, ACK drain, and final release.
Do not pace events by serial ACK completion. `timing.valid` proves the send/ACK
contract only; independently check trusted DOM delivery, pointer capture,
camera response, and changed pixels. Keep ACK latency, send duration, DOM
delivery duration, and rendering time separate. Recreate old keep-alive workers
from the updated scripts before testing a plugin update.

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

1. Start with the native Performance workflow above and its bounded summary.
   The following trace, input and CPU workflows are alternatives or targeted
   follow-ups, not a mandatory sequence for every diagnosis. Use MCP performance
   tools only for a short exploratory trace; discover configured tools first.
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
- Explain the summary in plain language. For visual evidence, reuse the native
  Performance panel; capture its relevant view when it helps the answer. Do not
  generate a replacement flame chart or report HTML for ordinary diagnosis.
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
