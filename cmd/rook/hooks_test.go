package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDangerReason(t *testing.T) {
	cases := []struct {
		cmd   string
		block bool
	}{
		{"rm -rf /", true},
		{"rm -rf ~/", true},
		{"git push --force origin main", true},
		{"DROP TABLE users", true},
		{"rm -rf ./build", false},
		{"git push origin feature/x", false},
		{"go test ./...", false},
		{"ls -la", false},
	}
	for _, c := range cases {
		input := map[string]any{"command": c.cmd}
		got := dangerReason("Bash", input) != ""
		if got != c.block {
			t.Errorf("dangerReason(%q) = %v, want block=%v", c.cmd, got, c.block)
		}
	}
}

// TestMergeHooks verifies rook adds its entries without clobbering the user's
// own settings/hooks, and removes only its own on uninstall.
func TestMergeHooks(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", tmp)

	// pre-existing settings with a user hook that must survive
	pre := map[string]any{
		"model": "opus",
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{"matcher": "Bash", "hooks": []any{map[string]any{"type": "command", "command": "my-own-hook.sh"}}},
			},
		},
	}
	b, _ := json.MarshalIndent(pre, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, "settings.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := mergeHooksIntoSettings(true); err != nil {
		t.Fatalf("install merge: %v", err)
	}
	got := readSettings(t, tmp)
	if got["model"] != "opus" {
		t.Errorf("install clobbered unrelated key 'model': %v", got["model"])
	}
	if !hooksInstalled() {
		t.Error("hooksInstalled() false after install")
	}
	raw, _ := json.Marshal(got)
	if !contains(string(raw), "my-own-hook.sh") {
		t.Error("install removed the user's own hook")
	}
	if !contains(string(raw), hookMarker) {
		t.Error("install did not add rook's hook")
	}

	if err := mergeHooksIntoSettings(false); err != nil {
		t.Fatalf("uninstall merge: %v", err)
	}
	got = readSettings(t, tmp)
	raw, _ = json.Marshal(got)
	if contains(string(raw), hookMarker) {
		t.Error("uninstall left rook's hook behind")
	}
	if !contains(string(raw), "my-own-hook.sh") {
		t.Error("uninstall removed the user's own hook")
	}
	if got["model"] != "opus" {
		t.Error("uninstall clobbered unrelated key")
	}
}

func readSettings(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
