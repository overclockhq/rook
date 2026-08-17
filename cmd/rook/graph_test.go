package main

import "testing"

func gnode(id, typ string, deps ...graphDep) *graphNode {
	return &graphNode{ID: id, Name: id, Type: typ, DependsOn: deps, Status: "pending", Session: id}
}
func dep(node, on string) graphDep { return graphDep{Node: node, On: on} }

// complete marks a node terminal with a result, as the runtime would.
func complete(n *graphNode, result string) {
	n.Result = result
	if result == "fail" {
		n.Status = "failed"
	} else {
		n.Status = "done"
	}
}
func statusOfNode(g *taskGraph, id string) string { return nodeByID(g, id).Status }
func launchedIDs(ns []*graphNode) []string {
	out := []string{}
	for _, n := range ns {
		out = append(out, n.ID)
	}
	return out
}
func onlyID(t *testing.T, ns []*graphNode, want string) {
	t.Helper()
	if len(ns) != 1 || ns[0].ID != want {
		t.Fatalf("expected launch [%s], got %v", want, launchedIDs(ns))
	}
}

func TestGraphLinearOneAtATime(t *testing.T) {
	g := &taskGraph{Nodes: []*graphNode{
		gnode("a", "agent"),
		gnode("b", "agent", dep("a", "pass")),
		gnode("c", "agent", dep("b", "pass")),
	}}
	l, _ := scheduleGraph(g)
	onlyID(t, l, "a") // only a runnable; single agent at a time
	complete(nodeByID(g, "a"), "pass")
	l, _ = scheduleGraph(g)
	onlyID(t, l, "b")
	complete(nodeByID(g, "b"), "pass")
	l, _ = scheduleGraph(g)
	onlyID(t, l, "c")
	complete(nodeByID(g, "c"), "pass")
	scheduleGraph(g)
	if !g.Done {
		t.Fatalf("graph should be done")
	}
}

func TestGraphConditionalEdges(t *testing.T) {
	build := func() *taskGraph {
		return &taskGraph{Nodes: []*graphNode{
			gnode("a", "agent"),
			gnode("ok", "agent", dep("a", "pass")),
			gnode("bad", "agent", dep("a", "fail")),
		}}
	}
	// a passes → ok runs, bad skipped
	g := build()
	scheduleGraph(g)
	complete(nodeByID(g, "a"), "pass")
	l, _ := scheduleGraph(g)
	onlyID(t, l, "ok")
	if statusOfNode(g, "bad") != "skipped" {
		t.Fatalf("bad should be skipped when a passed, got %s", statusOfNode(g, "bad"))
	}
	// a fails → bad runs, ok skipped
	g = build()
	scheduleGraph(g)
	complete(nodeByID(g, "a"), "fail")
	l, _ = scheduleGraph(g)
	onlyID(t, l, "bad")
	if statusOfNode(g, "ok") != "skipped" {
		t.Fatalf("ok should be skipped when a failed, got %s", statusOfNode(g, "ok"))
	}
}

func TestGraphApprovalInterrupt(t *testing.T) {
	g := &taskGraph{Nodes: []*graphNode{
		gnode("a", "agent"),
		gnode("gate", "approval", dep("a", "pass")),
		gnode("b", "agent", dep("gate", "pass")),
	}}
	scheduleGraph(g)
	complete(nodeByID(g, "a"), "pass")
	l, aw := scheduleGraph(g)
	if len(l) != 0 {
		t.Fatalf("no agent should run while awaiting approval, got %v", launchedIDs(l))
	}
	if len(aw) != 1 || aw[0].ID != "gate" || statusOfNode(g, "gate") != "awaiting" {
		t.Fatalf("gate should be awaiting approval, got %v", launchedIDs(aw))
	}
	// approve
	complete(nodeByID(g, "gate"), "pass")
	l, _ = scheduleGraph(g)
	onlyID(t, l, "b")
}

func TestGraphDiamond(t *testing.T) {
	g := &taskGraph{Nodes: []*graphNode{
		gnode("a", "agent"),
		gnode("b", "agent", dep("a", "pass")),
		gnode("c", "agent", dep("a", "pass")),
		gnode("d", "agent", dep("b", "pass"), dep("c", "pass")),
	}}
	scheduleGraph(g)
	complete(nodeByID(g, "a"), "pass")
	l, _ := scheduleGraph(g) // b or c (single agent) — b comes first in order
	onlyID(t, l, "b")
	complete(nodeByID(g, "b"), "pass")
	l, _ = scheduleGraph(g)
	onlyID(t, l, "c")
	complete(nodeByID(g, "c"), "pass")
	l, _ = scheduleGraph(g)
	onlyID(t, l, "d") // d only after BOTH b and c
}

