package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

// execWithTimeout runs a command with a hard deadline, returning combined output.
func execWithTimeout(bin string, d time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return exec.CommandContext(ctx, bin, args...).CombinedOutput()
}

var (
	tmuxNameRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	paneTargetRe = regexp.MustCompile(`^[%A-Za-z0-9_:.@=-]{1,60}$`)
)

// agentCmd maps a provider to the shell command that launches it.
func agentCmd(agent string) string {
	switch agent {
	case "codex":
		return "codex"
	case "aider":
		return "aider"
	case "gemini":
		return "gemini"
	default:
		return "claude"
	}
}

// modelRe matches a full Claude model id (e.g. claude-haiku-4-5-20251001).
var modelRe = regexp.MustCompile(`^claude-[a-z0-9]+(-[a-z0-9.]+)*$`)

// validModel accepts the CLI's short aliases or a full claude-* id.
func validModel(m string) bool {
	switch m {
	case "haiku", "sonnet", "opus":
		return true
	}
	return modelRe.MatchString(m)
}

// buildLaunchCmd composes the shell command tmux runs for an agent, layering on
// --resume (restore a session) and --model (route to a cheaper/stronger model)
// when requested. Pure + validated so it can be unit-tested without tmux.
func buildLaunchCmd(agent, resume, model string, autonomous bool) (string, error) {
	cmd := agentCmd(agent)
	launch := cmd
	// Autonomous orchestration (graph/chain nodes) runs unattended in an isolated
	// worktree, so it must not freeze at every permission prompt. Bypass them for
	// claude. rook's destructive-command gate (when hooks are installed) still
	// fires PreToolUse, so catastrophic commands are still caught.
	if autonomous && (agent == "" || agent == "claude") {
		launch += " --dangerously-skip-permissions"
	}
	if resume != "" {
		if !validSessionID(resume) {
			return "", fmt.Errorf("invalid resume session id")
		}
		if agent != "" && agent != "claude" {
			return "", fmt.Errorf("resume is only supported for Claude sessions")
		}
		launch = cmd + " --resume " + resume
	}
	if model != "" && model != "default" {
		if agent != "" && agent != "claude" {
			return "", fmt.Errorf("model override is only supported for Claude")
		}
		if !validModel(model) {
			return "", fmt.Errorf("invalid model %q", model)
		}
		launch += " --model " + model
	}
	return launch, nil
}

type spawnReq struct {
	Name     string `json:"name"`
	CWD      string `json:"cwd"`
	Agent    string `json:"agent"`
	Prompt   string `json:"prompt"`
	Worktree bool   `json:"worktree"` // isolate in a git worktree (don't touch the user's checkout)
	Resume   string `json:"resume"`   // Claude session id to resume (restores full context; claude only)
	Model    string `json:"model"`    // override model (haiku|sonnet|opus|claude-* id); "" or "default" = account default
	Autonomous bool `json:"autonomous"` // run unattended (skip permission prompts) — for graph/chain nodes
}

