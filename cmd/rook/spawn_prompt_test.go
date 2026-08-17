package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPaneReady(t *testing.T) {
	// the splash alone is NOT ready
	splash := "Welcome back Piyush!\n Tips for getting started\n Run /init ..."
	if paneReady(splash) {
		t.Fatalf("splash should not be considered ready")
	}
	// a bare "❯" is NOT ready: it is also the trust-menu selection cursor, so
	// treating it as ready made us type the prompt into the trust dialog.
	if paneReady("❯ 1. Yes, I trust this folder") {
		t.Fatalf("bare ❯ cursor should not be considered ready")
	}
	// once the REPL status line / input is drawn, it's ready
	for _, ready := range []string{
		"⏸ manual mode on · ? for shortcuts · 1 agent",
		"esc to interrupt",
		"accept edits",
	} {
		if !paneReady(ready) {
			t.Fatalf("expected ready for %q", ready)
		}
	}
}

func TestPaneHasTrustDialog(t *testing.T) {
	trust := " Security guide\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel"
	if !paneHasTrustDialog(trust) {
		t.Fatalf("first-run trust dialog should be detected")
	}
	// the real REPL is not a trust dialog
	repl := "❯ Try \"edit <filepath>\"\n ⏸ manual mode on · ? for shortcuts"
	if paneHasTrustDialog(repl) {
		t.Fatalf("interactive REPL should not be flagged as a trust dialog")
	}
}

func TestPaneHasPrompt(t *testing.T) {
	prompt := "Review GitHub pull request #134 in zopdev/notification: read the diff…"
	// input still empty (placeholder) → not entered
	if paneHasPrompt("❯ Try \"fix lint errors\"", prompt) {
		t.Fatalf("empty input should not match the prompt")
	}
	// prompt text visible in the input → entered
	if !paneHasPrompt("❯ Review GitHub pull request #134 in zopdev/notif", prompt) {
		t.Fatalf("prompt text in pane should match")
	}
	// empty prompt is trivially 'entered'
	if !paneHasPrompt("anything", "") {
		t.Fatalf("empty prompt should be treated as entered")
	}
}

// TestSendInitialPrompt_Live spawns a real claude in a brand-new (untrusted)
// directory and verifies the prompt lands past the first-run trust dialog.
// Gated behind ROOK_LIVE_CLAUDE=1 because it needs a logged-in claude CLI.
func TestSendInitialPrompt_Live(t *testing.T) {
	if os.Getenv("ROOK_LIVE_CLAUDE") != "1" {
		t.Skip("set ROOK_LIVE_CLAUDE=1 to run the live trust-dialog test")
	}
	if tmuxBin == "" {
		t.Skip("tmux not available")
	}
	dir := t.TempDir()
	_ = exec.Command("git", "-C", dir, "init").Run()
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("hi"), 0o644)

	target := "rook_live_trust"
	_, _ = runTmux("kill-session", "-t", target)
	if _, err := runTmux("new-session", "-d", "-s", target, "-x", "220", "-y", "50", "-c", dir, "claude"); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	defer runTmux("kill-session", "-t", target)

	prompt := "ROOK_LIVE_MARKER please just wait"
	sendInitialPrompt(target, prompt)
	time.Sleep(1500 * time.Millisecond)
	out, _ := runTmux("capture-pane", "-p", "-t", target)
	pane := string(out)
	if paneHasTrustDialog(pane) {
		t.Fatalf("trust dialog still showing; not dismissed:\n%s", pane)
	}
	if !strings.Contains(pane, "ROOK_LIVE_MARKER") {
		t.Fatalf("prompt did not land in a fresh dir:\n%s", pane)
	}
}

func TestPaneHasBypassWarning(t *testing.T) {
	warn := " WARNING: Claude Code running in Bypass Permissions mode\n ❯ 1. No, exit\n   2. Yes, I accept"
	if !paneHasBypassWarning(warn) {
		t.Fatal("bypass-permissions warning should be detected")
	}
	if paneHasBypassWarning("❯ Try \"fix errors\"\n manual mode on") {
		t.Fatal("a normal REPL is not the bypass warning")
	}
	// the bypass-mode REPL status line reads as ready (so the prompt lands fast)
	if !paneReady("⏵⏵ bypass permissions on (shift+tab to cycle) · 1 agent") {
		t.Fatal("bypass-mode status line should count as a ready REPL")
	}
}
