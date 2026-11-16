import Foundation
import PeekCore

// Checks for the two rules that decide whether Peek behaves: what is allowed to
// interrupt you, and what counts as blocked. Run with `swift run PeekCheck`.
// Exits non-zero on the first failure so it works as a build gate.

var failures = 0
var checks = 0

func expect(_ condition: Bool, _ what: String) {
    checks += 1
    if condition {
        print("  ok    \(what)")
    } else {
        failures += 1
        print("  FAIL  \(what)")
    }
}

func section(_ name: String) { print("\n\(name)") }

// ---- fixtures ------------------------------------------------------------

func data(review: Int = 0, blocked: Int = 0, waiting: Int = 0,
          blockedIDs: [String] = [], agentID: String? = nil) -> PeekData {
    var d = PeekData()
    d.reachable = true
    d.needsReview = review
    d.blocked = blocked
    d.waitingAgents = waiting
    d.blockedRows = blockedIDs.map {
        PeekData.Row(id: $0, ref: "#1", title: "t", note: "conflicts", tone: .critical, url: nil)
    }
    if let a = agentID {
        d.reviewRows = [PeekData.Row(id: a, ref: "agent", title: "Start rook",
                                     note: "waiting", tone: .accent, url: nil)]
    }
    return d
}

/// Fixtures are decoded from the same JSON shape rook serves, so these checks
/// exercise the decoding contract as well as the rules on top of it.
func pr(mine: Bool = true, state: String = "OPEN", checks: String = "",
        mergeable: String = "MERGEABLE", unresolved: Int = 0,
        changesRequested: Int = 0, col: String = "waiting",
        lane: String = "mine") -> BoardPR {
    let json = """
    {"number":1,"title":"t","url":"u","repo":"o/r","author":"a","state":"\(state)",
     "lane":"\(lane)","col":"\(col)","mine":\(mine),"checks":"\(checks)",
     "mergeable":"\(mergeable)","unresolved":\(unresolved),
     "changesRequested":\(changesRequested),"updatedAt":"2026-09-23T10:00:00Z"}
    """
    return try! JSONDecoder().decode(BoardPR.self, from: Data(json.utf8))
}

// ---- interruption budget -------------------------------------------------

section("Interruption budget — what earns the top of the screen")

// Launching Peek must not alert you about everything that was already true.
expect(PeekAlert.earns(previous: nil,
                       current: data(review: 9, blocked: 4, waiting: 2)) == nil,
       "the first poll after launch never alerts")

expect(PeekAlert.earns(previous: data(),
                       current: data(waiting: 1, agentID: "sess-1"))?.key == "agent:sess-1",
       "an agent going to waiting earns an alert")

expect(PeekAlert.earns(previous: data(blocked: 0),
                       current: data(blocked: 1, blockedIDs: ["u/1"]))?.key == "blocked:u/1",
       "a pull request that just became blocked earns an alert")

expect(PeekAlert.earns(previous: data(blocked: 1, blockedIDs: ["u/1"]),
                       current: data(blocked: 1, blockedIDs: ["u/1"])) == nil,
       "something already broken last time is not news")

expect(PeekAlert.earns(previous: data(review: 0), current: data(review: 3)) == nil,
       "a review landing in your queue is ambient, not an interruption")

expect(PeekAlert.earns(previous: data(waiting: 2, agentID: "s"),
                       current: data(waiting: 0)) == nil,
       "good news — an agent finishing — never interrupts")

expect(PeekAlert.earns(previous: data(),
                       current: data(blocked: 1, waiting: 1,
                                     blockedIDs: ["u/1"], agentID: "sess-9"))?.key == "agent:sess-9",
       "a stopped agent outranks a broken build in the same poll")

// ---- blocked ------------------------------------------------------------

section("Blocked — worst reason first, matching the board")

expect(pr(checks: "FAILURE", mergeable: "CONFLICTING").blocker == "conflicts",
       "conflicts outrank failing checks")
expect(pr(checks: "FAILURE", changesRequested: 2).blocker == "checks failed",
       "failing checks outrank change requests")
expect(pr(unresolved: 3, changesRequested: 1).blocker == "changes requested",
       "change requests outrank unresolved threads")
expect(pr(unresolved: 3).blocker == "3 unresolved",
       "unresolved threads are the last resort")
expect(pr(checks: "SUCCESS").blocker == nil,
       "a healthy pull request has no blocker")

expect(pr(mine: false, mergeable: "CONFLICTING").isBlocked == false,
       "someone else's broken pull request is not your problem")
expect(pr(mine: true, mergeable: "CONFLICTING").isBlocked,
       "your own conflicted pull request is blocked")
