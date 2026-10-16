# Chrome DevTools Lab

Chrome browser control and performance evidence tooling for Codex. The plugin combines Chrome DevTools MCP with direct CDP scripts for exact-target binding, trusted input, trace analysis, WebGL inspection, and repeatable browser gates.

## Requirements

- Codex Desktop or Codex CLI with plugin support.
- Node.js supported by `chrome-devtools-mcp@1.10.1`: `^20.19.0`, `^22.12.0`, or `>=23`.
- Google Chrome started with a dedicated remote-debugging endpoint at `http://127.0.0.1:9333`.
- Windows PowerShell for the dedicated Chrome lifecycle, foreground native-wheel
  input, and the optional PresentMon backend.

The CDP endpoint is loopback-only by default. Do not expose it on a LAN or public interface; a CDP endpoint provides access to page contents, cookies, scripts, and input.

## Install From GitHub

This repository is also a portable Codex marketplace. Register it, then
install the plugin:

```powershell
codex plugin marketplace add genewanggang-sudo/chrome-devtools-lab --ref main
codex plugin add chrome-devtools-lab@chrome-devtools-lab
```

For a private fork, replace `genewanggang-sudo/chrome-devtools-lab` with the
fork owner and repository. `--ref main` keeps the marketplace on the main
branch; pin a release tag or commit SHA when a fixed version is required.

Verify the installation:

```powershell
codex plugin marketplace list
codex plugin list
```

Start a new Codex task after installation or upgrade. Existing tasks do not
hot-load plugin skills or MCP tools. To update an existing installation, run:

```powershell
codex plugin marketplace upgrade chrome-devtools-lab
codex plugin add chrome-devtools-lab@chrome-devtools-lab
```

The repository contains no machine-specific credentials, browser profiles, or
local source paths. A normal `git clone` is useful for development, but by
itself it does not install the plugin into Codex.

## Install Into ZCode

The same repository is a dual-host plugin. ZCode reads
`.zcode-plugin/plugin.json` (Codex reads `.codex-plugin/plugin.json`); the
`skills/` and `scripts/` trees are shared and are the single maintenance
point. In ZCode, open **Settings → Plugin Management → Discover**, click
**+**, and add this GitHub repository (or a local clone directory) as a
marketplace, then install `chrome-devtools-lab`.

Skill instructions locate the bundled scripts relative to the SKILL.md file
(`<this-skill-directory>/../../scripts/`), so no host-specific install path
is referenced.

### Manifest sync note

`.zcode-plugin/plugin.json` inlines the MCP server definition because ZCode
manifests use inline `mcpServers`. When the MCP configuration changes, update
`.mcp.json` and the inline `mcpServers` block together, and bump `version` in
both manifests so each host sees the upgrade.

## Native Performance Recording

For a complete reload diagnosis, prefer one native transaction:

```powershell
node scripts/performance.mjs native-record --config C:\project\loading-scenario.json
```

The project-owned JSON supplies `targetId`, a new `outputDir`, and `stopWhen`
(a JavaScript boolean expression). Optional `initScript` installs the project's
readiness observer before navigation; `observationExpression` saves its observed
milestones. No application selectors or loading rules belong in the plugin.
The command reuses Chrome's actual Performance panel, undocks it before freezing
the page viewport, starts ordinary native Record, immediately reloads with existing
caches, and stops after readiness remains true for `stableMs` (default 250).
`pollMs` defaults to 100; `maxDurationMs` defaults to 180000. An already-ready old
document cannot end the new recording. Timeouts preserve diagnostic artifacts.

`analysisQueries` accepts 1–10 uniquely named queries. Each can specify `startMs` /
`endMs` or `startMark` / `endMark`, plus existing thread/tree options. Marks must be
unique in the selected frame. All query windows directly reuse the completed
recording already parsed by Chrome's Performance panel; there is no second parse.
The first summary is saved and printed before exporting the complete raw trace.
Every query checks that the selected recording has not changed. The first report is
`report.json` / `summary.json`; subsequent ones are `<name>.report.json` and
`<name>.report.summary.json`. The bounded summaries include both self-time and
inclusive-time rankings; inclusive rows overlap and must not be summed.

Progress is printed to stderr. `run.json` records connection, recording start,
application wait, native stop/processing, native-session setup, query and export
timings. `firstSummaryMs` measures time until the first saved summary, while
`totalMs` also includes the full evidence archive. Reports record `parseCount: 0`
and `reusedNativeParse: true`. The run also records native export batch counts,
viewport validity, observations, and evidence
paths. Page and native-panel screenshots are saved directly after recording stops.
The raw recording remains unchanged. After export, saved reports receive the
archive's exact byte count, SHA-256 and capture validity. The native session
releases its remote handle when done; Chrome retains the recording for inspection.

