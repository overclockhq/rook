package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A synthetic rollout that matches the documented Codex shape: a SessionMeta
// header line, then timestamped RolloutLine items (function_call, message,
// token_count). Verifies the defensive parser extracts the essentials.
func TestParseCodexRollout(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "rollout-2026-07-14T10-00-00-abc123.jsonl")
	content := "" +
		`{"timestamp":"2026-07-14T10:00:00Z","type":"session_meta","payload":{"id":"abc123","cwd":"/Users/me/proj","model":"gpt-5-codex","git_branch":"main"}}` + "\n" +
		`{"timestamp":"2026-07-14T10:00:05Z","type":"function_call","payload":{"name":"shell","command":"go test ./..."}}` + "\n" +
		`{"timestamp":"2026-07-14T10:00:09Z","type":"message","payload":{"content":[{"type":"text","text":"Tests pass."}]}}` + "\n" +
		`{"timestamp":"2026-07-14T10:00:10Z","type":"token_count","payload":{"usage":{"total_tokens":1234}}}` + "\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 7, 14, 10, 1, 0, 0, time.UTC) // 1 min after → busy
	s := parseCodexRollout(fp, now.Add(-time.Minute), now, 40)
	if s == nil {
		t.Fatal("expected a session")
	}
	if s.Provider != "codex" {
		t.Fatalf("provider = %q", s.Provider)
	}
	if s.SessionID != "abc123" {
		t.Fatalf("id = %q", s.SessionID)
	}
	if s.Project != "proj" {
		t.Fatalf("project = %q", s.Project)
	}
	if s.Model != "gpt-5-codex" {
		t.Fatalf("model = %q", s.Model)
	}
	if s.TokensTotal != 1234 {
		t.Fatalf("tokens = %d", s.TokensTotal)
	}
	if len(s.ToolCalls) != 1 || s.ToolCalls[0].Name != "Shell" {
		t.Fatalf("tools = %+v", s.ToolCalls)
	}
	if !s.Alive || s.Status != "busy" {
		t.Fatalf("expected alive+busy for a 1-min-old session, got alive=%v status=%q", s.Alive, s.Status)
	}
}

func TestScanCodexSessions_NoDir(t *testing.T) {
	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), "does-not-exist"))
	if got := ScanCodexSessions(40); got != nil {
		t.Fatalf("expected nil when codex dir absent, got %d", len(got))
	}
}
