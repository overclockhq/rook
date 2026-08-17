package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

// pastSession is a resumable Claude session discovered from its on-disk
// transcript. Transcripts persist after the tmux pane / process is gone, so this
// is how rook surfaces sessions you closed and lets you pick up where you left
// off — `claude --resume` keeps the same session id, context, and history.
type pastSession struct {
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
	Project   string `json:"project"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updatedAt"` // transcript mtime, ms
	Alive     bool   `json:"alive"`     // currently running (already in the roster)
}

// transcriptMeta reads just enough of a transcript to describe it: the working
// directory, and a human title (the AI-generated title if present, else the
// first user prompt).
func transcriptMeta(path string) (cwd, title string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	var firstPrompt string
	for sc.Scan() {
		var o struct {
			Type    string `json:"type"`
			CWD     string `json:"cwd"`
			AITitle string `json:"aiTitle"`
			Message *struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &o) != nil {
			continue
		}
		if cwd == "" && o.CWD != "" {
			cwd = o.CWD
		}
		if title == "" && o.AITitle != "" {
			title = o.AITitle
		}
		if firstPrompt == "" && o.Type == "user" && o.Message != nil {
			firstPrompt = firstUserText(o.Message.Content)
		}
		if cwd != "" && title != "" {
			break
		}
	}
	if title == "" {
		title = firstPrompt
	}
	title = strings.TrimSpace(strings.Join(strings.Fields(title), " "))
	// rune-safe cut: title[:90] could split a multibyte UTF-8 char into invalid bytes
	if r := []rune(title); len(r) > 90 {
		title = string(r[:90]) + "…"
	}
	return cwd, title
}

// firstUserText pulls the first human-authored text out of a transcript user
// message, whose content is either a plain string or an array of typed blocks.
func firstUserText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				return b.Text
			}
		}
	}
	return ""
}

// listPastSessions returns resumable sessions from transcripts, newest first,
// each flagged with whether it is currently running.
func listPastSessions(limit int) []pastSession {
	files, _ := filepath.Glob(filepath.Join(claudeDir(), "projects", "*", "*.jsonl"))

	alive := map[string]bool{}
	for _, s := range ScanSessions(0) {
		if s.Alive {
			alive[s.SessionID] = true
		}
	}

	type fileMeta struct {
		path  string
		mtime int64
	}
	metas := make([]fileMeta, 0, len(files))
	for _, f := range files {
		fi, err := os.Stat(f)
		if err != nil {
			continue
		}
		// skip stub transcripts (a session-start line and little else) — they
		// show up as bare project-name rows with nothing to resume into.
		if fi.Size() < 1024 {
			continue
		}
		metas = append(metas, fileMeta{f, fi.ModTime().UnixMilli()})
	}
	sort.Slice(metas, func(i, j int) bool { return metas[i].mtime > metas[j].mtime })

	out := make([]pastSession, 0, limit)
	for _, m := range metas {
		id := strings.TrimSuffix(filepath.Base(m.path), ".jsonl")
		if !validSessionID(id) {
			continue
		}
		cwd, title := transcriptMeta(m.path)
		ps := pastSession{
			SessionID: id,
			CWD:       cwd,
			Project:   projectName(cwd),
			Title:     title,
			UpdatedAt: m.mtime,
			Alive:     alive[id],
		}
		if ps.Title == "" {
			ps.Title = ps.Project
		}
		out = append(out, ps)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

// handleSessionHistory lists past (resumable) sessions from transcripts.
func handleSessionHistory(ctx *gofr.Context) (any, error) {
	limit := 60
	if n, err := strconv.Atoi(ctx.Param("limit")); err == nil && n > 0 && n <= 300 {
		limit = n
	}
	return rawJSON(listPastSessions(limit))
}

type resumeReq struct {
	SessionID string `json:"sessionId"`
}

// handleResume reopens a closed session with its full context by launching
// `claude --resume <id>` in the session's original working directory. Claude
// continues the same session id, so rook re-detects it as that exact session.
func handleResume(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux is required to resume a session")
	}
	var req resumeReq
	if err := ctx.Bind(&req); err != nil || !validSessionID(req.SessionID) {
		return nil, errf(http.StatusBadRequest, "a valid sessionId is required")
	}
	// already running → nothing to do; the client should just open it
	for _, s := range ScanSessions(0) {
		if s.SessionID == req.SessionID && s.Alive {
			return rawJSON(map[string]any{"ok": true, "already": true, "sessionId": req.SessionID, "cwd": s.CWD})
		}
	}
	tp := findTranscript(req.SessionID)
	if tp == "" {
		return nil, errf(http.StatusNotFound, "no transcript found for that session")
	}
	cwd, _ := transcriptMeta(tp)
	if cwd == "" {
		return nil, errf(http.StatusUnprocessableEntity, "couldn't determine the session's working directory")
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, errf(http.StatusConflict, "the session's working directory no longer exists: %s", cwd)
	}
	name := "resume-" + shortID(req.SessionID) + "-" + fmt.Sprint(time.Now().Unix()%100000)
	if _, _, code, err := spawnAgentSession(spawnReq{Name: name, CWD: cwd, Agent: "claude", Resume: req.SessionID}); err != nil {
		return nil, errf(code, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "sessionId": req.SessionID, "cwd": cwd, "tmux": name})
}

// shortID compacts a UUID for use in a tmux session name.
func shortID(id string) string {
	id = strings.ReplaceAll(id, "-", "")
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
