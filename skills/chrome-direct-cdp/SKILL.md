---
name: chrome-direct-cdp
description: Control a dedicated Chrome instance directly through CDP with exact target binding, trusted native input, background-safe leases, lifecycle probes, viewport contracts, screenshots, and strict interaction evidence. Use when browser automation or performance testing must not depend on the official browser bridge or foreground focus.
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

See `references/direct-cdp-contract.md` for lifecycle, background, cleanup,
and invalid-sample rules.
