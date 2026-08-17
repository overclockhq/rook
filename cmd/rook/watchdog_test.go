package main

import "testing"

func TestComputeHealth(t *testing.T) {
	const now = int64(1_000_000_000_000)
	rep := ToolCall{Name: "Bash", Summary: "go test ./..."}

	cases := []struct {
		name      string
		s         Session
		wantLevel string // "" means healthy (nil)
	}{
		{
			name:      "looping on repeated tool call",
			s:         Session{Alive: true, Status: "busy", UpdatedAt: now, ToolCalls: []ToolCall{rep, rep, rep}},
			wantLevel: "alert",
		},
		{
			name:      "waiting too long",
			s:         Session{Alive: true, Status: "waiting", UpdatedAt: now - waitingStuckMs - 1},
			wantLevel: "alert",
		},
		{
			name:      "busy but frozen",
			s:         Session{Alive: true, Status: "busy", UpdatedAt: now - idleBusyMs - 1},
			wantLevel: "warn",
		},
		{
			name:      "healthy busy session",
			s:         Session{Alive: true, Status: "busy", UpdatedAt: now - 1000, ToolCalls: []ToolCall{{Name: "Read", Summary: "a"}, {Name: "Edit", Summary: "b"}}},
			wantLevel: "",
		},
		{
			name:      "dead session is not the watchdog's concern",
			s:         Session{Alive: false, Status: "dead", UpdatedAt: now - waitingStuckMs*10},
			wantLevel: "",
		},
		{
			name:      "waiting but not yet long enough",
			s:         Session{Alive: true, Status: "waiting", UpdatedAt: now - 1000},
			wantLevel: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := computeHealth(&c.s, now)
			if c.wantLevel == "" {
				if h != nil {
					t.Fatalf("want healthy (nil), got %+v", h)
				}
				return
			}
			if h == nil {
				t.Fatalf("want level %q, got nil", c.wantLevel)
			}
			if h.Level != c.wantLevel {
				t.Fatalf("want level %q, got %q (reason %q)", c.wantLevel, h.Level, h.Reason)
			}
			if h.Reason == "" {
				t.Errorf("health reason should not be empty")
			}
		})
	}
}
