package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

// reviewCommentsSchema tracks inline review comments as threads with lifecycle
// state, so a comment survives restarts and the UI can show what's still open.
const reviewCommentsSchema = `CREATE TABLE IF NOT EXISTS review_comments (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	file       TEXT NOT NULL,
	line       INTEGER,
	side       TEXT,
	text       TEXT NOT NULL,
	state      TEXT NOT NULL DEFAULT 'open',
	created_at INTEGER NOT NULL
)`

// reviewComment is one inline review note routed (or routable) to the agent.
// state: open (not yet sent) → sent (delivered to the agent) → addressed (done).
type reviewComment struct {
	ID        int64  `json:"id"`
	SessionID string `json:"sessionId"`
	File      string `json:"file"`
	Line      int    `json:"line"`
	Side      string `json:"side"`
	Text      string `json:"text"`
	State     string `json:"state"`
	CreatedAt int64  `json:"createdAt"`
}

func addReviewComment(c reviewComment) (reviewComment, error) {
	c.CreatedAt = time.Now().UnixMilli()
	if c.State == "" {
		c.State = "open"
	}
	res, err := db.Exec(`INSERT INTO review_comments (session_id, file, line, side, text, state, created_at) VALUES (?,?,?,?,?,?,?)`,
		c.SessionID, c.File, c.Line, c.Side, c.Text, c.State, c.CreatedAt)
	if err != nil {
		return c, err
	}
	c.ID, _ = res.LastInsertId()
	return c, nil
}

func listReviewComments(sessionID string) ([]reviewComment, error) {
	rows, err := db.Query(`SELECT id, session_id, file, line, side, text, state, created_at
		FROM review_comments WHERE session_id = ? ORDER BY created_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []reviewComment{}
	for rows.Next() {
		var c reviewComment
		if err := rows.Scan(&c.ID, &c.SessionID, &c.File, &c.Line, &c.Side, &c.Text, &c.State, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func getReviewComment(id int64) (reviewComment, error) {
	var c reviewComment
	err := db.QueryRow(`SELECT id, session_id, file, line, side, text, state, created_at
		FROM review_comments WHERE id = ?`, id).Scan(&c.ID, &c.SessionID, &c.File, &c.Line, &c.Side, &c.Text, &c.State, &c.CreatedAt)
	return c, err
}

func setReviewCommentState(id int64, state string) error {
	_, err := db.Exec(`UPDATE review_comments SET state = ? WHERE id = ?`, state, id)
	return err
}

func deleteReviewComment(id int64) error {
	_, err := db.Exec(`DELETE FROM review_comments WHERE id = ?`, id)
	return err
}

// formatReviewComments turns comments into a single agent-facing message.
func formatReviewComments(cs []reviewComment) string {
	var b strings.Builder
	b.WriteString("Please address these review comments:\n")
	for _, c := range cs {
		b.WriteString("• " + c.File)
		if c.Line > 0 {
			b.WriteString(":" + strconv.Itoa(c.Line))
		}
		b.WriteString(" — " + c.Text + "\n")
	}
	return b.String()
}

// paneForSession resolves a session's live tmux pane, or "" if it has none.
func paneForSession(sid string) string {
	for _, s := range ScanSessions(0) {
		if s.SessionID == sid {
			return s.TmuxPane
		}
	}
	return ""
}

// POST /api/review/comment  {sessionId,file,line,side,text}
func handleAddReviewComment(ctx *gofr.Context) (any, error) {
	var c reviewComment
	if err := ctx.Bind(&c); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	if !validSessionID(c.SessionID) || strings.TrimSpace(c.Text) == "" {
		return nil, errf(http.StatusBadRequest, "sessionId and text are required")
	}
	if c.File == "" {
		c.File = "(general)"
	}
	saved, err := addReviewComment(c)
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(saved)
}

// GET /api/review/comments?sessionId=
func handleListReviewComments(ctx *gofr.Context) (any, error) {
	sid := ctx.Param("sessionId")
	if !validSessionID(sid) {
		return nil, errf(http.StatusBadRequest, "sessionId required")
	}
	cs, err := listReviewComments(sid)
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(cs)
}

// POST /api/review/comment/state {id, state}
func handleReviewCommentState(ctx *gofr.Context) (any, error) {
	var req struct {
		ID    int64  `json:"id"`
		State string `json:"state"`
	}
	if err := ctx.Bind(&req); err != nil || req.ID <= 0 {
		return nil, errf(http.StatusBadRequest, "id and state required")
	}
	if req.State != "open" && req.State != "addressed" && req.State != "sent" {
		return nil, errf(http.StatusBadRequest, "state must be open|sent|addressed")
	}
	if err := setReviewCommentState(req.ID, req.State); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true})
}

// DELETE /api/review/comment?id=
func handleDeleteReviewComment(ctx *gofr.Context) (any, error) {
	id, _ := strconv.ParseInt(ctx.Param("id"), 10, 64)
	if id <= 0 {
		return nil, errf(http.StatusBadRequest, "id required")
	}
	if err := deleteReviewComment(id); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true})
}

// POST /api/review/comment/send  {id} routes one comment; {sessionId} routes all
// open ones. Delivered to the agent's tmux pane as a single turn; sent comments
// flip to state=sent.
func handleSendReviewComment(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux is required to route comments to the agent")
	}
	var req struct {
		ID        int64  `json:"id"`
		SessionID string `json:"sessionId"`
	}
	if err := ctx.Bind(&req); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	var toSend []reviewComment
	switch {
	case req.ID > 0:
		c, err := getReviewComment(req.ID)
		if err != nil {
			return nil, errf(http.StatusNotFound, "comment not found")
		}
		toSend = []reviewComment{c}
	case validSessionID(req.SessionID):
		all, err := listReviewComments(req.SessionID)
		if err != nil {
			return nil, errf(http.StatusInternalServerError, "%v", err)
		}
		for _, c := range all {
			if c.State == "open" {
				toSend = append(toSend, c)
			}
		}
	default:
		return nil, errf(http.StatusBadRequest, "id or sessionId required")
	}
	if len(toSend) == 0 {
		return nil, errf(http.StatusConflict, "no open comments to send")
	}
	pane := paneForSession(toSend[0].SessionID)
	if pane == "" {
		return nil, errf(http.StatusConflict, "the agent is not in a tmux pane — can't route comments to it")
	}
	if code, err := applyKeyAction(pane, "text", formatReviewComments(toSend)); err != nil {
		return nil, errf(code, "%v", err)
	}
	for _, c := range toSend {
		_ = setReviewCommentState(c.ID, "sent")
	}
	return rawJSON(map[string]any{"ok": true, "sent": len(toSend)})
}
