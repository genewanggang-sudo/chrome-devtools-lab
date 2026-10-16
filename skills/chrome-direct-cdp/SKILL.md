---
name: chrome-direct-cdp
description: Control a dedicated Chrome instance directly through CDP with exact target binding, native input, persistent leases, verified animation cadence, lifecycle probes, viewport contracts, screenshots, and strict interaction evidence. Use when browser automation or performance testing needs direct target control and explicit foreground or background scheduling checks.
---

# Direct CDP

## Locating the bundled scripts

The bundled scripts live in `scripts/` at the plugin root. Resolve them
relative to this SKILL.md file: `<this-skill-directory>/../../scripts/`.
Both Codex and ZCode install the plugin with `skills/` and `scripts/`
co-located, so the relative path is host-independent. In the examples
below, `<plugin-root>` stands for the resolved plugin root directory (the
parent of `skills/`).

Use the bundled `scripts/cdp.mjs`. Do not use `@chrome`,
`agent.browsers.get("extension")`, or another browser bridge for the same
target. The default endpoint is `http://127.0.0.1:9333`.

## Target discipline

Run `status`, then `list`, and bind the intended page with its exact target ID.
Create disposable pages with `new` and close only the exact IDs returned by
that command. Do not guess from a title or URL when more than one page matches.

```powershell
$directCdp = "<plugin-root>\scripts\cdp.mjs"
node $directCdp status
node $directCdp list
node $directCdp new --url "about:blank" --new-window --focus false
```

`start` uses the dedicated `%LOCALAPPDATA%\CodexChromeCDP` profile and refuses
an unrelated listener. It enables background scheduling flags by default;
`status` must report that the flags are present before background samples run.
Do not foreground Chrome merely to run a read-only command. Clicks and pointer
commands send directly to the exact target without implicit tab activation by
default. Use explicit `--activate` only when the test has reserved a dedicated
active tab/window; it may change which Chrome tab is active. Use
`--allow-window-focus` only for an intentional Windows foreground experiment.
The explicit `--allow-window-focus` option is required for the legacy operation
that brings the dedicated Chrome window to the Windows foreground.

Scheduling flags, `visibilityState=visible`, `hasFocus`, and an active lease
are setup facts; none proves that the rendering document remains scheduled.
The explicit activation gate observes root-document rAF callbacks for a full
500 ms, requires at least 10 callbacks, and rejects any startup, internal, or
trailing gap of 150 ms or more. Read `animationFrames.scope`, callback offsets,
gaps, and invalid reasons. Two immediate callbacks cannot pass this gate.
This is a cadence diagnostic, not presentation FPS or proof about an iframe.
For an iframe Canvas, independently observe the exact rendering frame's cadence
and real input/visual response under the intended background state. A failed
frame gate invalidates the interaction sample; report it and use only an
explicitly authorized foreground contract. Do not silently take focus.

## Interaction commands

Use semantic locators for ordinary DOM controls after `inspect`. Use explicit
coordinates for Canvas/WebGL. Verify URL, page state, or a visible response
after every interaction sequence.

```powershell
node $directCdp inspect --target-exact "TARGET_ID"
node $directCdp click --target-exact "TARGET_ID" --selector "button"
node $directCdp pointer --target-exact "TARGET_ID" --pointer-type mouse --action drag --from-x 596 --from-y 514 --to-x 650 --to-y 540 --steps 16 --duration 250
node $directCdp screenshot --target-exact "TARGET_ID" --output "$env:TEMP\chrome-target.png"
```

Use `--allow-window-focus` only when an actual foreground experiment is part
of the contract. The default interaction path does not call
`Target.activateTarget`, `Page.bringToFront`, or Windows foreground APIs.

