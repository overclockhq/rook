package main

import "testing"

// rook learns about an agent from ~/.claude/sessions/<pid>.json, which Claude
// Code only writes once a conversation starts. A pane sitting on a first-run
// notice never gets that far, so the agent is invisible in the dashboard while
// its tmux name is still taken — which is how "already running" and "not in the
// list" end up true at the same time.
func TestOrphanSpawns(t *testing.T) {
	const now int64 = 1_700_000_000_000
	pane := tmuxSess{Name: "review-pr-334", Pane: "%7",
		Path: "/Users/x/.rook/worktrees/review-pr-334-1793355389", CreatedMs: now - 120_000}

	t.Run("a spawned pane with no session file shows up as starting", func(t *testing.T) {
		got := orphanSpawns([]tmuxSess{pane}, nil, map[string]bool{"review-pr-334": true}, now)
		if len(got) != 1 {
			t.Fatalf("want 1 placeholder, got %d", len(got))
		}
		s := got[0]
		if s.Status != "starting" {
			t.Errorf("status = %q, want starting", s.Status)
		}
		if s.TmuxPane != "%7" || !s.Controllable {
			t.Errorf("the pane is the whole point — it must stay reachable: %+v", s)
		}
		if !s.SpawnedByRook {
			t.Errorf("rook spawned it, so it must be marked as such")
		}
		if s.CWD != pane.Path {
			t.Errorf("cwd = %q, want the pane's path", s.CWD)
		}
		if s.StartedAt != pane.CreatedMs {
			t.Errorf("startedAt should be when the pane was created")
		}
	})

	t.Run("a pane the scan already covers is not duplicated", func(t *testing.T) {
		got := orphanSpawns([]tmuxSess{pane}, map[string]bool{"review-pr-334": true},
			map[string]bool{"review-pr-334": true}, now)
		if len(got) != 0 {
			t.Errorf("want no placeholder for a session already listed, got %+v", got)
		}
	})

	// Someone's own tmux session is not rook's business to show as an agent.
	t.Run("a pane rook did not spawn is ignored", func(t *testing.T) {
		got := orphanSpawns([]tmuxSess{{Name: "my-shell", Pane: "%1"}}, nil, nil, now)
		if len(got) != 0 {
			t.Errorf("want nothing for a hand-made session, got %+v", got)
		}
	})

	// The specific stall worth naming: the agent is alive and waiting on a
	// keypress, not broken. Saying so is the difference between a dead end and
	// a one-click fix.
	t.Run("a first-run notice is reported as waiting on a keypress", func(t *testing.T) {
		p := pane
		p.Screen = "Security notes:\n 1. Claude can make mistakes.\n Press Enter to continue…"
		got := orphanSpawns([]tmuxSess{p}, nil, map[string]bool{"review-pr-334": true}, now)
		if len(got) != 1 {
			t.Fatalf("want 1, got %d", len(got))
		}
		if got[0].Status != "waiting" {
			t.Errorf("status = %q, want waiting", got[0].Status)
		}
		if got[0].Asking == "" {
			t.Errorf("it must say what it is waiting for")
		}
	})

	t.Run("the title is the task name, not the raw pane id", func(t *testing.T) {
		got := orphanSpawns([]tmuxSess{pane}, nil, map[string]bool{"review-pr-334": true}, now)
		if got[0].Title != "review-pr-334" {
			t.Errorf("title = %q", got[0].Title)
		}
	})
}

// The conflict message is the only thing the user sees when a name is taken, so
// it has to say which state it found rather than a flat "already running".
func TestSpawnConflictMessage(t *testing.T) {
	cases := []struct {
		name  string
		state string
		want  string
	}{
		{"a live agent", "running", "already running"},
		{"a pane stalled before the agent started", "starting", "has not started"},
		{"an abandoned pane", "idle", "left over"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := spawnConflictMsg("review-pr-334", c.state)
			if !contains(got, c.want) || !contains(got, "review-pr-334") {
				t.Errorf("message %q should name the session and say %q", got, c.want)
			}
		})
	}
}
