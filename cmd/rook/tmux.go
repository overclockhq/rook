package main

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

var errNoTmux = errors.New("tmux not installed")

// tmuxBin is resolved once; empty if tmux isn't installed.
var tmuxBin = func() string {
	p, err := exec.LookPath("tmux")
	if err != nil {
		return ""
	}
	return p
}()

// tmuxPanePIDs returns a map of pane shell PID -> stable pane target (e.g. "%3").
func tmuxPanePIDs() map[int]string {
	if tmuxBin == "" {
		return nil
	}
	out, err := exec.Command(tmuxBin, "list-panes", "-a", "-F", "#{pane_pid}\t#{pane_id}").Output()
	if err != nil {
		return nil
	}
	m := map[int]string{}
	for _, ln := range strings.Split(string(out), "\n") {
		f := strings.SplitN(strings.TrimSpace(ln), "\t", 2)
		if len(f) != 2 {
			continue
		}
		if pid, err := strconv.Atoi(f[0]); err == nil {
			m[pid] = f[1]
		}
	}
	return m
}

// tmuxPaneSessions maps a stable pane id ("%3") to its tmux session name, so a
// discovered agent can be traced back to the session name rook spawned it under.
func tmuxPaneSessions() map[string]string {
	if tmuxBin == "" {
		return nil
	}
	out, err := exec.Command(tmuxBin, "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}").Output()
	if err != nil {
		return nil
	}
	m := map[string]string{}
	for _, ln := range strings.Split(string(out), "\n") {
		f := strings.SplitN(strings.TrimSpace(ln), "\t", 2)
		if len(f) == 2 {
			m[f[0]] = f[1]
		}
	}
	return m
}

// parentPID returns a process's parent pid (0 if unknown).
func parentPID(pid int) int {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	p, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0
	}
	return p
}

// findPaneForPID walks the parent chain of a session PID looking for a tmux
// pane shell. Returns the pane target ("%3") or "" if the session isn't in tmux.
func findPaneForPID(sessionPID int, panes map[int]string) string {
	if len(panes) == 0 {
		return ""
	}
	pid := sessionPID
	for i := 0; i < 12 && pid > 1; i++ {
		if target, ok := panes[pid]; ok {
			return target
		}
		pid = parentPID(pid)
	}
	return ""
}

// tmuxSendKeys sends keystrokes to a pane. literal=true types text verbatim
// (via -l), otherwise keys are tmux key names (Enter, Escape, …).
func tmuxSendKeys(target string, literal bool, keys ...string) error {
	if tmuxBin == "" {
		return errNoTmux
	}
	args := []string{"send-keys", "-t", target}
	if literal {
		args = append(args, "-l")
	}
	args = append(args, keys...)
	return exec.Command(tmuxBin, args...).Run()
}
