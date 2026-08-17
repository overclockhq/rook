package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

// The verification layer is rook's answer to the 2026 consensus that the
// bottleneck has shifted from generating code to verifying it. Two independent
// checks a worktree gets before a human looks:
//   1. an auto-review subagent (reads the diff, reports issues) — 2.1
//   2. a test/lint/build gate that actually runs the project's checks — 2.2
// Both can fire automatically on the Stop hook, or on demand from the diff UI.

// reviewLenses give each pass of a multi-pass review a distinct focus — a
// diverse panel catches more than the same reviewer run twice (the research's
// judge-panel/diversity pattern). Used only when reviewPasses > 1.
var reviewLenses = []string{
	"Focus especially on correctness/bugs and security.",
	"Focus especially on missing tests, edge cases, and needless complexity (call out simpler equivalents).",
	"Focus especially on API/contract changes, backward compatibility, and error handling.",
}

// reviewPrompt is the read-only reviewer prompt pointed at a worktree's changes.
// The output is deliberately DISTILLED (the isolate boundary — 7.6): the reviewer
// returns a short, actionable verdict rather than dumping its whole trajectory.
func reviewPrompt(lens, base string) string {
	// Include COMMITTED work, not just uncommitted. If the agent committed its
	// changes, `git diff` alone is empty and the reviewer would SHIP on nothing —
	// so review against the fork base when we know it.
	how := "run `git diff` and `git diff --staged` and `git status`"
	if base != "" && base != "HEAD" {
		how = "run `git diff " + base + "...HEAD` (committed changes since the fork point) AND `git diff` and `git diff --staged` (uncommitted) and `git status`"
	}
	lines := []string{
		"You are a strict, read-only code reviewer. Review ALL changes in this working tree — " + how + ". If the diff is empty, say so explicitly rather than approving.",
		"Report concrete issues only, grouped as: Correctness/bugs, Security, Missing tests, Style. Cite file:line for each. If a change looks wrong, say why and suggest the fix.",
	}
	if lens != "" {
		lines = append(lines, lens)
	}
	lines = append(lines,
		"Keep the whole review DISTILLED: at most ~25 lines / ~1500 tokens — a summary a human can act on, not a transcript. Skip trivia.",
		"Do NOT modify any files, do NOT commit, do NOT run destructive commands. Lead with a one-line VERDICT: SHIP / FIX-FIRST / BLOCK and a one-sentence reason.",
	)
	return strings.Join(lines, "\n")
}

type reviewReq struct {
	Path string `json:"path"`
}

// handleReview spawns an independent review subagent in the given worktree.
func handleReview(ctx *gofr.Context) (any, error) {
	var req reviewReq
	if err := ctx.Bind(&req); err != nil || req.Path == "" {
		return nil, errf(http.StatusBadRequest, "path required")
	}
	name, code, err := spawnReview(req.Path)
	if err != nil {
		return nil, errf(code, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "session": name})
}

// spawnReview launches a read-only reviewer in a worktree (in place — it does
// not create a new worktree, it reviews the changes already there).
func spawnReview(path string) (string, int, error) {
	fi, err := os.Stat(path)
	if err != nil || !fi.IsDir() {
		return "", http.StatusBadRequest, fmt.Errorf("path is not a directory")
	}
	if !isWorkTree(path) {
		return "", http.StatusBadRequest, fmt.Errorf("not a git work tree")
	}
	// reviewPasses > 1 runs a diverse panel (each pass a different lens) for
	// higher-accuracy review at extra cost — opt-in, capped at the lens count.
	passes := loadConfig().ReviewPasses
	if passes < 1 {
		passes = 1
	}
	if passes > len(reviewLenses) {
		passes = len(reviewLenses)
	}
	nameBase := "review-" + safeName(filepath.Base(path)) + "-" + reviewStamp(path)
	forkBase := diffBase(path) // review committed work vs the fork point, not just uncommitted
	var first string
	var firstErr error
	for i := 0; i < passes; i++ {
		name := nameBase
		lens := ""
		if passes > 1 {
			name = nameBase + "-p" + strconv.Itoa(i+1)
			lens = reviewLenses[i]
		}
		_, _, _, err := spawnAgentSession(spawnReq{Name: name, CWD: path, Agent: "claude", Prompt: reviewPrompt(lens, forkBase)})
		if i == 0 {
			first, firstErr = name, err
		}
	}
	if firstErr != nil {
		return "", http.StatusConflict, firstErr
	}
	return first, 0, nil
}

// safeName sanitizes a directory basename into a tmux-safe session token.
func safeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 24 {
		out = out[:24]
	}
	if out == "" {
		out = "wt"
	}
	return out
}

// reviewStamp derives a short deterministic suffix from the worktree's HEAD so
// re-reviewing the same state reuses the session name (git avoids Date.now()).
func reviewStamp(path string) string {
	if h, err := gitOut(path, "rev-parse", "--short", "HEAD"); err == nil && h != "" {
		return h
	}
	return "wt"
}

// ---- 2.2 test/lint/build gate ----

// verifyResult is the outcome of running a project's verification command.
type verifyResult struct {
	OK     bool   `json:"ok"`
	Cmd    string `json:"cmd"`
	Output string `json:"output"` // tail of combined output
	Ran    bool   `json:"ran"`    // false when no command could be detected
}

