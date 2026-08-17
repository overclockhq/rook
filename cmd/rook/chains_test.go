package main

import (
	"sync"
	"testing"
)

// TestChainStateMachine drives the chain with a fake launcher (no real agents)
// and asserts each finish auto-unblocks exactly the next step, in order.
func TestChainStateMachine(t *testing.T) {
	// isolate global state
	chainMu.Lock()
	chains = map[string]*chain{}
	chainMu.Unlock()

	var mu sync.Mutex
	launched := []string{}
	orig := stepLauncher
	stepLauncher = func(c *chain, s *chainStep) error {
		mu.Lock()
		launched = append(launched, s.Name)
		mu.Unlock()
		c.runCWD = c.CWD // pretend it ran in place
		return nil
	}
	defer func() { stepLauncher = orig }()

	c := &chain{ID: "t1", CWD: "/work", Steps: []*chainStep{
		{Name: "a", Status: "pending", Session: "a"},
		{Name: "b", Status: "pending", Session: "b"},
		{Name: "c", Status: "pending", Session: "c"},
	}}
	chainMu.Lock()
	chains[c.ID] = c
	chainMu.Unlock()

	if err := startNextStep(c); err != nil {
		t.Fatal(err)
	}
	if got := statusList(c); got != "running,pending,pending" {
		t.Fatalf("after start: %s", got)
	}

	advanceChain(c) // a finishes → b runs
	if got := statusList(c); got != "done,running,pending" {
		t.Fatalf("after 1st advance: %s", got)
	}
	advanceChain(c) // b finishes → c runs
	if got := statusList(c); got != "done,done,running" {
		t.Fatalf("after 2nd advance: %s", got)
	}
	advanceChain(c) // c finishes → chain done
	if got := statusList(c); got != "done,done,done" {
		t.Fatalf("after 3rd advance: %s", got)
	}
	if !c.Done {
		t.Error("chain should be marked done")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(launched) != 3 || launched[0] != "a" || launched[1] != "b" || launched[2] != "c" {
		t.Errorf("launch order wrong: %v", launched)
	}
}

func statusList(c *chain) string {
	out := ""
	for i, s := range c.Steps {
		if i > 0 {
			out += ","
		}
		out += s.Status
	}
	return out
}
