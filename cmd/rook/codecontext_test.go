package main

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFile is a tiny helper that fails the test on any write error.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// TestSearchCodeFindsToken pins that searchCode locates a known token in every
// file that contains it, with the correct line number, regardless of whether the
// active tool is rg or the grep fallback (the temp dir is not a git repo).
func TestSearchCodeFindsToken(t *testing.T) {
	dir := t.TempDir()

	// NEEDLE_abc lands on line 2 of a.txt and line 3 of b.go.
	writeFile(t, filepath.Join(dir, "a.txt"), "first line\nNEEDLE_abc here\n")
	writeFile(t, filepath.Join(dir, "b.go"), "package x\n// nothing\nNEEDLE_abc token\n")

	matches, err := searchCode(dir, "NEEDLE_abc", 100)
	if err != nil {
		t.Fatalf("searchCode error: %v", err)
	}

	// Expected line number per file basename.
	wantLine := map[string]int{"a.txt": 2, "b.go": 3}
	got := map[string]int{}
	for _, m := range matches {
		got[filepath.Base(m.File)] = m.Line
	}

	if len(got) != len(wantLine) {
		t.Fatalf("expected matches in %d files, got %d: %+v", len(wantLine), len(got), matches)
	}
	for name, line := range wantLine {
		if got[name] != line {
			t.Errorf("file %s: want line %d, got %d (matches: %+v)", name, line, got[name], matches)
		}
	}
}

// TestSearchCodeEmptyQuery pins that an empty/whitespace query is rejected before
// any search runs.
func TestSearchCodeEmptyQuery(t *testing.T) {
	dir := t.TempDir()
	if _, err := searchCode(dir, "   ", 100); err == nil {
		t.Fatal("expected error for empty query, got nil")
	}
}

// TestSearchCodeNoMatches pins that a token that appears nowhere yields zero
// matches and no error (grep/git exit status 1 is a normal "not found").
func TestSearchCodeNoMatches(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.txt"), "nothing interesting here\n")

	matches, err := searchCode(dir, "NEEDLE_does_not_exist_xyz", 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected 0 matches, got %d: %+v", len(matches), matches)
	}
}

// TestSearchCodeBadDir pins that a non-existent directory is rejected.
func TestSearchCodeBadDir(t *testing.T) {
	if _, err := searchCode(filepath.Join(t.TempDir(), "nope"), "x", 100); err == nil {
		t.Fatal("expected error for missing dir, got nil")
	}
}

// TestSearchCodeGitUntracked pins the regression where git-grep skipped
// not-yet-committed files: a fresh git repo whose file is untracked must still
// be searchable (fixed by passing --untracked to git grep).
func TestSearchCodeGitUntracked(t *testing.T) {
	if _, err := execWithTimeout("git", codeContextTimeout, "--version"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	if out, err := execWithTimeout("git", codeContextTimeout, "-C", dir, "init", "-q"); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
	// untracked file (never git add'd) — the exact case that returned 0 before.
	writeFile(t, filepath.Join(dir, "untracked.go"), "package x\n// TOKEN_UNTRACKED_xyz marker\n")
	m, err := searchCode(dir, "TOKEN_UNTRACKED_xyz", 100)
	if err != nil {
		t.Fatalf("searchCode: %v", err)
	}
	if len(m) == 0 {
		t.Fatalf("untracked file not found — git grep must use --untracked")
	}
}
