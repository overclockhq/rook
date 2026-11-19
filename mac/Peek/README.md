# Peek

A notch surface for rook. It answers one question without you opening anything:
*is something waiting on me?*

Peek is a menu-bar agent with no dock icon and no window of its own. It reads
rook's local API and shows what it finds in the MacBook notch.

```bash
cd mac/Peek
swift run Peek          # start it
swift run PeekCheck     # assert the rules
```

Quit from the menu-bar item. rook must be running on `127.0.0.1:7480`.

## States

Five, ordered by how much attention each is allowed to cost. Nothing skips a
rung without a reason listed here.

| | State | When | Geometry |
|---|---|---|---|
| 00 | **Dormant** | Nothing needs you — most of the day | notch size, nothing drawn |
| 01 | **Ambient** | A count is non-zero and has held for 30 s | 1.4× notch width |
| 02 | **Alert** | One thing changed that only you can unblock | 1.8× · 46 pt · 6 s |
| 03 | **Live** | An agent is running | 1.8× · 46 pt · holds |
| 04 | **Peek** | Hover, after 220 ms | 2.1× · 244 pt |

Widths are multiples of the notch, which is a constant 12.2% of screen width on
every notched Mac. One set of numbers therefore covers 14″, 16″ and the
no-notch fallback alike — nothing is hard-coded per machine.

## What earns an Alert

The test is not "did something happen" but **can only you unblock it, right
now**. `PeekAlert.earns` is the single place this is decided.

Alerts: an agent stopped at a permission prompt · CI turned red on your pull
request · changes requested · your branch developed a conflict.

Not alerts: a review was requested from you · your pull request was approved ·
an agent finished cleanly. Those are Ambient, visible when you look.

Rate limited to one per 90 s, suppressed entirely while a display is mirrored —
a demo interrupted by your own tooling is the failure that rule prevents.

## Layout

```
Sources/PeekCore/     the rules — no AppKit, checkable headlessly
  Model.swift         shapes from rook's API + what counts as blocked
  PeekState.swift     the state machine and the interruption budget
Sources/Peek/         the app
  PeekApp.swift       menu-bar agent, polling, wiring
  NotchWindow.swift   borderless panel pinned above the menu bar
  NotchGeometry.swift reads the notch from the hardware
  Faces.swift         the five states, in SwiftUI
Sources/PeekCheck/    `swift run PeekCheck` — 19 assertions on the rules
```

`PeekCheck` is an executable rather than a test target because XCTest and
swift-testing both require a full Xcode install; this runs with the Command
Line Tools alone.

## Read-only

Peek only ever GETs from rook. Acting on something opens the board or the pull
request — it never approves, merges, or answers a prompt on your behalf.
