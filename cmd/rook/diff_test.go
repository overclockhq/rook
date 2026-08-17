package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitFixture builds a temp repo with one commit on main, then a worktree-like
// dirty state: a modified tracked file, a deleted file, and a new untracked
// file. It returns the repo dir. All changes are uncommitted so the diff-vs-base
// path (base == HEAD fallback or merge-base) must surface them.
func gitFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-q", "-b", "main")
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("keep.txt", "one\ntwo\nthree\n")
	write("gone.txt", "delete me\n")
	run("add", "-A")
	run("commit", "-q", "-m", "base")

	// dirty state relative to HEAD
	write("keep.txt", "one\ntwo\nthree\nfour\n") // +1 line
	if err := os.Remove(filepath.Join(dir, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	write("new.txt", "brand new\nsecond\n") // untracked, +2
	return dir
}

func TestComputeDiff_capturesModifyDeleteUntracked(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := gitFixture(t)

	res, err := computeDiff(dir)
	if err != nil {
		t.Fatalf("computeDiff: %v", err)
	}

	byPath := map[string]diffFile{}
	for _, f := range res.Files {
		byPath[f.Path] = f
	}

	// modified tracked file
	if f, ok := byPath["keep.txt"]; !ok {
		t.Errorf("keep.txt not in diff files: %+v", res.Files)
	} else if f.Status != "M" || f.Add != 1 {
		t.Errorf("keep.txt: got status=%q add=%d, want M/+1", f.Status, f.Add)
	}
	// deleted file
	if f, ok := byPath["gone.txt"]; !ok {
		t.Errorf("gone.txt (deleted) not in diff files")
	} else if f.Status != "D" {
		t.Errorf("gone.txt: got status=%q, want D", f.Status)
	}
	// untracked file surfaced as added
	if f, ok := byPath["new.txt"]; !ok {
		t.Errorf("new.txt (untracked) not in diff files")
	} else if f.Status != "?" || f.Add != 2 {
		t.Errorf("new.txt: got status=%q add=%d, want ?/+2", f.Status, f.Add)
	}

	// the patch text must contain the actual hunks for review
	for _, want := range []string{"keep.txt", "new.txt", "+four", "+brand new"} {
		if !strings.Contains(res.Patch, want) {
			t.Errorf("patch missing %q\n---\n%s", want, res.Patch)
		}
	}
	if res.Add < 3 { // +1 (keep) +2 (new)
		t.Errorf("total add=%d, want >=3", res.Add)
	}
}

func TestComputeDiff_rejectsNonRepo(t *testing.T) {
	dir := t.TempDir() // not a git repo
	if _, err := computeDiff(dir); err == nil {
		t.Fatal("expected error for non-git directory, got nil")
	}
}

// TestPRNumGuard pins that only a bare number reaches the gh command line, so a
// crafted ?pr= value can't inject into `gh pr diff`.
func TestPRNumGuard(t *testing.T) {
	for _, ok := range []string{"1", "2569", "100000"} {
		if !prNumRe.MatchString(ok) {
			t.Errorf("%q should be accepted as a PR number", ok)
		}
	}
	for _, bad := range []string{"", "2569;rm -rf", "2569 ", "abc", "-5", "2569&&x", "$(id)"} {
		if prNumRe.MatchString(bad) {
			t.Errorf("%q must be rejected as a PR number", bad)
		}
	}
	// prDiffByNumber refuses a bad number outright (no gh call)
	if _, ok := prDiffByNumber("/tmp", "2569;rm -rf"); ok {
		t.Error("prDiffByNumber must reject a non-numeric pr")
	}
}
