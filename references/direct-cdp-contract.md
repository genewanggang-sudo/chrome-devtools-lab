# Direct CDP Contract

## Endpoint and identity

Use only the loopback endpoint configured by the plugin. `status` must confirm
the dedicated Chrome executable, debugging port, user-data directory, and
background scheduling flags. An unrelated listener or an ambiguous owner is a
hard setup failure; do not kill processes to recover it.

## Exact targets

Use target IDs returned by `list` or `new`. A title/URL selector is acceptable
for exploration only when it resolves to one page. Disposable targets must be
closed by exact ID in a finally path. Keep user-owned targets open.

## Foreground and background

Read-only inspection, target activation, pointer commands, and strict wheel
probes do not need OS foreground focus. The direct client must not call
`Page.bringToFront`, `BringWindowToTop`, or `SetForegroundWindow` unless the
caller explicitly passes `--allow-window-focus`.
For background work, use a verified dedicated window or a persistent keep-alive
lease. A lease's focus emulation proves animation liveness under that setup; it
does not prove the OS foreground policy. For strict real-window tests require
the actual window assertion and visible page assertion.

## Input

Use `Input.dispatchMouseEvent(type=mouseWheel)` for wheel tests and the CDP
pointer/touch domains for device-specific tests. Check page delivery, trust,
coordinates, deltas, target response, and visual state. `window.scrollBy` and
page-created events are not equivalent.

## Lifecycle and errors

Use one persistent CDP session for preload, navigation/reload, readiness, and
collection when a probe must survive document creation. A timeout closes a
socket but does not prove the page is dead; first run a bounded read-only eval.
Do not retry a page-thread-heavy expression indefinitely.

## Performance labels

The direct wheel probe intentionally returns input and visual evidence only.
Use the trace scripts for compositor/presentation attribution and WPR/GPUView
for system GPU scheduling. Keep CPU and draw-call instrumentation separate.
