package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func gitInitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	repo := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "tester")
	if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return repo
}

func TestGitToplevel(t *testing.T) {
	repo := gitInitRepo(t)
	if got := gitToplevel(repo); got == "" {
		t.Error("expected a toplevel for a git repo")
	}
	if got := gitToplevel(t.TempDir()); got != "" {
		t.Errorf("expected empty toplevel for a non-repo, got %q", got)
	}
}

func TestCreateWorktree_IsolatesCheckout(t *testing.T) {
	repo := gitInitRepo(t)
	home := t.TempDir()
	t.Setenv("HOME", home)

	wt, err := createWorktree(repo, "review-pr-1", 12345)
	if err != nil {
		t.Fatalf("createWorktree: %v", err)
	}
	// worktree is a separate directory containing the repo's files
	if _, err := os.Stat(filepath.Join(wt, "f.txt")); err != nil {
		t.Errorf("worktree missing repo files: %v", err)
	}
	if wt == repo {
		t.Error("worktree must not be the repo itself")
	}
	if !strings.Contains(wt, filepath.Join(".rook", "worktrees")) {
		t.Errorf("worktree should live under ~/.rook/worktrees, got %q", wt)
	}
	// git recognizes it as a linked worktree of the repo
	out, err := exec.Command("git", "-C", repo, "worktree", "list").CombinedOutput()
	if err != nil {
		t.Fatalf("worktree list: %s", out)
	}
	if !strings.Contains(string(out), wt) {
		t.Errorf("worktree not registered with repo:\n%s", out)
	}
	// it's on a named rook/ branch, not a detached HEAD
	br, _ := exec.Command("git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if got := strings.TrimSpace(string(br)); got != "rook/review-pr-1-12345" {
		t.Errorf("worktree should be on branch rook/review-pr-1-12345, got %q", got)
	}
}

// TestSendInitialPrompt_WaitsForBoot verifies the prompt is delivered only after
// the TUI stops changing (booting), not lost during the splash.
func TestSendInitialPrompt_WaitsForBoot(t *testing.T) {
	if tmuxBin == "" {
		t.Skip("tmux not available")
	}
	target := "rook_boottest"
	_, _ = runTmux("kill-session", "-t", target)
	// "boots" for ~3s (output keeps changing) then settles at a cat prompt.
	if _, err := runTmux("new-session", "-d", "-s", target, "-x", "100", "-y", "30",
		"bash", "-lc", "for i in 1 2 3; do clear; echo boot $i; sleep 1; done; clear; echo READY; cat"); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	defer runTmux("kill-session", "-t", target)

	sendInitialPrompt(target, "HELLO_ROOK_PROMPT")
	time.Sleep(600 * time.Millisecond)
	out, _ := runTmux("capture-pane", "-p", "-t", target)
	if !strings.Contains(string(out), "HELLO_ROOK_PROMPT") {
		t.Errorf("prompt not delivered after boot settle; pane:\n%s", out)
	}
}

func TestBuildLaunchCmd(t *testing.T) {
	valid := "cbcd2e95-f25a-4cd5-8baf-b9dae38e8496"
	cases := []struct {
		name, agent, resume, model string
		autonomous                 bool
		want                       string
		wantErr                    bool
	}{
		{name: "plain claude", agent: "claude", want: "claude"},
		{name: "default agent", agent: "", want: "claude"},
		{name: "codex", agent: "codex", want: "codex"},
		{name: "model alias", agent: "claude", model: "haiku", want: "claude --model haiku"},
		{name: "model default is no flag", agent: "claude", model: "default", want: "claude"},
		{name: "full model id", agent: "claude", model: "claude-haiku-4-5-20251001", want: "claude --model claude-haiku-4-5-20251001"},
		{name: "resume", agent: "claude", resume: valid, want: "claude --resume " + valid},
		{name: "resume + model", agent: "claude", resume: valid, model: "sonnet", want: "claude --resume " + valid + " --model sonnet"},
		{name: "autonomous claude skips permissions", agent: "claude", autonomous: true, want: "claude --dangerously-skip-permissions"},
		{name: "autonomous is claude-only", agent: "codex", autonomous: true, want: "codex"},
		{name: "bad model", agent: "claude", model: "gpt-4; rm -rf", wantErr: true},
		{name: "bad resume id", agent: "claude", resume: "not a uuid!", wantErr: true},
		{name: "resume non-claude", agent: "codex", resume: valid, wantErr: true},
		{name: "model non-claude", agent: "codex", model: "haiku", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := buildLaunchCmd(tc.agent, tc.resume, tc.model, tc.autonomous)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