// gitToplevel returns the repo root for a directory, or "" if not a git repo.
func gitToplevel(dir string) string {
	out, err := execWithTimeout("git", 8*time.Second, "-C", dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// createWorktree makes a detached-HEAD git worktree off the repo so an agent can
// check out a PR branch / create a branch without disturbing the user's working
// tree. Returns the new worktree path.
func createWorktree(repoRoot, name string, ts int64) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	base := filepath.Join(home, ".rook", "worktrees")
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", err
	}
	dir := filepath.Join(base, fmt.Sprintf("%s-%d", name, ts))
	// Put the worktree on a named branch (rook/<dir>) rather than a detached HEAD,
	// so it reads clearly in the worktree list and git tools. removeWorktree drops
	// the branch on cleanup. The agent can still `gh pr checkout` over it.
	branch := "rook/" + filepath.Base(dir)
	if out, err := execWithTimeout("git", 30*time.Second, "-C", repoRoot, "worktree", "add", "-b", branch, dir); err != nil {
		return "", fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return dir, nil
}

// handleSpawn launches an agent inside a fresh tmux session so Foreman can watch
// and drive it. This is the one write-ish action in orchestration; the UI
// confirms before calling it.
func handleSpawn(ctx *gofr.Context) (any, error) {
	var req spawnReq
	if err := ctx.Bind(&req); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	req.Name = strings.TrimSpace(req.Name)
	cmd, worktree, code, err := spawnAgentSession(req)
	if err != nil {
		return nil, errf(code, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "session": req.Name, "agent": cmd, "worktree": worktree})
}

// spawnAgentSession creates the tmux session, optional worktree, and schedules
// the initial prompt. Shared by the HTTP handler and the summary scheduler.
// Returns (agentCmd, worktreePath, httpStatusOnError, error).
func spawnAgentSession(req spawnReq) (string, string, int, error) {
	if tmuxBin == "" {
		return "", "", http.StatusServiceUnavailable, fmt.Errorf("tmux not installed — needed to spawn/control agents")
	}
	if !tmuxNameRe.MatchString(req.Name) {
		return "", "", http.StatusBadRequest, fmt.Errorf("name must be 1-40 chars [A-Za-z0-9_-]")
	}
	fi, err := os.Stat(req.CWD)
	if err != nil || !fi.IsDir() {
		return "", "", http.StatusBadRequest, fmt.Errorf("cwd is not a directory")
	}
	cmd := agentCmd(req.Agent)
	// Fail early with a clear message if the agent binary isn't installed —
	// otherwise tmux spawns a pane that dies instantly with "command not found".
	if _, err := exec.LookPath(cmd); err != nil {
		return "", "", http.StatusBadRequest, fmt.Errorf("%q is not installed / not on PATH — install it or pick another agent", cmd)
	}
	// launch layers --resume / --model onto the base agent command (see
	// buildLaunchCmd). Resume restores a session in place; the initial prompt is
	// skipped because the conversation is picked up where it left off.
	launch, lerr := buildLaunchCmd(req.Agent, req.Resume, req.Model, req.Autonomous)
	if lerr != nil {
		return "", "", http.StatusBadRequest, lerr
	}

	// Check the tmux name is free BEFORE creating a worktree — otherwise a name
	// collision fails the new-session after the worktree is already on disk,
	// orphaning it.
	if _, err := runTmux("has-session", "-t", req.Name); err == nil {
		return "", "", http.StatusConflict, fmt.Errorf("an agent named %q is already running", req.Name)
	}

	// Isolate in a git worktree so the agent can `gh pr checkout` / branch without
	// switching the user's current branch (GitHub review/work handoffs).
	runDir := req.CWD
	worktree := ""
	if req.Worktree {
		root := gitToplevel(req.CWD)
		if root == "" {
			return "", "", http.StatusBadRequest, fmt.Errorf("worktree requested but this is not a git repo")
		}
		wt, werr := createWorktree(root, req.Name, time.Now().Unix())
		if werr != nil {
			return "", "", http.StatusConflict, fmt.Errorf("worktree failed: %v", werr)
		}
		runDir = wt
		worktree = wt
	}

	if out, serr := runTmux("new-session", "-d", "-s", req.Name, "-x", "220", "-y", "50", "-c", runDir, launch); serr != nil {
		return "", "", http.StatusConflict, fmt.Errorf("spawn failed: %s", tmuxErr(serr, out))
	}
	recordSpawn(req.Name, time.Now().UnixMilli())
	if worktree != "" {
		rememberWorktree(req.Name, worktree)
	}

	// send the initial prompt once the agent's UI has settled (non-blocking);
	// collapse to one line so a multi-line prompt doesn't submit early.
	if p := strings.Join(strings.Fields(req.Prompt), " "); p != "" {
		go sendInitialPrompt(req.Name, p)
	}
	return cmd, worktree, 0, nil
}

// sendInitialPrompt types the initial prompt into a freshly-launched agent TUI
// and submits it — robustly. Waiting for "output stopped changing" isn't enough:
// the long Claude Code v2 splash + MCP-auth banner can eat keystrokes typed too
// early, leaving the agent idle at an empty prompt. So we wait until the REPL is
// actually interactive, then type, VERIFY the text landed, and retry if it didn't.
//
// waitForPromptReady also clears the first-run "Do you trust the files in this
// folder?" dialog Claude Code shows the first time it opens a directory. Every
// worktree is a fresh directory, so without this the very first spawn per repo
// would have its prompt eaten by the trust menu (and the trailing Enter would
// just select "Yes, I trust") — which is why it silently worked from the 2nd try.
func sendInitialPrompt(target, prompt string) {
	waitForPromptReady(target, 45*time.Second)
	time.Sleep(500 * time.Millisecond)

	// type the prompt; confirm it appears in the input; retry if keystrokes dropped
	landed := false
	for attempt := 0; attempt < 4; attempt++ {
		if err := tmuxSendKeys(target, true, prompt); err != nil {
			return
		}
		time.Sleep(600 * time.Millisecond)
		if promptEntered(target, prompt) {
			landed = true
			break
		}
		_ = tmuxSendKeys(target, false, "C-u") // clear any partial input, then retry
		time.Sleep(400 * time.Millisecond)
	}
	if !landed {
		// last resort: type once more so we don't silently no-op
		_ = tmuxSendKeys(target, true, prompt)
		time.Sleep(400 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	_ = tmuxSendKeys(target, false, "Enter")
}

// promptReadyMarkers are strings that appear once the agent REPL is interactive
// (its input line / status bar is drawn), so keystrokes will register. "❯" is
// deliberately NOT here: it is also the selection cursor of the first-run trust
// dialog ("❯ 1. Yes, I trust this folder"), so treating it as "ready" made us
// type the prompt into the trust menu, where it was discarded.
var promptReadyMarkers = []string{"for shortcuts", "esc to interrupt", "manual mode", "accept edits", "bypass permissions on", "shift+tab to cycle"}

// trustDialogMarkers identify Claude Code's first-run directory-trust prompt.
var trustDialogMarkers = []string{"trust this folder", "trust the files", "Yes, I trust"}

// paneHasTrustDialog reports whether the captured pane is showing the trust prompt.
func paneHasTrustDialog(capture string) bool {
	for _, m := range trustDialogMarkers {
		if strings.Contains(capture, m) {
			return true
		}
	}
	return false
}

// bypassDialogMarkers identify the "Bypass Permissions mode" confirmation shown on
// the first autonomous (--dangerously-skip-permissions) launch.
var bypassDialogMarkers = []string{"Bypass Permissions mode", "accept all responsibility"}

// paneHasBypassWarning reports whether the pane is showing the bypass-mode warning.
func paneHasBypassWarning(capture string) bool {
	for _, m := range bypassDialogMarkers {
		if strings.Contains(capture, m) {
			return true
		}
	}
	return false
}

// paneReady reports whether a captured pane looks like an interactive REPL.
func paneReady(capture string) bool {
	for _, m := range promptReadyMarkers {
		if strings.Contains(capture, m) {
			return true
		}
	}
	return false
}

// paneHasPrompt reports whether a distinctive leading chunk of the prompt appears
// in the captured pane — i.e. the keystrokes landed in the input.
func paneHasPrompt(capture, prompt string) bool {
	needle := strings.TrimSpace(prompt)
	if len(needle) > 24 {
		needle = needle[:24]
	}
	return needle == "" || strings.Contains(capture, needle)
}

// waitForPromptReady polls the pane until the REPL looks interactive (or timeout).
// Along the way it dismisses the first-run trust dialog by confirming "Yes, I
// trust this folder" (its default selection), so the real prompt can land after.
func waitForPromptReady(target string, max time.Duration) {
	deadline := time.Now().Add(max)
	trustCleared, bypassCleared := false, false
	for time.Now().Before(deadline) {
		time.Sleep(600 * time.Millisecond)
		out, err := runTmux("capture-pane", "-p", "-t", target)
		if err != nil {
			continue
		}
		capture := string(out)
		if !bypassCleared && paneHasBypassWarning(capture) {
			// the default option is "No, exit" — accepting on Enter would kill the
			// session. Move down to "Yes, I accept" and confirm.
			_ = tmuxSendKeys(target, false, "Down")
			time.Sleep(150 * time.Millisecond)
			_ = tmuxSendKeys(target, false, "Enter")
			bypassCleared = true
			time.Sleep(900 * time.Millisecond)
			continue
		}
		if !trustCleared && paneHasTrustDialog(capture) {
			// "Yes, I trust this folder" is the default highlighted option;
			// Enter confirms it. Then keep polling for the actual REPL.
			_ = tmuxSendKeys(target, false, "Enter")
			trustCleared = true
			time.Sleep(800 * time.Millisecond)
			continue
		}
		if paneReady(capture) {
			return
		}
	}
}

// promptEntered captures the pane and checks whether the prompt landed in it.
func promptEntered(target, prompt string) bool {
	out, err := runTmux("capture-pane", "-p", "-t", target)
	if err != nil {
		return false
	}
	return paneHasPrompt(string(out), prompt)
}

// applyKeyAction sends a control action's keystrokes to a tmux target. Returns
// the HTTP status to use on error (0 on success).
func applyKeyAction(target, action, value string) (int, error) {
	switch action {
	case "allow":
		return 0, tmuxSendKeys(target, false, "Enter")
	case "deny":
		return 0, tmuxSendKeys(target, false, "Escape")
	case "interrupt":
		return 0, tmuxSendKeys(target, false, "C-c")
	case "key":
		if !isMenuKey(value) {
			return http.StatusBadRequest, fmt.Errorf("key must be 1-9")
		}
		return 0, tmuxSendKeys(target, false, value)
	case "text":
		if strings.TrimSpace(value) == "" {
			return http.StatusBadRequest, fmt.Errorf("empty text")
		}
		if err := tmuxSendKeys(target, true, value); err != nil {
			return http.StatusInternalServerError, err
		}
		return 0, tmuxSendKeys(target, false, "Enter")
	default:
		return http.StatusBadRequest, fmt.Errorf("unknown action")
	}
}

type sendReq struct {
	Target string `json:"target"`
	Action string `json:"action"`
	Value  string `json:"value"`
}

// handleSend drives a live terminal by sending keys straight to its tmux target.
// This is what makes the Terminal interactive for any session — including
// handed-off agents whose Claude session id isn't resolved yet.
func handleSend(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux not installed")
	}
	var req sendReq
	if err := ctx.Bind(&req); err != nil || !paneTargetRe.MatchString(req.Target) {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	if code, err := applyKeyAction(req.Target, req.Action, req.Value); err != nil {
		return nil, errf(code, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "target": req.Target, "action": req.Action})
}

type killReq struct {
	SessionID string `json:"sessionId"`
	Target    string `json:"target"`
}

// handleKill terminates a tmux-controlled agent by killing its pane. Accepts
// either a session id (resolved to its pane) or a direct tmux target.
func handleKill(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux not installed")
	}
	var req killReq
	if err := ctx.Bind(&req); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	var pane string
	if req.Target != "" && paneTargetRe.MatchString(req.Target) {
		pane = req.Target
	} else if validSessionID(req.SessionID) {
		for _, s := range ScanSessions(0) {
			if s.SessionID == req.SessionID {
				pane = s.TmuxPane
				break
			}
		}
	} else {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	if pane == "" {
		return nil, errf(http.StatusConflict, "session is not in a tmux pane")
	}
	if out, err := runTmux("kill-pane", "-t", pane); err != nil {
		return nil, errf(http.StatusInternalServerError, "kill failed: %s", tmuxErr(err, out))
	}
	// auto-remove the isolated worktree this agent ran in, if any
	if wt := worktreeForTarget(pane); wt != "" {
		forgetWorktree(pane)
		go func() {
			if err := removeWorktree(wt); err != nil {
				log.Printf("worktree cleanup failed for %s: %v", wt, err)
			}
		}()
	}
	return rawJSON(map[string]any{"ok": true, "pane": pane})
}

// handlePaneCapture returns the live text of a tmux pane (read-only peek).
func handlePaneCapture(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux not installed")
	}
	target := ctx.Param("target")
	if !paneTargetRe.MatchString(target) {
		return nil, errf(http.StatusBadRequest, "bad target")
	}
	lines := 200
	if n, err := strconv.Atoi(ctx.Param("lines")); err == nil && n > 0 && n <= 1000 {
		lines = n
	}
	// -e preserves ANSI colour/attribute escape sequences so the UI can render
	// the agent's output in colour (like a real terminal).
	out, err := runTmux("capture-pane", "-p", "-e", "-t", target, "-S", "-"+strconv.Itoa(lines))
	if err != nil {
		return nil, errf(http.StatusNotFound, "no such pane")
	}
	return textResp(out, "text/plain; charset=utf-8")
}

// runTmux runs a tmux subcommand and returns combined output.
func runTmux(args ...string) ([]byte, error) {
	return execWithTimeout(tmuxBin, 10*time.Second, args...)
}

func tmuxErr(err error, out []byte) string {
	if len(out) > 0 {
		return strings.TrimSpace(string(out))
	}
	return err.Error()
}