// detectVerifyCmd picks a sensible build+test command for a project by its
// manifest. Returns "" when it can't tell.
func detectVerifyCmd(dir string) string {
	exists := func(f string) bool { _, err := os.Stat(filepath.Join(dir, f)); return err == nil }
	switch {
	case exists("go.mod"):
		return "go build ./... && go test ./..."
	case exists("package.json"):
		return "npm test --silent"
	case exists("Cargo.toml"):
		return "cargo test"
	case exists("pyproject.toml"), exists("pytest.ini"), exists("setup.py"):
		return "pytest -q"
	case exists("Makefile"):
		return "make test"
	}
	return ""
}

type verifyReq struct {
	Path string `json:"path"`
	Cmd  string `json:"cmd"`
}

func handleVerify(ctx *gofr.Context) (any, error) {
	var req verifyReq
	if err := ctx.Bind(&req); err != nil || req.Path == "" {
		return nil, errf(http.StatusBadRequest, "path required")
	}
	if fi, err := os.Stat(req.Path); err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "path is not a directory")
	}
	res := runVerify(req.Path, req.Cmd)
	return rawJSON(res)
}

// runVerify runs the (detected or supplied) verification command in dir with a
// hard timeout and returns the tail of its output.
func runVerify(dir, cmd string) verifyResult {
	if cmd == "" {
		cmd = detectVerifyCmd(dir)
	}
	if cmd == "" {
		return verifyResult{Ran: false, Cmd: "", Output: "no build/test command detected for this project"}
	}
	c := exec.Command("sh", "-c", cmd)
	c.Dir = dir
	done := make(chan struct{})
	var out []byte
	go func() { out, _ = c.CombinedOutput(); close(done) }()
	select {
	case <-done:
	case <-time.After(4 * time.Minute):
		_ = c.Process.Kill()
		res := verifyResult{Ran: true, Cmd: cmd, OK: false, Output: "verification timed out after 4m"}
		recordVerify(dir, res)
		return res
	}
	ok := c.ProcessState != nil && c.ProcessState.Success()
	res := verifyResult{Ran: true, Cmd: cmd, OK: ok, Output: tail(string(out), 4000)}
	recordVerify(dir, res) // remember pass/fail per worktree for the quality score
	return res
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

// onSessionFinished is called from the Stop hook. It fires the configured
// automatic checks for a finished session's worktree (best-effort, async).
func onSessionFinished(cwd string) {
	if cwd == "" || !isWorkTree(cwd) {
		return
	}
	// only bother if there's actually something to review
	if st, _ := gitOut(cwd, "status", "--porcelain"); strings.TrimSpace(st) == "" {
		if base := diffBase(cwd); base == "HEAD" {
			return // nothing uncommitted and no fork diff — nothing to check
		}
	}
	advanceChainsForCWD(cwd) // hand off to the next chain step, if any
	// task graphs advance via startGraphPoller (session-based), so they work
	// without the hooks bridge and never cross-complete graphs sharing a dir.

	c := loadConfig()
	if c.AutoReview {
		go func() { _, _, _ = spawnReview(cwd) }()
	}
	if c.AutoVerify {
		go func() {
			res := runVerify(cwd, "")
			if !res.Ran {
				return
			}
			title := "Tests passed · " + projectName(cwd)
			if !res.OK {
				title = "Tests FAILED · " + projectName(cwd)
			}
			banner("rook verify", title, firstLine(res.Output), "")
			verifyPrio := ""
			if !res.OK {
				verifyPrio = "high" // a failing build/test is worth surfacing
			}
			pushNtfy(title, firstLine(res.Output), verifyPrio)
			pushChat("rook verify · "+title, firstLine(res.Output))
			recordNotif(Notification{Kind: "verify", Title: title, Body: firstLine(res.Output), Project: projectName(cwd), Channels: notifChannels(true, true)})
			recordHook(hookRecord{Time: time.Now().UnixMilli(), Event: "Verify", Project: projectName(cwd),
				Detail: title, Gated: gateFlag(res.OK)})

			// Reflexion loop: on failure, write a verbal self-critique and, while
			// under the retry cap, re-inject the accumulated critiques into a fresh
			// agent turn so the next attempt learns from what failed.
			if !res.OK {
				cap := loadConfig().MaxReflectIterations
				if cap <= 0 {
					cap = 3
				}
				attempts := reflectionAttempts(cwd)
				if attempts < cap {
					label := fmt.Sprintf("%d", attempts+1)
					_ = writeReflection(cwd, label, res.Output)
					prompt := reflectionContext(cwd) +
						"\nFix the failing build/tests, then re-run the project's checks and stop when they pass."
					// Include the attempt label in the session name. Without it the
					// name is reflect-<base>-<shortHEAD>; a retry that doesn't commit
					// leaves HEAD unchanged → a duplicate tmux name → the spawn fails
					// and the self-healing loop dies silently after attempt 1.
					name := "reflect-" + safeName(filepath.Base(cwd)) + "-" + reviewStamp(cwd) + "-" + label
					if _, _, _, err := spawnAgentSession(spawnReq{
						Name:   name,
						CWD:    cwd,
						Agent:  "claude",
						Prompt: prompt,
					}); err != nil {
						log.Printf("reflexion retry %s failed to spawn: %v", label, err)
					}
				}
			}
		}()
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func gateFlag(ok bool) string {
	if ok {
		return ""
	}
	return "fail"
}
