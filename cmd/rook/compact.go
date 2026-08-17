package main

import (
	"log"
	"net/http"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// Compaction keeps the context window from rotting — the research's #1 quality
// lever. rook can't edit an agent's context directly, but it can tell the agent
// to compact (Claude Code's built-in /compact summarizes + reinits the window).
// A manual control lives by the context gauge; an opt-in trigger fires it
// automatically when a session climbs past a threshold.

// compactThresholdPct is the context-fill level at which auto-compact fires.
const compactThresholdPct = 85

// compactRearmPct is the level a session must fall back below before auto-compact
// will fire again for it — hysteresis so it fires once per climb, not repeatedly.
const compactRearmPct = 70

// windowForModel infers a model's context window from the max fill seen across
// all sessions on that model (any session over 200k ⇒ the model runs the 1M
// window here). Mirrors the frontend's windowForModel so the % matches the gauge.
func windowForModel(model string, sessions []Session) int64 {
	var max int64
	for i := range sessions {
		if sessions[i].Model == model && sessions[i].ContextTokens > max {
			max = sessions[i].ContextTokens
		}
	}
	if max > 200000 {
		return 1000000
	}
	return 200000
}

// contextPct is a session's context-window fill as a 0–100 percentage.
func contextPct(s Session, sessions []Session) int {
	if s.ContextTokens <= 0 {
		return 0
	}
	p := int(s.ContextTokens * 100 / windowForModel(s.Model, sessions))
	if p > 100 {
		p = 100
	}
	return p
}

// sendCompact tells an agent to compact its context. Claude Code has a built-in
// /compact; other agents get a plain-language nudge.
func sendCompact(pane, provider string) (int, error) {
	msg := "/compact"
	if provider != "" && provider != "claude" {
		msg = "You're near your context limit — summarize progress into durable notes and drop stale tool output before continuing."
	}
	return applyKeyAction(pane, "text", msg)
}

type compactReq struct {
	SessionID string `json:"sessionId"`
}

// handleCompact routes a manual compaction request to the agent's tmux pane.
func handleCompact(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux is required to compact an agent")
	}
	var req compactReq
	if err := ctx.Bind(&req); err != nil || !validSessionID(req.SessionID) {
		return nil, errf(http.StatusBadRequest, "sessionId required")
	}
	sessions := ScanSessions(0)
	for i := range sessions {
		if sessions[i].SessionID == req.SessionID {
			if sessions[i].TmuxPane == "" {
				return nil, errf(http.StatusConflict, "the agent is not in a tmux pane — can't compact it")
			}
			if code, err := sendCompact(sessions[i].TmuxPane, sessions[i].Provider); err != nil {
				return nil, errf(code, "%v", err)
			}
			return rawJSON(map[string]any{"ok": true})
		}
	}
	return nil, errf(http.StatusNotFound, "session not found")
}

var (
	compactMu    sync.Mutex
	compactArmed = map[string]bool{} // sessionID → armed to fire (fell below rearm since last compact)
)

// startAutoCompact runs the opt-in auto-compaction loop: when enabled, any alive
// agent that climbs past the threshold (and isn't mid-work) is told to compact
// once, re-arming only after it drops back below the rearm band.
func startAutoCompact() {
	go func() {
		for {
			time.Sleep(20 * time.Second)
			if !loadConfig().AutoCompact {
				continue
			}
			sessions := ScanSessions(0)
			for i := range sessions {
				s := sessions[i]
				// don't interrupt an actively working agent — only nudge when it's settled
				if !s.Alive || s.TmuxPane == "" || s.Status == "working" || s.Status == "busy" {
					continue
				}
				pct := contextPct(s, sessions)
				compactMu.Lock()
				armed, seen := compactArmed[s.SessionID]
				if !seen || pct < compactRearmPct {
					armed = true
					compactArmed[s.SessionID] = true
				}
				fire := armed && pct >= compactThresholdPct
				if fire {
					compactArmed[s.SessionID] = false
				}
				compactMu.Unlock()
				if fire {
					if _, err := sendCompact(s.TmuxPane, s.Provider); err != nil {
						log.Printf("auto-compact %s failed: %v", shortID(s.SessionID), err)
					} else {
						log.Printf("auto-compact sent to %s at %d%%", shortID(s.SessionID), pct)
					}
				}
			}
		}
	}()
}
