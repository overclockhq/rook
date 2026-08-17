package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"

	"gofr.dev/pkg/gofr"
)

// SearchHit is one transcript line matching a query.
type SearchHit struct {
	SessionID string `json:"sessionId"`
	Project   string `json:"project"`
	Snippet   string `json:"snippet"`
}

// searchTranscripts greps all Claude project transcripts for q (case-insensitive)
// and returns up to limit matches with a short snippet. One hit per session.
func searchTranscripts(q string, limit int) []SearchHit {
	q = strings.ToLower(strings.TrimSpace(q))
	if len(q) < 2 {
		return nil
	}
	files, _ := filepath.Glob(filepath.Join(claudeDir(), "projects", "*", "*.jsonl"))
	seen := map[string]bool{}
	out := []SearchHit{}
	for _, fp := range files {
		if strings.Contains(strings.ToLower(fp), "agentpeek") {
			continue
		}
		sid := strings.TrimSuffix(filepath.Base(fp), ".jsonl")
		if seen[sid] {
			continue
		}
		f, err := os.Open(fp)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			low := strings.ToLower(line)
			idx := strings.Index(low, q)
			if idx < 0 {
				continue
			}
			// build a readable snippet around the match
			text := userTextFromLine(line)
			if text == "" {
				text = line
			}
			li := strings.Index(strings.ToLower(text), q)
			start := li - 40
			if start < 0 {
				start = 0
			}
			end := li + 80
			if end > len(text) {
				end = len(text)
			}
			snip := strings.TrimSpace(text[start:end])
			if start > 0 {
				snip = "…" + snip
			}
			out = append(out, SearchHit{SessionID: sid, Project: projectFromPath(fp), Snippet: clip(snip, 180)})
			seen[sid] = true
			break
		}
		f.Close()
		if len(out) >= limit {
			break
		}
	}
	return out
}

// userTextFromLine best-effort extracts readable text from a transcript line.
func userTextFromLine(line string) string {
	// cheap: strip json noise, keep it simple — the snippet is approximate
	s := line
	for _, tag := range []string{`"text":"`, `"content":"`} {
		if i := strings.Index(s, tag); i >= 0 {
			s = s[i+len(tag):]
			if j := strings.Index(s, `"`); j > 0 {
				return oneLine(s[:j])
			}
		}
	}
	return ""
}

func projectFromPath(fp string) string {
	dir := filepath.Base(filepath.Dir(fp))
	// project dirs are cwd with '/' -> '-'; show the last path segment
	parts := strings.Split(strings.Trim(dir, "-"), "-")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return dir
}

func handleSearch(ctx *gofr.Context) (any, error) {
	hits := searchTranscripts(ctx.Param("q"), 50)
	if hits == nil {
		hits = []SearchHit{}
	}
	return rawJSON(hits)
}