expect(pr(state: "MERGED", mergeable: "CONFLICTING").isBlocked == false,
       "a merged pull request is history, not a blocker")

expect(pr(mine: false, col: "requested", lane: "review").needsMyReview,
       "the requested column needs your review")
expect(pr(mine: false, col: "commented", lane: "review").needsMyReview == false,
       "being involved is not the same as being asked")

// ---- live ----------------------------------------------------------------

section("Live — moving now, not merely open")

func sess(_ id: String, status: String = "busy",
          startedHoursAgo: Double, updatedMinutesAgo: Double) -> AgentSession {
    let now = Date().timeIntervalSince1970 * 1000
    let json = """
    {"sessionId":"\(id)","title":"\(id)","project":"p","status":"\(status)",
     "alive":true,"asking":"",
     "startedAt":\(now - startedHoursAgo * 3_600_000),
     "updatedAt":\(now - updatedMinutesAgo * 60_000)}
    """
    return try! JSONDecoder().decode(AgentSession.self, from: Data(json.utf8))
}

let nowMs = Date().timeIntervalSince1970 * 1000

// The bug this replaced: a four-day-old session that last moved half an hour
// ago was shown as live, with its session age as the duration.
expect(PeekData.pickLive(from: [sess("stale", startedHoursAgo: 108, updatedMinutesAgo: 26)],
                         now: nowMs) == nil,
       "an agent quiet for 26 minutes is parked, not live")

expect(PeekData.pickLive(from: [sess("fresh", startedHoursAgo: 176, updatedMinutesAgo: 0.5)],
                         now: nowMs)?.name == "fresh",
       "a long-open session that just moved is live")

expect(PeekData.pickLive(from: [sess("old-but-moving", startedHoursAgo: 176, updatedMinutesAgo: 0.5),
                                sess("newer-but-quiet", startedHoursAgo: 1, updatedMinutesAgo: 0.1)],
                         now: nowMs)?.name == "newer-but-quiet",
       "when several are moving, the most recently active wins")

expect(PeekData.pickLive(from: [sess("waiting", status: "waiting",
                                     startedHoursAgo: 1, updatedMinutesAgo: 0.1)],
                         now: nowMs) == nil,
       "an agent waiting on you is not live — that is an alert")

expect(PeekData.pickLive(from: [], now: nowMs) == nil,
       "no agents means nothing is live")

// ---- signal --------------------------------------------------------------

section("Signal — what keeps the notch awake")

var empty = PeekData(); empty.reachable = true
expect(empty.hasSignal == false, "an empty board has no signal, so Peek goes dormant")

var one = PeekData(); one.reachable = true; one.waitingAgents = 1
expect(one.hasSignal, "any non-zero count is signal")

// ---- panel fit -----------------------------------------------------------

section("Panel — as tall as its content, never taller than its window")

func panel(review: Int, blocked: Int, running: Bool = false, overflow: Int = 0) -> PeekData {
    var d = PeekData(); d.reachable = true
    d.reviewRows = (0..<review).map {
        PeekData.Row(id: "r\($0)", ref: "#1", title: "t", note: "", tone: .waiting, url: nil)
    }
    d.blockedRows = (0..<blocked).map {
        PeekData.Row(id: "b\($0)", ref: "#2", title: "t", note: "", tone: .critical, url: nil)
    }
    if running { d.running = PeekData.RunningAgent(name: "a", lastActivity: 0) }
    d.overflow = overflow
    return d
}

// The bug this replaced: eight rows rendered into a fixed 244pt window, which
// sliced the primary action in half.
let full = panel(review: 5, blocked: 3)
expect(full.panelHeight > 244,
       "eight rows genuinely need more than the old fixed 244pt — the window must follow")

expect(panel(review: 0, blocked: 0).panelHeight < panel(review: 3, blocked: 0).panelHeight,
       "an empty panel is shorter than a populated one")

expect(panel(review: 2, blocked: 0).panelHeight
       == panel(review: 0, blocked: 2).panelHeight,
       "the same number of rows is the same height in either section")

expect(panel(review: 2, blocked: 2).panelHeight
       > panel(review: 4, blocked: 0).panelHeight,
       "two sections cost a divider that one section does not")

expect(panel(review: 1, blocked: 0, overflow: 3).panelHeight
       > panel(review: 1, blocked: 0).panelHeight,
       "the overflow line is given room rather than clipped")

expect(PeekData.maxRows == 5, "the row budget is five, as specified")

// ---- result --------------------------------------------------------------

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 {
    print("\(failures) FAILED")
    exit(1)
}
