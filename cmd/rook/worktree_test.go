package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestUnderWorktreesDir(t *testing.T) {
	base := worktreesDir()
	if !underWorktreesDir(filepath.Join(base, "review-pr-1")) {
		t.Error("a child of the worktrees dir should be allowed")
	}
	if underWorktreesDir(base + "-evil") {
		t.Error("a sibling sharing the prefix must NOT be allowed")
	}
	if underWorktreesDir(base) {
		t.Error("the base dir itself is not a child")
	}
	if underWorktreesDir("/tmp/somewhere") {
		t.Error("an unrelated path must not be allowed")
	}
	if underWorktreesDir("") {
		t.Error("empty path must not be allowed")
	}
}

// TestRemoveWorktreeHonest pins that removeWorktree actually removes the tree and
// reports success only when the directory is gone — it used to discard every
// error and the handler returned {ok:true} over a no-op.
func TestRemoveWorktreeHonest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	repo := t.TempDir()
	git := func(args ...string) error {
		return exec.Command("git", append([]string{"-C", repo}, args...)...).Run()
	}
	_ = git("init")
	_ = git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")
	wt := filepath.Join(t.TempDir(), "wt")
	if out, err := exec.Command("git", "-C", repo, "worktree", "add", "--detach", wt).CombinedOutput(); err != nil {
		t.Fatalf("worktree add: %s", out)
	}
	if err := removeWorktree(wt); err != nil {
		t.Fatalf("removeWorktree returned error on a valid worktree: %v", err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("worktree dir should be gone after removal, stat err = %v", err)
	}

	// a dirty worktree is detected so the handler can refuse to discard work
	wt2 := filepath.Join(t.TempDir(), "wt2")
	if out, err := exec.Command("git", "-C", repo, "worktree", "add", "--detach", wt2).CombinedOutput(); err != nil {
		t.Fatalf("worktree add: %s", out)
	}
	if worktreeDirty(wt2) {
		t.Error("a fresh worktree should not be dirty")
	}
	if err := os.WriteFile(filepath.Join(wt2, "scratch.txt"), []byte("wip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !worktreeDirty(wt2) {
		t.Error("a worktree with an untracked file should be dirty")
	}
	_ = removeWorktree(wt2)
}