Use Chrome's own Performance panel for ordinary profiling. The plugin opens
that panel on an exact target, operates its native recording controls, and
reads the completed recording already in the panel. No replacement timeline
or manual export/import step is required:

```powershell
node scripts/performance.mjs open --target-exact TARGET_ID
node scripts/performance.mjs native-start --target-exact TARGET_ID
# Operate or reload the page; clicking Record/Stop yourself also works.
node scripts/performance.mjs native-stop --target-exact TARGET_ID
node scripts/performance.mjs analyze-current --target-exact TARGET_ID --output-dir C:\evidence\new-run
```

`analyze-current` first queries the panel's existing parsed recording using that
Chrome version's native Call tree/Bottom-up algorithms, then preserves the complete
raw recording. It saves and prints the first summary before archive transfer;
`result.json` separates `firstSummaryMs` from `totalMs`. The panel remains the
interactive viewer. Reports include thread
ownership, JS samples, main-thread tasks, network, GC, user timing, screenshots
and native insights when those tracks exist. Optional `--start-ms` and
`--end-ms` restrict the query. Report positions use generated-source coordinates;
source maps saved in the original recording remain available in Chrome's UI. Missing tracks
are disclosed, not fabricated. Native frontend automation checks its supported
capabilities and fails explicitly when a Chrome update changes them.

Read the small `summary.json` first for thread totals, top hotspots, long tasks,
slow requests and coverage limits. The full `report.json` and raw trace remain
on disk for targeted follow-up; do not send the entire report into a conversation.

The first analysis pass calculates native tree roots and Bottom-up function
hotspots without expanding call chains. It preserves all trace events and the
same function timing calculations. Add `--expand-call-tree` after narrowing to
a relevant time range, process, or thread when caller relationships are needed.
Expanded trees are bounded by `--max-nodes 100 --max-depth 10`; each descendant
can rescan the thread events, so do not expand every tree for an overview.

For unattended reloads, a separate native-CDP workflow can stop when an
application-provided condition stays true. URLs, conditions, milestones and
revision strings belong in the project's configuration, not this plugin:

```powershell
node scripts/performance.mjs record --target-exact TARGET_ID --reload `
  --until "window.appReady === true" --stable 500 --max-duration 600000 `
  --output-dir C:\evidence\new-load
node scripts/performance.mjs analyze --input C:\evidence\new-load\trace.json `
  --capture C:\evidence\new-load\capture.json --output C:\evidence\new-load\report.json
```

`start`/`stop --session <directory>` also support manual timing without a panel.
Output directories are exclusive, raw trace bytes stream directly to disk,
and timeout/error samples retain their artifacts and invalid reasons. Defaults
include JS sampling and screenshots; `--screenshots false` omits screenshots.
`--cache disable-http` disables only HTTP caching; it does not establish a
cold IndexedDB, service-worker, OS, DNS or server cache. Never run two recorders
on the same Chrome endpoint at once. Diagnostic recording has overhead and
must be separate from a final timing/FPS comparison.

Saved-file analysis (`analyze --input`) and the MCP runtime are pinned to
`chrome-devtools-mcp@1.10.1`; native-panel queries use the running Chrome's own
TraceEngine and report its browser version. Development checkouts can use `npm ci
--ignore-scripts`. Installed plugin caches resolve the same runtime through a
one-time user-cache installation; later recordings reuse it. Set
`CHROME_LAB_NO_RUNTIME_INSTALL=1` to require a preinstalled runtime.

The MCP launcher uses that same pinned runtime directly in one Node process,
including installed plugin caches without `node_modules`. It avoids an `npx`
and shell process chain per session. The default MCP configuration exposes
page, input, network, debugging and performance tools; experimental vision,
screencast, memory, extension, third-party and WebMCP tools are not enabled.
This reduces tool metadata sent to the calling agent. It does not change raw
Performance recordings or the official analysis engine.

## Configured Wheel Comparison

`compare-wheel.mjs` is application-neutral. Create a scenario JSON outside the
plugin with two exact target URLs plus any application-specific readiness and
setup actions, then run:

```powershell
node scripts/compare-wheel.mjs `
  --config C:\path\to\wheel-scenario.json `
  --output-dir C:\path\to\wheel-results
