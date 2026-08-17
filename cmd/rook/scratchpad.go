package main

import (
	"net/http"
	"os"
	"path/filepath"

	"gofr.dev/pkg/gofr"
)

// A per-session scratchpad is durable state kept OUTSIDE the agent's context
// window (the "Write" strategy from context engineering): notes, decisions, and
// TODOs that survive compaction and restarts, and can be handed back to the
// agent on demand. Stored rook-side, keyed by session id.

const scratchpadMaxBytes = 200_000

func scratchpadPath(sid string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".rook", "scratchpads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, sid+".md"), nil
}

// GET /api/scratchpad?sessionId= — returns the saved notes (empty if none).
func handleScratchpadGet(ctx *gofr.Context) (any, error) {
	sid := ctx.Param("sessionId")
	if !validSessionID(sid) {
		return nil, errf(http.StatusBadRequest, "sessionId required")
	}
	p, err := scratchpadPath(sid)
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	b, _ := os.ReadFile(p) // missing file = empty scratchpad
	return rawJSON(map[string]any{"sessionId": sid, "content": string(b)})
}

type scratchpadReq struct {
	SessionID string `json:"sessionId"`
	Content   string `json:"content"`
}

// POST /api/scratchpad {sessionId, content} — persists the notes.
func handleScratchpadPost(ctx *gofr.Context) (any, error) {
	var req scratchpadReq
	if err := ctx.Bind(&req); err != nil || !validSessionID(req.SessionID) {
		return nil, errf(http.StatusBadRequest, "sessionId required")
	}
	if len(req.Content) > scratchpadMaxBytes {
		return nil, errf(http.StatusRequestEntityTooLarge, "scratchpad too large")
	}
	p, err := scratchpadPath(req.SessionID)
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	if err := os.WriteFile(p, []byte(req.Content), 0o644); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true})
}
