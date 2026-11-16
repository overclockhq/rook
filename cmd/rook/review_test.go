package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestDetectVerifyCmd(t *testing.T) {
	dir := t.TempDir()
	if got := detectVerifyCmd(dir); got != "" {
		t.Errorf("empty dir: want no command, got %q", got)
	}
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module x\n"), 0o644)
	if got := detectVerifyCmd(dir); got == "" || got[:2] != "go" {
		t.Errorf("go project: want go command, got %q", got)
	}
}

// TestRunVerify runs a real command in a temp dir — no tokens, just proves the
// gate reports pass and fail correctly from the process exit code.
func TestRunVerify(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	dir := t.TempDir()

	pass := runVerify(dir, "true")
	if !pass.Ran || !pass.OK {
		t.Errorf("`true` should pass: %+v", pass)
	}

	fail := runVerify(dir, "echo boom >&2; false")
	if !fail.Ran || fail.OK {
		t.Errorf("`false` should fail: %+v", fail)
	}
	if fail.Output == "" {
		t.Errorf("failing command should capture output")
	}

	none := runVerify(dir, "") // empty dir, nothing detected
	if none.Ran {
		t.Errorf("no detectable command should not run: %+v", none)
	}
}

func TestReviewPromptIsReadOnly(t *testing.T) {
	p := reviewPrompt("", "")
	for _, must := range []string{"read-only", "git diff", "VERDICT", "DISTILLED"} {
		if !contains(p, must) {
			t.Errorf("review prompt missing %q", must)
		}
	}
	// claim discipline: every asserted fact must name its source, and anything
	// the reviewer could not check must be labelled rather than stated flatly
	for _, must := range []string{"CODE claim", "RUNTIME claim", "unverified"} {
		if !contains(p, must) {
			t.Errorf("review prompt missing claim-discipline marker %q", must)
		}
	}
	// the reviewer must read the pre-change code and hunt for existing helpers
	// before accepting that new code needed to be written at all
	for _, must := range []string{"git show", "already"} {
		if !contains(p, must) {
			t.Errorf("review prompt missing reuse/context marker %q", must)
		}
	}
	// resource cost of the change is a review class, not an afterthought
	if !contains(p, "Resource cost") {
		t.Errorf("review prompt missing resource-cost class")
	}
	// when a fork base is known, the reviewer is told to include committed work
	// (not just uncommitted) — otherwise it SHIPs on an empty git diff
	based := reviewPrompt("", "abc123")
	if !contains(based, "abc123...HEAD") {
		t.Errorf("based review prompt should diff against the fork base")
	}
	// a lens is injected into the prompt when provided (diverse panel)
	lensed := reviewPrompt(reviewLenses[0], "")
	if !contains(lensed, reviewLenses[0]) {
		t.Errorf("lensed review prompt should include the lens text")
	}
	if contains(p, reviewLenses[0]) {
		t.Errorf("un-lensed prompt must not carry a lens")
	}
}