`drag` and `pointer --action drag` use one bounded input transaction with
absolute send deadlines. They do not wait for each event's ACK before sending
the next event. Under a lease, the bridge queues the complete transaction ahead
of other commands for that target. Check the returned `timing.valid`, requested
and actual send duration, schedule error, ACK drain, and release acknowledgement.
Send timing and CDP ACK success do not prove DOM delivery, pointer capture,
camera motion, or changed pixels; verify those separately. Preserve invalid
timing results instead of treating a stretched gesture as application latency.
After updating these scripts, recreate a lease from the updated script path;
an already-running keep-alive worker retains its previous implementation.

Use `lifecycle` when an injection must survive reload or navigation. Use
`viewport` only with an active exact-target keep-alive lease, then require a
readback matching width, height, and device scale factor.

## Strict wheel evidence

For CAD zoom, use `wheel-probe`, never `scroll` or page-created mouse events:

```powershell
node $directCdp wheel-probe --target-exact "TARGET_ID" --x 596 --y 514 `
  --delta-y 120 --count 180 --interval 16 --settle 500 --timeout 30000
```

The probe validates `Input.dispatchMouseEvent(type=mouseWheel)`, trusted DOM
delivery, coordinates and deltas, page scroll state, visual-anchor change, and
interaction-time screencast evidence. It deliberately reports
`performanceKpi.valid=false`: rAF and screencast are not GPU Present FPS.

For a repeatable two-target comparison, use `compare-wheel.mjs --config` with
an application-owned scenario JSON. Its `windows-native` backend uses verified
Windows wheel input against the exact foreground
`Chrome_RenderWidgetHostHWND`, then records whether each page received native
`wheel`, browser-generated legacy `mousewheel`, or an explicitly configured
compatibility relay. Because Windows routes wheel input to the foreground
window, the two targets are sampled sequentially.

## Performance evidence

Use `performance.mjs open/native-start/native-stop/analyze-current` for normal
profiling: these operate and read Chrome's native Performance panel. Use
`performance.mjs record --config <scenario.json>` for unattended reloads with
explicit completion conditions. The trace/CPU commands below remain for
specialized capture contracts; do not rewrite their orchestration per task.

For a saved trace, use:

```powershell
node "<plugin-root>\scripts\capture-trace.mjs" `
  --target-exact "TARGET_ID" --duration 5000 --output "$env:TEMP\trace.json"
node "<plugin-root>\scripts\analyze-trace.mjs" `
  --input "$env:TEMP\trace.json" --output "$env:TEMP\trace-summary.json"
```

Only a trace with explicit target-correlated compositor and
`Display::FrameDisplayed` evidence can support a browser presentation-rate
KPI. This is not the same as an independent DWM/monitor measurement. Keep CPU
profiling, draw-call instrumentation, and WPR/GPUView captures separate from
the frame-rate sample.

For a CPU sample with function- and line-level attribution, use:

```powershell
node "<plugin-root>\scripts\capture-cpu-profile.mjs" `
  --target-exact "TARGET_ID" --duration 3000 --reload `
  --output "$env:TEMP\profile.cpuprofile"
node "<plugin-root>\scripts\analyze-cpu-profile.mjs" `
  --input "$env:TEMP\profile.cpuprofile" `
  --output "$env:TEMP\profile-summary.json" `
  --flamegraph "$env:TEMP\flame.html" `
  --speedscope "$env:TEMP\profile.speedscope.json"
```

`capture-cpu-profile.mjs` records a V8 sampling profile on the exact target
(`--reload` starts sampling before a page reload so load-time work is
included). `analyze-cpu-profile.mjs` reports top functions by self and total
time, top source locations, and per-URL totals; `--flamegraph` writes a
self-contained HTML flame chart and `--speedscope` writes a file for
speedscope.app. Sampling attributes time to functions: the reported line is
the function's definition line, not the executing statement. For
statement-level execution counts, add `--coverage --coverage-output
<coverage.json>` to the capture; coverage instrumentation inflates measured
times, so never use a coverage run as a timing KPI. Keep CPU captures
separate from `capture-trace.mjs` frame-rate samples.

See `references/direct-cdp-contract.md` for lifecycle, background, cleanup,
and invalid-sample rules.