func TestGraphSkipPropagation(t *testing.T) {
	g := &taskGraph{Nodes: []*graphNode{
		gnode("a", "agent"),
		gnode("b", "agent", dep("a", "pass")),
		gnode("c", "agent", dep("b", "pass")),
	}}
	scheduleGraph(g)
	complete(nodeByID(g, "a"), "fail") // a fails → b needs pass → skip → c needs b pass → skip
	scheduleGraph(g)
	if statusOfNode(g, "b") != "skipped" || statusOfNode(g, "c") != "skipped" {
		t.Fatalf("skip should propagate: b=%s c=%s", statusOfNode(g, "b"), statusOfNode(g, "c"))
	}
	if !g.Done {
		t.Fatalf("graph should be done after all nodes terminal")
	}
}

func TestGraphDependsOnNormalization(t *testing.T) {
	// mirrors handleGraphCreate's id + dependsOn normalization: a node name with a
	// space becomes a sanitized id, and edges referencing the raw name must resolve.
	idMap := map[string]string{}
	nodes := []struct{ id, name string }{{"", "draft plan"}, {"", "ship"}}
	g := &taskGraph{}
	for i, rn := range nodes {
		nid := safeName(firstNonEmpty(rn.id, rn.name, ""))
		if rn.id != "" {
			idMap[rn.id] = nid
		}
		if rn.name != "" {
			idMap[rn.name] = nid
		}
		idMap[nid] = nid
		var deps []graphDep
		if i == 1 {
			deps = []graphDep{{Node: "draft plan", On: "pass"}} // raw reference with a space
		}
		g.Nodes = append(g.Nodes, &graphNode{ID: nid, Name: rn.name, DependsOn: deps})
	}
	for _, n := range g.Nodes {
		for j := range n.DependsOn {
			ref := n.DependsOn[j].Node
			if m, ok := idMap[ref]; ok {
				n.DependsOn[j].Node = m
			} else {
				n.DependsOn[j].Node = safeName(ref)
			}
		}
	}
	// the "ship" node's edge must now resolve to the sanitized "draft-plan" id
	ship := g.Nodes[1]
	if nodeByID(g, ship.DependsOn[0].Node) == nil {
		t.Fatalf("edge %q did not resolve after normalization; ids=%v", ship.DependsOn[0].Node, []string{g.Nodes[0].ID, g.Nodes[1].ID})
	}
}

// TestNodeAgentFinished pins graph advancement: a running node completes when its
// own session goes idle or vanishes (past the debounce), never on a shared dir,
// and never while its session is busy or waiting on a permission prompt.
func TestNodeAgentFinished(t *testing.T) {
	old := int64(10000)  // StartedAt well past the 6s debounce vs now
	now := int64(20000)
	run := func(status string, present bool, startedAt int64, everBusy bool) bool {
		m := map[string]string{}
		if present {
			m["g1-plan"] = status
		}
		n := &graphNode{Type: "agent", Status: "running", Session: "g1-plan", StartedAt: startedAt}
		return nodeAgentFinished(n, now, m, everBusy)
	}
	if !run("idle", true, old, true) {
		t.Error("idle after working should finish the node")
	}
	if !run("", false, old, true) {
		t.Error("a vanished session that had worked should finish the node")
	}
	if run("busy", true, old, true) {
		t.Error("a busy session is not finished")
	}
	if run("waiting", true, old, true) {
		t.Error("a session waiting on a permission prompt is not finished")
	}
	if run("idle", true, 19000, true) { // now-StartedAt = 1s < 6s debounce
		t.Error("within the startup debounce, don't complete")
	}
	// boot-window guard: idle but never seen working AND not yet past the 25s
	// fallback → still booting, must NOT complete
	if run("idle", true, old, false) { // now-old = 10s
		t.Error("idle but never seen working (still booting) must NOT complete")
	}
	if run("", false, old, false) {
		t.Error("absent and never seen working (failed/slow boot) must NOT complete")
	}
	// but a fast task the poller never caught as busy still completes after 25s idle
	if !run("idle", true, int64(-10000), false) { // now-startedAt = 30s
		t.Error("idle for >25s should complete even if 'busy' was never observed")
	}
	// a non-running node never completes
	nd := &graphNode{Type: "agent", Status: "done", Session: "g1-plan", StartedAt: old}
	if nodeAgentFinished(nd, now, map[string]string{"g1-plan": "idle"}, true) {
		t.Error("a non-running node must not be completed")
	}
}
