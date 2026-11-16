package main

import (
	"os"
	"testing"
)

// The verdict is the whole point of this view: Activity Monitor already shows
// numbers, and numbers did not tell anyone why the machine felt slow. These pin
// the diagnosis rules.
func TestAssessVerdict(t *testing.T) {
	healthy := sysSnapshot{Cores: 10, Load1: 2.0, MemTotal: 16 << 30, MemFree: 8 << 30,
		SwapTotal: 8 << 30, SwapUsed: 1 << 30}

	t.Run("a quiet machine reads ok", func(t *testing.T) {
		v := assess(healthy)
		if v.Level != "ok" {
			t.Errorf("level = %q, want ok (reasons: %+v)", v.Level, v.Reasons)
		}
		if len(v.Reasons) != 0 {
			t.Errorf("a healthy machine should need no explanation, got %+v", v.Reasons)
		}
	})

	// Swap exhaustion is the one that actually explains "slow" on macOS: the CPU
	// looks idle because everything is blocked on paging.
	t.Run("near-full swap is the top reason", func(t *testing.T) {
		s := healthy
		s.SwapUsed = int64(float64(s.SwapTotal) * 0.94)
		v := assess(s)
		if v.Level != "critical" {
			t.Errorf("level = %q, want critical", v.Level)
		}
		if len(v.Reasons) == 0 || v.Reasons[0].Kind != "swap" {
			t.Errorf("swap must be reported first, got %+v", v.Reasons)
		}
	})

	t.Run("load is judged per core, not absolute", func(t *testing.T) {
		// 8.0 across 10 cores is busy but fine; across 2 cores it is not
		if assess(sysSnapshot{Cores: 10, Load1: 8, MemTotal: 16 << 30, MemFree: 8 << 30,
			SwapTotal: 8 << 30}).Level != "ok" {
			t.Errorf("8.0 over 10 cores should be ok")
		}
		v := assess(sysSnapshot{Cores: 2, Load1: 8, MemTotal: 16 << 30, MemFree: 8 << 30,
			SwapTotal: 8 << 30})
		if v.Level == "ok" {
			t.Errorf("8.0 over 2 cores should not be ok")
		}
	})

	t.Run("low free memory is called out", func(t *testing.T) {
		s := healthy
		s.MemFree = int64(float64(s.MemTotal) * 0.03)
		v := assess(s)
		if !hasReason(v, "memory") {
			t.Errorf("expected a memory reason, got %+v", v.Reasons)
		}
	})

	// A process whose parent died and which has burned CPU for hours is the
	// shape of the stuck encode that started this — worth naming, not just listing.
	t.Run("an orphaned long-running CPU hog is flagged as runaway", func(t *testing.T) {
		s := healthy
		s.Procs = []sysProc{{PID: 999, PPID: 1, CPU: 120, ElapsedSec: 6 * 3600, Name: "ffmpeg"}}
		v := assess(s)
		if !hasReason(v, "runaway") {
			t.Errorf("expected a runaway reason, got %+v", v.Reasons)
		}
	})

	t.Run("a busy process with a live parent is not a runaway", func(t *testing.T) {
		s := healthy
		s.Procs = []sysProc{{PID: 999, PPID: 400, CPU: 120, ElapsedSec: 6 * 3600, Name: "ffmpeg"}}
		if hasReason(assess(s), "runaway") {
			t.Errorf("a supervised process should not be called a runaway")
		}
	})

	t.Run("a brief CPU spike is not a runaway", func(t *testing.T) {
		s := healthy
		s.Procs = []sysProc{{PID: 999, PPID: 1, CPU: 120, ElapsedSec: 30, Name: "ffmpeg"}}
		if hasReason(assess(s), "runaway") {
			t.Errorf("30 seconds of CPU is not a runaway")
		}
	})

	// rook's own angle: it knows which processes are agents, so it can say that
	// a pile of forgotten sessions is holding memory.
	t.Run("many idle agent sessions are reported", func(t *testing.T) {
		s := healthy
		s.AgentCount = 23
		s.AgentRSS = 2 << 30
		if !hasReason(assess(s), "agents") {
			t.Errorf("expected an agents reason, got %+v", assess(s).Reasons)
		}
	})

	t.Run("a couple of agent sessions are normal", func(t *testing.T) {
		s := healthy
		s.AgentCount = 3
		s.AgentRSS = 300 << 20
		if hasReason(assess(s), "agents") {
			t.Errorf("three sessions should not be flagged")
		}
	})

	// Reasons must be ordered by how much they explain, so the first line a
	// person reads is the thing to fix.
	t.Run("reasons are ordered worst first", func(t *testing.T) {
		s := healthy
		s.SwapUsed = int64(float64(s.SwapTotal) * 0.95)
		s.AgentCount = 30
		s.AgentRSS = 3 << 30
		v := assess(s)
		if len(v.Reasons) < 2 || v.Reasons[0].Kind != "swap" {
			t.Errorf("swap should outrank agents, got %+v", v.Reasons)
		}
	})
}

func hasReason(v sysVerdict, kind string) bool {
	for _, r := range v.Reasons {
		if r.Kind == kind {
			return true
		}
	}
	return false
}

// Stopping a process is irreversible, so the guard matters more than the action.
func TestKillGuard(t *testing.T) {
	cases := []struct {
		name  string
		pid   int
		proc  string
		allow bool
	}{
		{"a normal user process", 65140, "ffmpeg", true},
		{"a coding agent", 4200, "claude", true},
		{"launchd itself", 1, "launchd", false},
		{"the kernel", 0, "kernel_task", false},
		{"a negative pid is a process group, never allowed", -1, "", false},
		{"the window server", 169, "WindowServer", false},
		{"the login window", 300, "loginwindow", false},
		{"rook itself — it would take this view down with it", os.Getpid(), "rook", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := killAllowed(c.pid, c.proc); got != c.allow {
				t.Errorf("killAllowed(%d, %q) = %v, want %v", c.pid, c.proc, got, c.allow)
			}
		})
	}
}