```

The plugin does not ship site presets, URL heuristics, menu selectors, model
names, or application loaders. Keep those details in the calling project's
scenario file. The runner validates the JSON before touching Chrome and writes
the resolved config into every run contract.

The runner re-discovers exact targets for every round and again after reload,
then rebinds any replacement target IDs before continuing. It restores minimized or
maximized target windows to a normal state before reload, reloads both pages,
waits for the configured setup condition, normalizes existing Chrome window
bounds through verified Win32 placement when needed, checks
canvas/DPR/drawing-buffer parity, and alternates sample order across rounds.
Native Windows wheel input is delivered to the foreground render widget, so
the targets are activated and sampled sequentially; they cannot receive native
wheel input simultaneously.
The cursor is locked to the verified canvas point only during each measurement
window and its previous Windows clipping range is restored afterward, including
on failure.
The runner does not call `Page.bringToFront`. Every run receives a unique
output directory and existing evidence is not overwritten.

Scenario configs may declare a generic `metrics` profile. The plugin validates
and records that profile in the run contract; application-specific metric
ownership remains with the calling project.

Use `--prepare-only` with any scenario for a fresh reload/setup/alignment gate
that sends no wheel input and starts no FPS or trace instrumentation. A scenario
may set `retry.maxPreparationRetries` to repeat the complete target discovery,
reload, setup, and anchor sequence after a preparation contract failure. Setup
actions may set `settleMs` when a camera or fit command has an application-owned
animation that must finish before the next action. Use `--rounds` and
`--max-input-retries` to override the corresponding JSON values.

When two visible windows have already been refreshed and aligned, use
`--reuse-ready-state` only with a scenario whose setup action arrays are empty:

```powershell
node scripts/compare-wheel.mjs `
  --config C:\path\to\prepared-wheel-scenario.json `
  --reuse-ready-state `
  --output-dir C:\path\to\wheel-results
```

This path skips reload, setup actions, and window resizing, but still performs
exact-target discovery, visible-surface checks, canvas/DPR parity, and the
paired camera/model anchor gate. It accepts exactly one round and does not
retry after wheel or trace failure because the sample itself may change the
camera state. Its evidence is labeled `prepared-state`, not equivalent to a
fresh-reload run. Refresh and align both windows again before starting another
prepared-state sample.

## Evidence Layers

- `scripts/wheel-benchmark.mjs` supports trusted CDP wheel input and verified Windows `SendInput` wheel input. Configured comparisons record input delivery, visual change, rAF diagnostics, page runtime/heap/DOM/resource before-after deltas, Chrome trace data, and DevTools FPS overlay state.
- `scripts/analyze-trace.mjs` reports validated `Display::FrameDisplayed` cadence and Chrome compositor `STEP_DRAW_AND_SWAP` cadence. The former is the strongest browser trace presentation signal available here; it is not a DWM monitor Present measurement.
- rAF and screencast rates are diagnostics. They must not be reported as GPU FPS.
- The DevTools FPS overlay is visible only while the target has a visible display surface. CDP can enable it but does not return the overlay's numeric value.
- `scripts/present-fps.mjs` is an optional Windows PresentMon backend for system Present/DWM attribution. It may require the Performance Log Users group or administrator rights and downloads the executable to a user-local cache.

Keep CPU profiles, heap sampling, trace captures, and WebGL/draw-call instrumentation as separate captures. Do not combine profiler overhead with a final KPI sample.

The wheel capture exposes the following metric layers without asserting that all
of them are final GPU KPIs: input ACK and DOM delivery distributions, page
`Performance.getMetrics` deltas, JS heap and DOM counter deltas, resource
timing totals, rAF cadence, compositor draw/swap cadence, target-correlated
`Display::FrameDisplayed` cadence, long tasks, trace integrity, and GPU/
compositor event counts. Application-specific draw calls, geometry counts,
shader switches, and GPU memory remain optional instrumentation supplied by the
calling project or a graphics tool.

## Direct CDP Commands

```powershell
node scripts/cdp.mjs status
node scripts/cdp.mjs list
node scripts/cdp.mjs focus --target-exact TARGET_ID
node scripts/cdp.mjs inspect --target-exact TARGET_ID
node scripts/cdp.mjs wheel-probe --target-exact TARGET_ID --x 600 --y 400 --delta-y 40
```

Always list targets immediately before a run and bind the exact current target ID. Reusing a stale target ID can silently measure a different page or fail after a reload.

## Validation

```powershell
Get-ChildItem scripts\*.mjs | ForEach-Object { node --check $_.FullName }
node scripts/cdp.mjs self-check
node scripts/wheel-sequence.mjs --self-test
node scripts/wheel-benchmark.mjs --self-test
node scripts/compare-wheel.mjs --self-test
```

The plugin does not include trace files, screenshots, benchmark results, browser profiles, PresentMon binaries, cookies, or authentication material.
