package main

import (
	"path/filepath"
	"testing"
)

func TestSessionSpawnedByRook(t *testing.T) {
	wt := filepath.Join("/home/u", ".rook", "worktrees")
	spawned := map[string]bool{"review-pr-23-1785756085": true}
	panes := map[string]string{
		"%4": "review-pr-23-1785756085", // a rook-spawned tmux session
		"%9": "my-manual-shell",         // a hand-started terminal
	}

	cases := []struct {
		name string
		cwd  string
		pane string
		want bool
	}{
		{"worktree cwd is definitive", filepath.Join(wt, "review-pr-23-x"), "", true},
		{"worktree root itself", wt, "", true},
		{"live tmux session in registry", "/home/u/code/app", "%4", true},
		{"live tmux session not in registry", "/home/u/code/app", "%9", false},
		{"no pane, non-worktree cwd", "/home/u/code/app", "", false},
		{"sibling dir sharing prefix is not a worktree", wt + "-evil", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := sessionSpawnedByRook(c.cwd, c.pane, spawned, panes, wt)
			if got != c.want {
				t.Fatalf("cwd=%q pane=%q: got %v want %v", c.cwd, c.pane, got, c.want)
			}
		})
	}
}
