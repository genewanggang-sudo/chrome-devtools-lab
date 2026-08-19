# Chrome DevTools Lab

Chrome browser control and performance evidence tooling for Codex. The plugin combines Chrome DevTools MCP with direct CDP scripts for exact-target binding, trusted input, trace analysis, WebGL inspection, and repeatable browser gates.

## Requirements

- Codex Desktop or Codex CLI with plugin support.
- Node.js supported by `chrome-devtools-mcp@1.7.0`: `^20.19.0`, `^22.12.0`, or `>=23`.
- Google Chrome started with a dedicated remote-debugging endpoint at `http://127.0.0.1:9333`.
- Windows PowerShell for the dedicated Chrome lifecycle and optional PresentMon backend.

The CDP endpoint is loopback-only by default. Do not expose it on a LAN or public interface; a CDP endpoint provides access to page contents, cookies, scripts, and input.

## Install From GitHub

Clone the repository into the default personal plugin source directory:

```powershell
$pluginPath = Join-Path $env:USERPROFILE "plugins\chrome-devtools-lab"
git clone https://github.com/genewanggang-sudo/chrome-devtools-lab.git $pluginPath
codex plugin add chrome-devtools-lab@personal
```

The `personal` marketplace entry must resolve `./plugins/chrome-devtools-lab` to the clone path. On a new Codex installation, add this local source to the personal marketplace first, then run the install command above. The repository is intentionally a standalone plugin source; it does not contain machine-specific credentials or browser profiles.

After changing the local source, reinstall it with `codex plugin add chrome-devtools-lab@personal` and start a new Codex task so the new MCP tools and skills are loaded.

## Fast Wheel Comparison

Create a scenario JSON with two targets identified by their exact URLs, then run:

```powershell
node scripts/compare-wheel.mjs `
  --config C:\path\to\wheel-scenario.json `
  --output-dir C:\path\to\wheel-results
```

The runner re-discovers exact targets for every round, restores minimized target windows through `Target.activateTarget` without Windows foreground activation, reloads both pages, waits for the configured setup condition, checks canvas/DPR/drawing-buffer parity, and alternates sample order across rounds. Every run receives a unique output directory and existing evidence is not overwritten.

## Evidence Layers

- `scripts/wheel-benchmark.mjs` dispatches trusted `Input.dispatchMouseEvent` wheel input and records input delivery, visual change, rAF diagnostics, Chrome trace data, and optional DevTools FPS overlay state.
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
node --check scripts/*.mjs
node scripts/cdp.mjs self-check
node scripts/compare-wheel.mjs --self-test
```

The plugin does not include trace files, screenshots, benchmark results, browser profiles, PresentMon binaries, cookies, or authentication material.
