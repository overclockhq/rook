package main

import "fmt"

// Health is a watchdog assessment of a session that may need the user's
// attention — surfaced in the UI and used to escalate notifications.
type Health struct {
	Level  string `json:"level"`  // ok | warn | alert
	Reason string `json:"reason"` // human one-liner
	Action string `json:"action,omitempty"` // suggested remedy: "" | "terminal" | "answer"
}

// watchdog thresholds. Kept conservative to avoid false positives that would
// train the user to ignore the signal.
const (
	waitingStuckMs = 10 * 60 * 1000 // waiting for input this long → alert
	idleBusyMs     = 8 * 60 * 1000  // "busy" but no new output this long → warn
	loopRunLen     = 3              // this many identical consecutive tool calls → loop
)

// leadingRepeat counts how many of the most-recent tool calls are identical
// (same name + same summary). ToolCalls are ordered most-recent-first.
func leadingRepeat(calls []ToolCall) (int, ToolCall) {
	if len(calls) == 0 {
		return 0, ToolCall{}
	}
	first := calls[0]
	n := 1
	for i := 1; i < len(calls); i++ {
		if calls[i].Name == first.Name && calls[i].Summary == first.Summary {
			n++
		} else {
			break
		}
	}
	return n, first
}

// computeHealth returns a watchdog assessment for a session, or nil when it's
// healthy. now is ms epoch.
func computeHealth(s *Session, now int64) *Health {
	if !s.Alive {
		return nil // dead sessions are handled by the finished-notifier, not the watchdog
	}
	age := now - s.UpdatedAt

	// 1) looping: the agent keeps issuing the same tool call — usually a stuck
	// retry loop burning tokens. Highest-signal, so check it first.
	if n, tc := leadingRepeat(s.ToolCalls); n >= loopRunLen {
		return &Health{Level: "alert", Reason: fmt.Sprintf("looping — repeated %s ×%d", toolLabel(tc), n), Action: "terminal"}
	}

	// 2) waiting for input too long: the user is the blocker.
	if s.Status == "waiting" && age >= waitingStuckMs {
		return &Health{Level: "alert", Reason: "waiting " + humanDur(age) + " for your input", Action: "answer"}
	}

	// 3) apparently working but frozen: "busy"/"shell" with no new output.
	if (s.Status == "busy" || s.Status == "shell") && age >= idleBusyMs {
		return &Health{Level: "warn", Reason: "no new output for " + humanDur(age), Action: "terminal"}
	}
	return nil
}

// toolLabel is a short label for a tool call in a health reason.
func toolLabel(tc ToolCall) string {
	if tc.Name == "" {
		return "tool call"
	}
	return tc.Name
}

// humanDur renders a ms duration as "9m" / "2h" for health reasons.
func humanDur(ms int64) string {
	m := ms / 60000
	if m < 60 {
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%dh%dm", m/60, m%60)
}

// annotateHealth attaches watchdog health to each alive session in place.
func annotateHealth(sessions []Session, now int64) {
	for i := range sessions {
		sessions[i].Health = computeHealth(&sessions[i], now)
	}
}
