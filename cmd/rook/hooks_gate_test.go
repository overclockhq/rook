package main

import (
	"os/exec"
	"strings"
	"testing"
)

// TestDangerReasonCaseInsensitive pins that the block gate catches lowercase
// destructive SQL (it used to only match the SQL-shouted form) and the core
// catastrophic commands, while leaving ordinary commands alone.
func TestDangerReasonCaseInsensitive(t *testing.T) {
	cases := map[string]bool{
		"DROP TABLE users":             true,
		"drop table users":             true, // lowercase — previously missed
		"rm -rf /":                     true,
		"rm -rf $HOME":                 true,
		"git push --force origin main": true,
		"go test ./...":                false,
		"git push origin feature":      false,
		"rm -rf ./build":               false, // relative path, not root/home
	}
	for cmd, want := range cases {
		got := dangerReason("Bash", map[string]any{"command": cmd}) != ""
		if got != want {
			t.Errorf("dangerReason(%q) = %v, want %v", cmd, got, want)
		}
	}
}

// TestBackstopPattern runs the fail-safe denylist through the REAL grep on this
// platform (BSD or GNU), the same way the installed hook script does when rook
// is unreachable — so a portability bug in the ERE can't slip through.
func TestBackstopPattern(t *testing.T) {
	if _, err := exec.LookPath("grep"); err != nil {
		t.Skip("grep unavailable")
	}
	grepMatch := func(payload string) bool {
		cmd := exec.Command("grep", "-Eiq", backstopPattern)
		cmd.Stdin = strings.NewReader(payload)
		return cmd.Run() == nil // exit 0 = matched
	}
	pay := func(command string) string {
		return `{"hook_event_name":"PreToolUse","tool_input":{"command":"` + command + `"}}`
	}
	block := []string{"rm -rf /", "rm -rf $HOME", "drop table users", "git push --force origin main", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda"}
	allow := []string{"go test ./...", "rm -rf ./build", "git push origin feature", "ls -la", "echo hello"}
	for _, c := range block {
		if !grepMatch(pay(c)) {
			t.Errorf("backstop should BLOCK %q when rook is down", c)
		}
	}
	for _, c := range allow {
		if grepMatch(pay(c)) {
			t.Errorf("backstop should ALLOW %q", c)
		}
	}
}

// TestHookScriptFailSafe runs the ACTUAL generated wrapper with rook "down"
// (a dead port) and confirms it fails SAFE: a catastrophic PreToolUse command
// is denied, an ordinary one is allowed (no output), and non-PreToolUse events
// never emit a decision. This is the fail-open bug's regression test.
func TestHookScriptFailSafe(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	script := buildHookScript(59) // port 59 = nothing listening → rook "down"
	// the generated wrapper must be valid POSIX sh
	syn := exec.Command("sh", "-n")
	syn.Stdin = strings.NewReader(script)
	if out, err := syn.CombinedOutput(); err != nil {
		t.Fatalf("generated hook script is not valid sh: %v\n%s", err, out)
	}
	run := func(payload string) string {
		cmd := exec.Command("sh", "-c", script)
		cmd.Stdin = strings.NewReader(payload)
		out, _ := cmd.Output()
		return string(out)
	}
	danger := `{"hook_event_name":"PreToolUse","tool_input":{"command":"rm -rf /"}}`
	if !strings.Contains(run(danger), `"permissionDecision":"deny"`) {
		t.Errorf("rook down + catastrophic command should be DENIED by the backstop")
	}
	safe := `{"hook_event_name":"PreToolUse","tool_input":{"command":"go test ./..."}}`
	if out := run(safe); strings.TrimSpace(out) != "" {
		t.Errorf("rook down + safe command should emit nothing (allow), got %q", out)
	}
	other := `{"hook_event_name":"Stop"}`
	if out := run(other); strings.TrimSpace(out) != "" {
		t.Errorf("non-PreToolUse event should never emit a decision, got %q", out)
	}
}
