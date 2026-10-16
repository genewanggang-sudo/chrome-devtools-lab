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
lease, then verify scheduling in the document that renders the Canvas. A lease,
focus emulation, background flags, visible state, and `hasFocus` do not prove
animation liveness. The explicit activation gate observes only the root
document for a complete 500 ms window, requires at least 10 rAF callbacks, and
rejects startup, internal, or trailing gaps of 150 ms or more. Inspect its scope,
callback offsets, gaps, and invalid reasons; it is not presentation FPS.
An iframe Canvas requires an independent cadence and input/visual gate in that
exact rendering frame under the intended sample state. A root-document pass
does not qualify an iframe or guarantee continued background scheduling.
Reject throttled samples and report the failed gate. Do not silently take focus
to make them pass. For strict real-window tests require the actual window and
visible page assertions as well as the relevant rendering-document gates.

## Input

Use `Input.dispatchMouseEvent(type=mouseWheel)` for wheel tests and the CDP
pointer/touch domains for device-specific tests. Check page delivery, trust,
coordinates, deltas, target response, and visual state. `window.scrollBy` and
page-created events are not equivalent.

For drag input, use one bounded transaction with absolute send deadlines and
mandatory release. Do not wait for each event's ACK before scheduling the next
event. The lease bridge serializes whole transactions with other commands for
the same target while allowing bounded in-flight events inside a transaction.
Validate send timing, count, schedule error, ACK drain, and release separately
from trusted DOM delivery, pointer capture, camera changes, and pixels.
CDP ACK latency alone does not identify WebSocket transport delay.
After a script update, recreate keep-alive workers from the updated script
path; already-running workers retain their previous implementation.

## Lifecycle and errors

Use one persistent CDP session for preload, navigation/reload, readiness, and
collection when a probe must survive document creation. A timeout closes a
socket but does not prove the page is dead; first run a bounded read-only eval.
Do not retry a page-thread-heavy expression indefinitely.

## Performance labels

The direct wheel probe intentionally returns input and visual evidence only.
Use the trace scripts for compositor/presentation attribution and WPR/GPUView
for system GPU scheduling. Keep CPU and draw-call instrumentation separate.
