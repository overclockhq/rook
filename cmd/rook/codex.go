package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// codexDir returns ~/.codex (honoring CODEX_HOME if set).
func codexDir() string {
	if d := os.Getenv("CODEX_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

// ScanCodexSessions reads OpenAI Codex CLI rollout files
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) and normalizes them into
// Sessions. Codex has no live PID/status file like Claude, so "alive" and
// status are inferred from recency. BETA: the rollout schema is only partly
// public, so parsing is defensive and may miss fields until verified against
// real data.
func ScanCodexSessions(maxTools int) []Session {
	base := filepath.Join(codexDir(), "sessions")
	if _, err := os.Stat(base); err != nil {
		return nil // Codex not installed / no sessions
	}
	// rollout-*.jsonl nested under YYYY/MM/DD
	files, _ := filepath.Glob(filepath.Join(base, "*", "*", "*", "rollout-*.jsonl"))
	if len(files) == 0 {
		// fall back to any depth-agnostic layout
		files, _ = filepath.Glob(filepath.Join(base, "**", "rollout-*.jsonl"))
	}

	now := time.Now()
	cutoff := now.Add(-14 * 24 * time.Hour) // only recent sessions
	var out []Session
	for _, fp := range files {
		fi, err := os.Stat(fp)
		if err != nil || fi.ModTime().Before(cutoff) {
			continue
		}
		s := parseCodexRollout(fp, fi.ModTime(), now, maxTools)
		if s != nil {
			out = append(out, *s)
		}
	}
	return out
}

func parseCodexRollout(path string, mtime, now time.Time, maxTools int) *Session {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	s := &Session{
		Provider:  "codex",
		SessionID: codexIDFromName(filepath.Base(path)),
		UpdatedAt: mtime.UnixMilli(),
	}
	var tools []ToolCall
	var lastText string
	var tokensTotal int64

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	first := true
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var m map[string]any
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		// the payload may be nested under "payload" or be the object itself
		payload := m
		if p, ok := m["payload"].(map[string]any); ok {
			payload = p
		}
		ts := codexTS(m, payload)

		if first {
			first = false
			// header / SessionMeta
			s.SessionID = firstStr(payload, s.SessionID, "id", "session_id")
			s.CWD = firstStr(payload, "", "cwd", "workdir")
			s.Project = projectName(s.CWD)
			s.Model = firstStr(payload, "", "model", "model_provider", "provider")
			if gb := firstStr(payload, "", "git_branch"); gb != "" {
				s.Version = gb // reuse "version" column to surface branch; harmless
			}
			if ts > 0 {
				s.StartedAt = ts
			}
			continue
		}

		typ := strings.ToLower(firstStr(m, firstStr(payload, "", "type", "kind"), "type", "kind"))
		switch {
		case strings.Contains(typ, "function") || strings.Contains(typ, "tool") || strings.Contains(typ, "command") || strings.Contains(typ, "exec"):
			name := firstStr(payload, "tool", "name", "tool_name", "command")
			tools = append(tools, ToolCall{
				Name:      codexToolName(name),
				Summary:   oneLine(firstStr(payload, "", "arguments", "command", "input", "cmd")),
				Timestamp: ts,
			})
		case strings.Contains(typ, "message") || strings.Contains(typ, "response") || strings.Contains(typ, "text"):
			if t := oneLine(codexText(payload)); t != "" {
				lastText = t
			}
		case strings.Contains(typ, "token") || strings.Contains(typ, "usage"):
			tokensTotal += codexTokens(payload)
		}
	}

	if s.SessionID == "" {
		return nil
	}
	if s.Title == "" {
		s.Title = firstNonEmpty(s.Project, "codex session")
	}
	s.TokensTotal = tokensTotal

	// recency-based liveness (Codex has no PID/status file)
	age := now.Sub(mtime)
	s.Alive = age < 10*time.Minute
	switch {
	case age < 90*time.Second:
		s.Status = "busy"
	case s.Alive:
		s.Status = "idle"
	default:
		s.Status = "idle"
	}
	s.Activity = deriveCodexActivity(s.Status, tools, lastText)
	s.Summary = codexSummary(tools)

	// most-recent tools first, capped
	for i, j := 0, len(tools)-1; i < j; i, j = i+1, j-1 {
		tools[i], tools[j] = tools[j], tools[i]
	}
	if maxTools > 0 && len(tools) > maxTools {
		tools = tools[:maxTools]
	}
	s.ToolCalls = tools
	return s
}

func deriveCodexActivity(status string, tools []ToolCall, lastText string) string {
	if status == "busy" && len(tools) > 0 {
		t := tools[len(tools)-1]
		if t.Summary != "" {
			return "Running " + t.Name + ": " + t.Summary
		}
		return "Running " + t.Name
	}
	if lastText != "" {
		return lastText
	}
	return ""
}

func codexSummary(tools []ToolCall) string {
	if len(tools) == 0 {
		return "No tool activity yet."
	}
	return plural(len(tools), "tool call", "tool calls")
}

// ---------- codex parsing helpers ----------

func codexIDFromName(name string) string {
	// rollout-2026-07-13T10-00-00-<uuid>.jsonl → use the slug (timestamp+uuid)
	n := strings.TrimSuffix(name, ".jsonl")
	return strings.TrimPrefix(n, "rollout-")
}

func codexToolName(raw string) string {
	if raw == "" {
		return "tool"
	}
	if strings.Contains(strings.ToLower(raw), "shell") || strings.Contains(raw, "bash") {
		return "Shell"
	}
	return raw
}

func firstStr(m map[string]any, def string, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return def
}

func codexTS(m, payload map[string]any) int64 {
	for _, src := range []map[string]any{m, payload} {
		if v, ok := src["timestamp"].(string); ok {
			if t := parseTS(v); t > 0 {
				return t
			}
		}
		if v, ok := src["ts"].(string); ok {
			if t := parseTS(v); t > 0 {
				return t
			}
		}
	}
	return 0
}

// codexText extracts assistant text from a message-like payload.
func codexText(payload map[string]any) string {
	if s, ok := payload["text"].(string); ok {
		return s
	}
	// content may be an array of {type,text}
	if arr, ok := payload["content"].([]any); ok {
		var b strings.Builder
		for _, it := range arr {
			if mm, ok := it.(map[string]any); ok {
				if t, ok := mm["text"].(string); ok {
					b.WriteString(t)
				}
			}
		}
		return b.String()
	}
	return ""
}

func codexTokens(payload map[string]any) int64 {
	var total int64
	for _, k := range []string{"total_tokens", "total", "input_tokens", "output_tokens", "tokens"} {
		if v, ok := payload[k].(float64); ok {
			total += int64(v)
		}
	}
	// nested usage object
	if u, ok := payload["usage"].(map[string]any); ok {
		total += codexTokens(u)
	}
	return total
}
