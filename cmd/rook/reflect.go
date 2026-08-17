package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"gofr.dev/pkg/gofr"
)

// Reflexion closes rook's one-shot verify/review gate into a loop. The classic
// gate runs once and reports pass/fail; Reflexion (Shinn et al., 2023) instead
// turns each failure into a written verbal self-critique that is fed back to the
// next attempt, so the agent reasons about WHY it failed before retrying.
//
// The reflections are kept file-based in an episodic buffer under the worktree
// (<worktree>/.rook-reflect/reflections.md) — append-only, deterministic (no
// wall-clock timestamps in the content, only a caller-supplied attempt label),
// and injected verbatim into the next agent turn. Callers cap iterations by
// reading reflectionAttempts().

// reflectDirName is the per-worktree episodic-buffer directory.
const reflectDirName = ".rook-reflect"

// reflectFileName is the append-only self-critique buffer inside reflectDirName.
const reflectFileName = "reflections.md"

// reflectEntryMarker prefixes each reflection heading so entries can be counted
// deterministically regardless of the failure body's contents.
const reflectEntryMarker = "## Reflection — attempt "

// reflectionDir returns the per-run reflection directory for a worktree,
// creating it on demand.
func reflectionDir(worktree string) string {
	dir := filepath.Join(worktree, reflectDirName)
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// reflectionFile is the path to the append-only reflections buffer.
func reflectionFile(worktree string) string {
	return filepath.Join(reflectionDir(worktree), reflectFileName)
}

// writeReflection appends one verbal self-critique entry to the episodic buffer.
// The entry is labelled by the caller-supplied attemptLabel (NOT time.Now, to
// keep the buffer deterministic for tests and stable across re-runs). The body
// carries the tail-clipped failure output plus a prompt-style line instructing
// the next attempt to reflect on the cause and change its approach.
func writeReflection(worktree, attemptLabel, failureOutput string) error {
	if strings.TrimSpace(worktree) == "" {
		return fmt.Errorf("worktree required")
	}
	entry := fmt.Sprintf(`%s%s

Failure output (tail):

`+"```"+`
%s
`+"```"+`

Reflect: state, in one or two sentences, WHY this attempt failed and exactly what to change next. Then apply the fix and re-run the checks.

`, reflectEntryMarker, attemptLabel, tail(failureOutput, 4000))

	f, err := os.OpenFile(reflectionFile(worktree), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(entry)
	return err
}

// reflectionContext reads the accumulated buffer and formats it as a context
// block to inject into the next agent turn. Returns "" when there are no prior
// reflections, so callers can cheaply skip injection on the first attempt.
func reflectionContext(worktree string) string {
	b, err := os.ReadFile(reflectionFile(worktree))
	if err != nil || len(strings.TrimSpace(string(b))) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("Prior attempts in this worktree failed as follows. ")
	sb.WriteString("Reflect on these self-critiques, identify the root cause, and fix it before re-running the checks — do not repeat the same approach:\n\n")
	sb.WriteString(strings.TrimSpace(string(b)))
	sb.WriteString("\n")
	return sb.String()
}

// reflectionAttempts counts the entries in the buffer so callers can enforce a
// max-iterations cap.
func reflectionAttempts(worktree string) int {
	b, err := os.ReadFile(reflectionFile(worktree))
	if err != nil {
		return 0
	}
	return strings.Count(string(b), reflectEntryMarker)
}

// reflectionAttemptsRO counts reflections WITHOUT creating the buffer directory,
// so it's safe to call for every session on each scan (reflectionFile would
// MkdirAll and litter `.rook-reflect` into repos that never reflected).
func reflectionAttemptsRO(worktree string) int {
	if strings.TrimSpace(worktree) == "" {
		return 0
	}
	b, err := os.ReadFile(filepath.Join(worktree, reflectDirName, reflectFileName))
	if err != nil {
		return 0
	}
	return strings.Count(string(b), reflectEntryMarker)
}

type reflectReq struct {
	Path   string `json:"path"`
	Output string `json:"output"`
}

// handleReflect records a verbal self-critique for a worktree's latest failure
// and returns the running attempt count so the UI/orchestrator can enforce the
// max-iterations cap. The attempt label is derived from the current count so the
// buffer stays deterministic (no wall-clock in the entry).
func handleReflect(ctx *gofr.Context) (any, error) {
	var req reflectReq
	if err := ctx.Bind(&req); err != nil || req.Path == "" {
		return nil, errf(http.StatusBadRequest, "path required")
	}
	if fi, err := os.Stat(req.Path); err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "path is not a directory")
	}
	label := fmt.Sprintf("%d", reflectionAttempts(req.Path)+1)
	if err := writeReflection(req.Path, label, req.Output); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "attempts": reflectionAttempts(req.Path)})
}
