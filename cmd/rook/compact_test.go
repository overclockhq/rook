package main

import "testing"

func TestWindowForModelAndPct(t *testing.T) {
	// opus-4-8 has a session over 200k → the whole model is a 1M window here.
	sessions := []Session{
		{Model: "opus", ContextTokens: 820000},
		{Model: "opus", ContextTokens: 179000},
		{Model: "sonnet", ContextTokens: 150000},
	}
	if w := windowForModel("opus", sessions); w != 1000000 {
		t.Fatalf("opus window = %d, want 1000000", w)
	}
	// sonnet never exceeded 200k → standard 200k window.
	if w := windowForModel("sonnet", sessions); w != 200000 {
		t.Fatalf("sonnet window = %d, want 200000", w)
	}
	// the 179k opus session reads ~18% on a 1M window, NOT ~90% on 200k.
	if p := contextPct(sessions[1], sessions); p != 17 && p != 18 {
		t.Fatalf("179k opus pct = %d, want ~18", p)
	}
	// the 150k sonnet session reads 75% on its 200k window.
	if p := contextPct(sessions[2], sessions); p != 75 {
		t.Fatalf("150k sonnet pct = %d, want 75", p)
	}
	// zero context → 0%, no divide surprises
	if p := contextPct(Session{Model: "opus"}, sessions); p != 0 {
		t.Fatalf("zero-context pct = %d, want 0", p)
	}
}
