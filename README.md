# Chrome DevTools Lab

Chrome browser control and performance evidence tooling for Codex. The plugin combines Chrome DevTools MCP with direct CDP scripts for exact-target binding, trusted input, trace analysis, WebGL inspection, and repeatable browser gates.

## Requirements

- Codex Desktop or Codex CLI with plugin support.
- Node.js supported by `chrome-devtools-mcp@1.7.0`: `^20.19.0`, `^22.12.0`, or `>=23`.
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

The runner re-discovers exact targets for every round, reloads both pages,
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

Use `--prepare-only` with any scenario for a fresh reload/setup/alignment gate
that sends no wheel input and starts no FPS or trace instrumentation. Use
`--rounds` and `--max-input-retries` to override the corresponding JSON values.

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

- `scripts/wheel-benchmark.mjs` supports trusted CDP wheel input and verified Windows `SendInput` wheel input. Configured comparisons record input delivery, visual change, rAF diagnostics, Chrome trace data, and DevTools FPS overlay state.
- `scripts/analyze-trace.mjs` reports validated `Display::FrameDisplayed` cadence and Chrome compositor `STEP_DRAW_AND_SWAP` cadence. The former is the strongest browser trace presentation signal available here; it is not a DWM monitor Present measurement.
- rAF and screencast rates are diagnostics. They must not be reported as GPU FPS.
- The DevTools FPS overlay is visible only while the target has a visible display surface. CDP can enable it but does not return the overlay's numeric value.
- `scripts/present-fps.mjs` is an optional Windows PresentMon backend for system Present/DWM attribution. It may require the Performance Log Users group or administrator rights and downloads the executable to a user-local cache.

Keep CPU profiles, heap sampling, trace captures, and WebGL/draw-call instrumentation as separate captures. Do not combine profiler overhead with a final KPI sample.

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
