package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gofr.dev/pkg/gofr"
)

var imageNoiseRe = regexp.MustCompile(`\[Image #\d+\]`)

// SessionMsg is one meaningful user prompt inside the date window.
type SessionMsg struct {
	Time string `json:"time"` // HH:MM
	Date string `json:"date"` // YYYY-MM-DD
	Text string `json:"text"`
}

// ProjectActivity groups a project's local Claude Code prompts in the window.
type ProjectActivity struct {
	Project  string       `json:"project"`
	CWD      string       `json:"cwd"`
	Messages []SessionMsg `json:"messages"`
}

// activityLine is the subset of a transcript line we need for activity scanning.
type activityLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	CWD       string `json:"cwd"`
	Message   *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// claudeActivity scans every project transcript for user prompts whose timestamp
// falls in [start,end] (inclusive dates). Applies the daily-summary filter rules:
// skip agentpeek, drop command/tool noise, skip very short prompts, dedupe.
func claudeActivity(start, end string) []ProjectActivity {
	files, _ := filepath.Glob(filepath.Join(claudeDir(), "projects", "*", "*.jsonl"))
	byProj := map[string]*ProjectActivity{}
	seen := map[string]bool{}

	for _, fp := range files {
		if strings.Contains(strings.ToLower(fp), "agentpeek") {
			continue // skip rook's own sessions
		}
		f, err := os.Open(fp)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			var al activityLine
			if json.Unmarshal(line, &al) != nil || al.Type != "user" || al.Message == nil {
				continue
			}
			if len(al.Timestamp) < 10 {
				continue
			}
			date := al.Timestamp[:10]
			if date < start || date > end {
				continue
			}
			text := userText(al.Message.Content)
			if len([]rune(text)) < 15 {
				continue // approvals / short prompts
			}
			cwd := al.CWD
			if cwd != "" && strings.Contains(strings.ToLower(cwd), "agentpeek") {
				continue
			}
			key := cwd + "|"
			if len(text) > 70 {
				key += text[:70]
			} else {
				key += text
			}
			if seen[key] {
				continue
			}
			seen[key] = true

			pa := byProj[cwd]
			if pa == nil {
				pa = &ProjectActivity{Project: projectName(cwd), CWD: cwd}
				byProj[cwd] = pa
			}
			tm := ""
			if len(al.Timestamp) >= 16 {
				tm = al.Timestamp[11:16]
			}
			if len(pa.Messages) < 80 {
				pa.Messages = append(pa.Messages, SessionMsg{Time: tm, Date: date, Text: clip(text, 240)})
			}
		}
		f.Close()
	}

	out := make([]ProjectActivity, 0, len(byProj))
	for _, pa := range byProj {
		sort.Slice(pa.Messages, func(i, j int) bool {
			if pa.Messages[i].Date != pa.Messages[j].Date {
				return pa.Messages[i].Date < pa.Messages[j].Date
			}
			return pa.Messages[i].Time < pa.Messages[j].Time
		})
		out = append(out, *pa)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Project < out[j].Project })
	return out
}

// userText extracts plain prompt text from a user message's content (string or
// block array), dropping command/tool-result noise.
func userText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return cleanUserText(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return cleanUserText(strings.Join(parts, " "))
	}
	return ""
}

func cleanUserText(s string) string {
	if strings.Contains(s, "<local-command-caveat>") ||
		strings.Contains(s, "<command-name>") ||
		strings.Contains(s, "<command-message>") ||
		strings.Contains(s, "tool_use_id") ||
		strings.Contains(s, "tool-use-id") {
		return ""
	}
	s = imageNoiseRe.ReplaceAllString(s, "")
	s = oneLine(s)
	if strings.HasPrefix(s, "[Request interrupted") {
		return "" // system interruption marker, not a real prompt
	}
	return s
}

// handleClaudeActivity returns local Claude Code activity for a date window.
func handleClaudeActivity(ctx *gofr.Context) (any, error) {
	start := ctx.Param("start")
	end := ctx.Param("end")
	if len(start) < 10 || len(end) < 10 {
		return nil, errf(400, "start and end (YYYY-MM-DD) required")
	}
	return rawJSON(claudeActivity(start, end))
}
