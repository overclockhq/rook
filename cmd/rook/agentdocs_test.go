package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectAgentDocs(t *testing.T) {
	dir := t.TempDir()
	// present: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md
	must := func(p, body string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must(filepath.Join(dir, "AGENTS.md"), "agents")
	must(filepath.Join(dir, "CLAUDE.md"), "claude")
	must(filepath.Join(dir, ".github", "copilot-instructions.md"), "copilot")
	// absent: .cursorrules, CONTRIBUTING.md

	got := detectAgentDocs(dir)
	names := map[string]bool{}
	for _, d := range got {
		names[d.Rel] = true
	}
	for _, want := range []string{"AGENTS.md", "CLAUDE.md", filepath.Join(".github", "copilot-instructions.md")} {
		if !names[want] {
			t.Errorf("expected %s to be detected, got %+v", want, got)
		}
	}
	if names["CONTRIBUTING.md"] || names[".cursorrules"] {
		t.Errorf("detected a file that does not exist: %+v", got)
	}
	// priority order: AGENTS.md must come before CLAUDE.md
	if len(got) < 2 || got[0].Rel != "AGENTS.md" || got[1].Rel != "CLAUDE.md" {
		t.Errorf("priority order wrong: %+v", got)
	}
}
