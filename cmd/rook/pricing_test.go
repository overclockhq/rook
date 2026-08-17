package main

import "testing"

func TestPricePerToken_Families(t *testing.T) {
	cases := []struct {
		model   string
		wantIn  float64
		wantOut float64
	}{
		{"claude-opus-4-8", 15e-6, 75e-6},
		{"claude-3-5-haiku-20241022", 0.8e-6, 4e-6}, // Haiku 3.5
		{"claude-haiku-4-5-20251001", 1e-6, 5e-6},   // Haiku 4.5 — pricier than 3.5
		{"claude-sonnet-4-6", 3e-6, 15e-6},
		{"some-unknown-model", 3e-6, 15e-6}, // defaults to sonnet-class
		{"", 3e-6, 15e-6},
	}
	for _, c := range cases {
		r := pricePerToken(c.model)
		if r.in != c.wantIn || r.out != c.wantOut {
			t.Errorf("pricePerToken(%q) = in %g/out %g, want in %g/out %g",
				c.model, r.in, r.out, c.wantIn, c.wantOut)
		}
	}
}

func TestPricePerToken_CaseInsensitive(t *testing.T) {
	if pricePerToken("Claude-OPUS-4").in != 15e-6 {
		t.Error("family match should be case-insensitive")
	}
}

func TestRateCost(t *testing.T) {
	r := pricePerToken("claude-sonnet-4-6")
	ev := usageEvent{input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000}
	got := r.cost(ev)
	want := 3.0 + 15.0 + 0.3 + 3.75 // per-million list prices sum
	if diff := got - want; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("cost = %g, want %g", got, want)
	}
}

func TestRateCost_Zero(t *testing.T) {
	if pricePerToken("claude-opus-4-8").cost(usageEvent{}) != 0 {
		t.Error("cost of an empty usage event should be 0")
	}
}
