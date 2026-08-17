package main

import "testing"

func TestComputeUsage_GroupsModelsAndTotals(t *testing.T) {
	sessions := []Session{
		{SessionID: "a", Model: "claude-opus-4-8", Project: "p1", TokensTotal: 100, CostUSD: 1.50},
		{SessionID: "b", Model: "claude-opus-4-8", Project: "p2", TokensTotal: 300, CostUSD: 4.00},
		{SessionID: "c", Model: "claude-sonnet-4-6", Project: "p3", TokensTotal: 50, CostUSD: 0.25},
	}
	windows := []TokenWindow{{Label: "5 hours"}, {Label: "7 days"}}

	got := computeUsage(sessions, windows)

	// windows pass through untouched
	if len(got.Windows) != 2 {
		t.Fatalf("Windows = %d entries, want 2", len(got.Windows))
	}

	// two distinct models
	if len(got.Models) != 2 {
		t.Fatalf("Models = %d entries, want 2", len(got.Models))
	}

	// find and verify the opus aggregate (order is cost-desc, so not positional)
	var opus *modelCost
	for i := range got.Models {
		if got.Models[i].Model == "claude-opus-4-8" {
			opus = &got.Models[i]
		}
	}
	if opus == nil {
		t.Fatal("no opus model entry")
	}
	if opus.Sessions != 2 {
		t.Errorf("opus Sessions = %d, want 2", opus.Sessions)
	}
	if opus.TokensTotal != 400 {
		t.Errorf("opus TokensTotal = %d, want 400", opus.TokensTotal)
	}
	if diff := opus.CostUSD - 5.50; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("opus CostUSD = %g, want 5.50", opus.CostUSD)
	}

	// runs sorted by cost desc
	if len(got.Runs) != 3 {
		t.Fatalf("Runs = %d entries, want 3", len(got.Runs))
	}
	for i := 1; i < len(got.Runs); i++ {
		if got.Runs[i-1].CostUSD < got.Runs[i].CostUSD {
			t.Errorf("Runs not sorted by cost desc at %d: %g < %g",
				i, got.Runs[i-1].CostUSD, got.Runs[i].CostUSD)
		}
	}
	if got.Runs[0].SessionID != "b" {
		t.Errorf("top run = %q, want %q", got.Runs[0].SessionID, "b")
	}

	// grand totals equal the sum of all sessions
	if got.TokensTotal != 450 {
		t.Errorf("TokensTotal = %d, want 450", got.TokensTotal)
	}
	if diff := got.CostUSD - 5.75; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("CostUSD = %g, want 5.75", got.CostUSD)
	}
}
