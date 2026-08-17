package main

import "testing"

func qtc(name string) ToolCall { return ToolCall{Name: name, Summary: name} }

func factorByName(fs []qualityFactor, name string) *qualityFactor {
	for i := range fs {
		if fs[i].Name == name {
			return &fs[i]
		}
	}
	return nil
}

func TestComputeQuality(t *testing.T) {
	// clean run, tests passing → perfect, outcome factor OK
	sc, label, factors := computeQuality(Session{ToolResults: 20}, "pass")
	if sc != 100 || label != "excellent" {
		t.Fatalf("clean+pass = %d/%s, want 100/excellent", sc, label)
	}
	if f := factorByName(factors, "Build & tests"); f == nil || !f.OK || f.Detail != "build/tests passing" {
		t.Fatalf("expected passing build factor, got %+v", f)
	}

	// failing build is the dominant hit — drops out of "excellent" even if clean otherwise
	sc, label, factors = computeQuality(Session{ToolResults: 20}, "fail")
	if sc != 55 || label != "fair" {
		t.Fatalf("fail = %d/%s, want 55/fair", sc, label)
	}
	if f := factorByName(factors, "Build & tests"); f == nil || f.OK || f.Penalty != 45 {
		t.Fatalf("expected -45 failing build factor, got %+v", f)
	}

	// tool-call error rate penalizes proportionally
	sc, _, factors = computeQuality(Session{ToolResults: 20, ToolErrors: 10}, "")
	tr := factorByName(factors, "Tool reliability")
	if tr == nil || tr.OK || tr.Penalty == 0 {
		t.Fatalf("expected tool-error penalty, got %+v", tr)
	}
	if sc != 100-tr.Penalty {
		t.Fatalf("score %d should be 100-%d", sc, tr.Penalty)
	}

	// "no gate run" is neutral (not penalized) but flagged in the breakdown
	sc, _, factors = computeQuality(Session{ToolResults: 5}, "")
	if sc != 100 {
		t.Fatalf("no-gate clean run = %d, want 100 (neutral)", sc)
	}
	if f := factorByName(factors, "Build & tests"); f == nil || !f.OK || f.Detail == "build/tests passing" {
		t.Fatalf("no-gate build factor should be neutral+flagged, got %+v", f)
	}

	// stability comes from the watchdog Health (single source), not a separate
	// leadingRepeat recompute — an alert is a minor (<=15) hit.
	looping := Session{ToolResults: 10, Health: &Health{Level: "alert", Reason: "looping — repeated Bash ×5"}}
	_, _, factors = computeQuality(looping, "pass")
	lf := factorByName(factors, "Stability")
	if lf == nil || lf.OK || lf.Penalty > 15 {
		t.Fatalf("looping should be a minor (<=15) stability penalty, got %+v", lf)
	}
	// waiting-on-human is NOT a quality problem, so it doesn't dock stability
	waiting := Session{ToolResults: 10, Health: &Health{Level: "alert", Reason: "waiting", Action: "answer"}}
	_, _, factors = computeQuality(waiting, "pass")
	if wf := factorByName(factors, "Stability"); wf == nil || !wf.OK {
		t.Fatalf("waiting-on-human should not dock stability, got %+v", wf)
	}

	// failing build + high tool errors + looping → at risk
	sc, label, _ = computeQuality(Session{ToolResults: 10, ToolErrors: 8, Health: &Health{Level: "alert", Reason: "looping"}}, "fail")
	if sc >= 50 || label != "at risk" {
		t.Fatalf("compounded bad run = %d/%s, want low/at risk", sc, label)
	}

	// nothing to judge — no gate ran AND zero tool activity → unrated, not a
	// flattering 100. This is the "did nothing = excellent" lie.
	sc, label, factors = computeQuality(Session{}, "")
	if sc != -1 || label != "unrated" {
		t.Fatalf("zero-signal run = %d/%s, want -1/unrated", sc, label)
	}
	if len(factors) != 1 || factors[0].Name != "Not yet rated" {
		t.Fatalf("unrated should carry a single explanatory factor, got %+v", factors)
	}
	// but an outcome signal alone (even with zero tool calls) IS rateable
	if sc, label, _ = computeQuality(Session{}, "pass"); sc != 100 || label != "excellent" {
		t.Fatalf("verified run with no tools = %d/%s, want 100/excellent", sc, label)
	}
}

func TestCountToolResults(t *testing.T) {
	// two results, one errored
	content := []byte(`[{"type":"tool_result","is_error":false,"content":"ok"},{"type":"tool_result","is_error":true,"content":"boom"}]`)
	total, errs := countToolResults(content)
	if total != 2 || errs != 1 {
		t.Fatalf("countToolResults = %d/%d, want 2/1", total, errs)
	}
	// tool_use blocks (assistant) are not results
	assistant := []byte(`[{"type":"text"},{"type":"tool_use","name":"Bash"}]`)
	if tt, _ := countToolResults(assistant); tt != 0 {
		t.Fatalf("tool_use should not count as results, got %d", tt)
	}
}
