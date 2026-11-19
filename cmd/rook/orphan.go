package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// An agent only becomes visible to rook once Claude Code writes
// ~/.claude/sessions/<pid>.json, which happens when a conversation starts. A
// pane that stalls before then — on a first-run notice, or a trust prompt — is
// invisible in the dashboard while still holding its tmux name, so launching
// the same task again reports a conflict against something nothing can see.
// These placeholders close that gap.

// tmuxSess is one live tmux session, with enough context to stand in for an
// agent that has not reported itself yet.
type tmuxSess struct {
	Name      string
	Pane      string // stable pane id, e.g. "%7"
	Path      string // the pane's working directory
	CreatedMs int64
	Screen    string // visible pane contents, when read
}

// firstRunPrompts are the stalls worth naming: the agent is alive and waiting
// on a keypress, which is a very different problem from a crash.
var firstRunPrompts = []struct{ marker, asking string }{
	{"Press Enter to continue", "Claude Code is showing its first-run security notice — press Enter to start"},
	{"Do you trust the files", "Claude Code is asking whether to trust this folder"},
}

// orphanSpawns returns a placeholder session for every live tmux session rook
// spawned that no scanned session accounts for.
func orphanSpawns(live []tmuxSess, covered, spawned map[string]bool, now int64) []Session {
	var out []Session
	for _, t := range live {
		if t.Name == "" || covered[t.Name] || !spawned[t.Name] {
			continue
		}
		s := Session{
			Provider:      "claude",
			SessionID:     "tmux:" + t.Name,
			Title:         t.Name,
			CWD:           t.Path,
			Project:       projectName(t.Path),
			Status:        "starting",
			Alive:         true,
			Controllable:  t.Pane != "",
			TmuxPane:      t.Pane,
			SpawnedByRook: true,
			StartedAt:     t.CreatedMs,
			UpdatedAt:     t.CreatedMs,
		}
		for _, p := range firstRunPrompts {
			if strings.Contains(t.Screen, p.marker) {
				s.Status = "waiting"
				s.Asking = p.asking
				break
			}
		}
		out = append(out, s)
	}
	return out
}

// liveTmuxSessions lists tmux sessions, reading each one's visible pane only for
// the names given — capturing every pane on every scan would cost a subprocess
// per session for output almost always thrown away.
func liveTmuxSessions(capture map[string]bool) []tmuxSess {
	if tmuxBin == "" {
		return nil
	}
	out, err := exec.Command(tmuxBin, "list-panes", "-a", "-F",
		"#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{session_created}").Output()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var list []tmuxSess
	for _, ln := range strings.Split(string(out), "\n") {
		f := strings.Split(strings.TrimSpace(ln), "\t")
		if len(f) != 4 || seen[f[0]] {
			continue
		}
		seen[f[0]] = true
		created, _ := strconv.ParseInt(f[3], 10, 64)
		t := tmuxSess{Name: f[0], Pane: f[1], Path: f[2], CreatedMs: created * 1000}
		if capture[t.Name] {
			if b, err := exec.Command(tmuxBin, "capture-pane", "-p", "-t", t.Name).Output(); err == nil {
				t.Screen = string(b)
			}
		}
		list = append(list, t)
	}
	return list
}

// spawnConflictMsg explains a taken tmux name in terms of what was found there,
// so the next step is obvious instead of guessed at.
func spawnConflictMsg(name, state string) string {
	switch state {
	case "starting":
		return fmt.Sprintf("%q has a tmux session but its agent has not started — it is probably waiting on a keypress. Open its terminal, or stop it and launch again.", name)
	case "idle":
		return fmt.Sprintf("%q is a tmux session left over from an earlier run with no agent in it. Stop it, then launch again.", name)
	default:
		return fmt.Sprintf("an agent named %q is already running", name)
	}
}

// tmuxNameState reports what is actually in a tmux session holding a name:
// "running" when an agent reported itself from that pane, "starting" when the
// agent process is there but has not got that far, "idle" otherwise.
func tmuxNameState(name string) string {
	paneSessions := tmuxPaneSessions()
	pane := ""
	for p, n := range paneSessions {
		if n == name {
			pane = p
			break
		}
	}
	if pane == "" {
		return "idle"
	}
	for _, s := range ScanAllSessions(0) {
		if s.Alive && s.TmuxPane == pane && !strings.HasPrefix(s.SessionID, "tmux:") {
			return "running"
		}
	}
	if out, err := exec.Command(tmuxBin, "list-panes", "-t", name, "-F", "#{pane_current_command}").Output(); err == nil {
		if cmd := strings.TrimSpace(string(out)); cmd != "" && !isShell(cmd) {
			return "starting"
		}
	}
	return "idle"
}

// isShell reports whether a pane is sitting at a plain prompt — i.e. whatever
// was launched in it has exited.
func isShell(cmd string) bool {
	switch cmd {
	case "zsh", "bash", "sh", "fish", "-zsh", "-bash":
		return true
	}
	return false
}
