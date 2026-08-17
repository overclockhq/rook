package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"gofr.dev/pkg/gofr"
)

// A task graph is a DAG of agent steps: each node runs when its upstream
// dependencies are satisfied, edges are conditional on a dep passing/failing,
// and approval nodes pause the run for a human. The whole graph is checkpointed
// to SQLite on every state change, so a run resumes after a restart. This is
// rook's local take on LangGraph (conditional edges + interrupts + durable
// checkpoints) — no cloud, file-based, tmux-driven.

const graphsSchema = `CREATE TABLE IF NOT EXISTS graphs (
	id         TEXT PRIMARY KEY,
	title      TEXT,
	cwd        TEXT,
	worktree   INTEGER,
	run_cwd    TEXT,
	nodes      TEXT NOT NULL,
	done       INTEGER,
	created_at INTEGER,
	updated_at INTEGER
)`

// graphDep is an incoming edge: this node depends on `Node`, and the edge only
// fires when that upstream reaches the `On` outcome (pass|fail|done).
type graphDep struct {
	Node string `json:"node"`
	On   string `json:"on"` // "pass" (default) | "fail" | "done"
}

// graphNode is one step. Status: pending → (blocked) → running/awaiting →
// done|failed|skipped. Result is pass|fail once the node resolves.
type graphNode struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Prompt    string     `json:"prompt"`
	Type      string     `json:"type"` // "agent" | "approval"
	Verify    bool       `json:"verify"`
	DependsOn []graphDep `json:"dependsOn"`
	Status    string     `json:"status"`
	Result    string     `json:"result"`
	Session   string     `json:"session"`   // tmux session name
	SessionID string     `json:"sessionId"` // Claude session UUID, for drill-in to the Operator view
	StartedAt int64      `json:"startedAt"`
}

type taskGraph struct {
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	CWD      string       `json:"cwd"`
	Worktree bool         `json:"worktree"`
	RunCWD   string       `json:"runCwd"`
	Nodes    []*graphNode `json:"nodes"`
	Done     bool         `json:"done"`
	Created  int64        `json:"created"`
	Updated  int64        `json:"updated"`
}

var (
	graphMu    sync.Mutex
	graphStore = map[string]*taskGraph{}
	graphSeq   int64
	// graphLauncher actually starts an agent node; indirected so the scheduler
	// can be unit-tested without spawning real agents or touching tmux.
	graphLauncher = defaultGraphLaunch
)

func terminalStatus(s string) bool { return s == "done" || s == "failed" || s == "skipped" }

func nodeByID(g *taskGraph, id string) *graphNode {
	for _, n := range g.Nodes {
		if n.ID == id {
			return n
		}
	}
	return nil
}

// depOutcome reports whether a dependency edge is satisfied, and whether it has
// become impossible (the upstream resolved to an outcome the edge can never
// match — so the downstream node must be skipped).
func depOutcome(dep graphDep, up *graphNode) (satisfied, impossible bool) {
	if up == nil || !terminalStatus(up.Status) {
		return false, false // upstream still pending/running
	}
	on := dep.On
	if on == "" {
		on = "pass"
	}
	switch on {
	case "done":
		return up.Status != "skipped", up.Status == "skipped"
	case "fail":
		ok := up.Result == "fail"
		return ok, !ok
	default: // "pass"
		ok := up.Result == "pass"
		return ok, !ok
	}
}

// nodeReadiness classifies a not-yet-terminal node: "run" (all deps satisfied),
// "skip" (a dep is impossible), or "wait" (deps still resolving).
func nodeReadiness(g *taskGraph, n *graphNode) string {
	ready := true
	for _, dep := range n.DependsOn {
		sat, imp := depOutcome(dep, nodeByID(g, dep.Node))
		if imp {
			return "skip"
		}
		if !sat {
			ready = false
		}
	}
	if ready {
		return "run"
	}
	return "wait"
}

// scheduleGraph advances the graph: skips nodes whose edges became impossible,
// and returns the agent nodes to launch and whether the graph is now complete.
// It runs at most one agent node at a time (nodes share a worktree, so parallel
// agents would collide) — approval nodes don't count against that limit.
// Caller holds graphMu. Pure except for status mutation; launching is done by
// the caller so it can be mocked in tests.
func scheduleGraph(g *taskGraph) (toLaunch []*graphNode, toAwait []*graphNode) {
	agentRunning := false
	for _, n := range g.Nodes {
		if n.Type == "agent" && n.Status == "running" {
			agentRunning = true
		}
	}
	changed := true
	for changed {
		changed = false
		for _, n := range g.Nodes {
			if terminalStatus(n.Status) || n.Status == "running" || n.Status == "awaiting" {
				continue
			}
			switch nodeReadiness(g, n) {
			case "skip":
				n.Status = "skipped"
				changed = true
			case "run":
				if n.Type == "approval" {
					n.Status = "awaiting"
					toAwait = append(toAwait, n)
					changed = true
				} else if !agentRunning {
					n.Status = "running"
					n.StartedAt = time.Now().UnixMilli()
					agentRunning = true
					toLaunch = append(toLaunch, n)
					changed = true
				}
			}
		}
	}
	done := true
	for _, n := range g.Nodes {
		if !terminalStatus(n.Status) {
			done = false
			break
		}
	}
	g.Done = done
	return toLaunch, toAwait
}

// defaultGraphLaunch spawns an agent for a node in the graph's run dir. The first
// launched node of a worktree graph creates the worktree; the rest reuse it.
func defaultGraphLaunch(g *taskGraph, n *graphNode) error {
	req := spawnReq{Name: n.Session, CWD: g.CWD, Agent: "claude", Prompt: n.Prompt, Autonomous: true}
	if g.Worktree && g.RunCWD == "" {
		req.Worktree = true
	} else if g.RunCWD != "" {
		req.CWD = g.RunCWD
	}
	_, wt, _, err := spawnAgentSession(req)
	if err != nil {
		return err
	}
	if wt != "" {
		g.RunCWD = wt
	} else if g.RunCWD == "" {
		g.RunCWD = g.CWD
	}
	return nil
}

// runSchedule schedules + launches under the lock, then persists. Returns the
// nodes now awaiting approval (for the caller to surface if needed).
func runSchedule(g *taskGraph) {
	graphMu.Lock()
	toLaunch, _ := scheduleGraph(g)
	for _, n := range toLaunch {
		if err := graphLauncher(g, n); err != nil {
			n.Status = "failed"
			n.Result = "fail"
			log.Printf("graph %s node %s launch failed: %v", g.ID, n.Name, err)
		}
	}
	g.Updated = time.Now().UnixMilli()
	graphMu.Unlock()
	saveGraph(g)
	// launching one node may unblock nothing until it finishes; but a failed
	// launch could immediately open the next node — re-run once if anything failed.
	graphMu.Lock()
	stillRunnable := false
	for _, n := range g.Nodes {
		if (n.Status == "pending" || n.Status == "") && nodeReadiness(g, n) != "wait" {
			stillRunnable = true
		}
	}
	graphMu.Unlock()
	if stillRunnable {
		runSchedule(g)
	}
}

// completeGraphNode marks a running agent node done with a pass/fail result and
// re-schedules. resultOverride, when non-empty, sets the result directly (else
// pass, or a verify-gate result when the node opted into verification).
func completeGraphNode(g *taskGraph, n *graphNode, resultOverride string) {
	graphMu.Lock()
	if n.Status != "running" { // idempotent: only a running node completes
		graphMu.Unlock()
		return
	}
	n.Status = "done"
	if resultOverride != "" {
		n.Result = resultOverride
	} else if n.Verify {
		graphMu.Unlock()
		res := runVerifyForGraph(g.RunCWD)
		graphMu.Lock()
		if res {
			n.Result = "pass"
		} else {
			n.Result = "fail"
			n.Status = "failed"
		}
	} else {
		n.Result = "pass"
	}
	g.Updated = time.Now().UnixMilli()
	graphMu.Unlock()
	saveGraph(g)
	runSchedule(g)
}

// runVerifyForGraph runs the project's detected build/test gate in dir, returning
// pass/fail. Reuses the verify machinery from the review gate. When no gate is
// detected (or it couldn't run), it does NOT block the graph — returns pass.
func runVerifyForGraph(dir string) bool {
	if dir == "" {
		return true
	}
	cmd := detectVerifyCmd(dir)
	if cmd == "" {
		return true
	}
	res := runVerify(dir, cmd)
	if !res.Ran {
		return true
	}
	return res.OK
}

// startGraphPoller drives graph advancement WITHOUT depending on the Claude Code
// hooks bridge: it polls each running node's own agent session and completes the
// node when that specific session has finished its turn (idle) or vanished. This
// fixes two things at once — graphs that "did nothing" because hooks weren't
// installed, and the old per-cwd advance that completed unrelated graphs sharing
// a directory (this keys on the node's unique session, never the directory).
func startGraphPoller(interval time.Duration) {
	go func() {
		for {
			time.Sleep(interval)
			advanceGraphsBySession()
		}
	}()
}

// graphNodeBusy remembers which nodes were ever observed actually working, so a
// node isn't completed during its agent's boot window (a fresh claude sits
// "idle" at its prompt before the task even starts). Guarded by graphMu.
var graphNodeBusy = map[string]bool{}

func busyKey(gID, nID string) string { return gID + "|" + nID }

// nodeAgentFinished decides whether a running agent node's turn is over. Keyed on
// the node's unique session (never the directory, so sibling graphs can't
// cross-complete) AND requires it was seen working first — a not-yet-scanned
// booting agent, or one idling at its prompt before it began, is NOT finished.
func nodeAgentFinished(n *graphNode, now int64, statusByName map[string]string, everBusy bool) bool {
	if n.Type != "agent" || n.Status != "running" || n.Session == "" {
		return false
	}
	if now-n.StartedAt < 6000 { // startup debounce
		return false
	}
	st, present := statusByName[n.Session]
	if present {
		if st != "idle" {
			return false // busy / waiting / shell — still going
		}
		// idle: done if we saw it work, or it's idled long enough that even a
		// task too fast for the poller to catch as "busy" has certainly finished.
		return everBusy || now-n.StartedAt > 25000
	}
	// session gone: only "finished" if we saw it work; otherwise it likely failed
	// to boot — leave it running rather than falsely completing it.
	return everBusy
}

func advanceGraphsBySession() {
	// map each live agent's tmux session NAME -> its status and Claude session id
	statusByName := map[string]string{}
	idByName := map[string]string{}
	paneSess := tmuxPaneSessions() // pane id -> session name
	for _, s := range ScanSessions(1) {
		if !s.Alive || s.TmuxPane == "" {
			continue
		}
		if name := paneSess[s.TmuxPane]; name != "" {
			statusByName[name] = s.Status
			idByName[name] = s.SessionID
		}
	}
	now := time.Now().UnixMilli()
	graphMu.Lock()
	var pairs []struct {
		g *taskGraph
		n *graphNode
	}
	for _, g := range graphStore {
		if g.Done {
			continue
		}
		for _, n := range g.Nodes {
			// record the node's Claude session id (for drill-in) while it's live
			if n.SessionID == "" && n.Session != "" {
				if id := idByName[n.Session]; id != "" {
					n.SessionID = id
				}
			}
			// mark it as having worked once its session is seen busy
			if st := statusByName[n.Session]; st == "busy" || st == "shell" {
				graphNodeBusy[busyKey(g.ID, n.ID)] = true
			}
			if nodeAgentFinished(n, now, statusByName, graphNodeBusy[busyKey(g.ID, n.ID)]) {
				pairs = append(pairs, struct {
					g *taskGraph
					n *graphNode
				}{g, n})
			}
		}
	}
	graphMu.Unlock()
	for _, p := range pairs {
		completeGraphNode(p.g, p.n, "")
	}
}

// ---- persistence ----------------------------------------------------------

func saveGraph(g *taskGraph) {
	if db == nil {
		return
	}
	graphMu.Lock()
	blob, _ := json.Marshal(g.Nodes)
	wt := 0
	if g.Worktree {
		wt = 1
	}
	dn := 0
	if g.Done {
		dn = 1
	}
	graphMu.Unlock()
	_, _ = db.Exec(`INSERT INTO graphs (id,title,cwd,worktree,run_cwd,nodes,done,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET title=excluded.title, run_cwd=excluded.run_cwd,
		nodes=excluded.nodes, done=excluded.done, updated_at=excluded.updated_at`,
		g.ID, g.Title, g.CWD, wt, g.RunCWD, string(blob), dn, g.Created, g.Updated)
}

// loadGraphs restores checkpointed graphs on boot so runs survive a restart.
func loadGraphs() {
	if db == nil {
		return
	}
	rows, err := db.Query(`SELECT id,title,cwd,worktree,run_cwd,nodes,done,created_at,updated_at FROM graphs ORDER BY created_at ASC`)
	if err != nil {
		return
	}
	defer rows.Close()
	graphMu.Lock()
	defer graphMu.Unlock()
	for rows.Next() {
		var g taskGraph
		var wt, dn int
		var blob string
		if err := rows.Scan(&g.ID, &g.Title, &g.CWD, &wt, &g.RunCWD, &blob, &dn, &g.Created, &g.Updated); err != nil {
			continue
		}
		g.Worktree = wt == 1
		g.Done = dn == 1
		_ = json.Unmarshal([]byte(blob), &g.Nodes)
		// a node marked running at checkpoint time is orphaned after a restart
		// (its tmux pane may be gone) — reset it to pending so it can re-run.
		for _, n := range g.Nodes {
			if n.Status == "running" {
				n.Status = "pending"
			}
		}
		gg := g
		graphStore[g.ID] = &gg
		// keep the id sequence ahead of restored ids so a new graph can't reuse one
		var n int64
		if _, err := fmt.Sscanf(g.ID, "graph-%d", &n); err == nil && n > atomic.LoadInt64(&graphSeq) {
			atomic.StoreInt64(&graphSeq, n)
		}
	}
}

// ---- HTTP -----------------------------------------------------------------

type graphReq struct {
	Title    string `json:"title"`
	CWD      string `json:"cwd"`
	Worktree bool   `json:"worktree"`
	Nodes    []struct {
		ID        string     `json:"id"`
		Name      string     `json:"name"`
		Prompt    string     `json:"prompt"`
		Type      string     `json:"type"`
		Verify    bool       `json:"verify"`
		DependsOn []graphDep `json:"dependsOn"`
	} `json:"nodes"`
}

func handleGraphCreate(ctx *gofr.Context) (any, error) {
	var req graphReq
	if err := ctx.Bind(&req); err != nil || req.CWD == "" || len(req.Nodes) == 0 {
		return nil, errf(http.StatusBadRequest, "cwd and at least one node required")
	}
	id := fmt.Sprintf("graph-%d", atomic.AddInt64(&graphSeq, 1))
	g := &taskGraph{ID: id, Title: firstNonEmpty(req.Title, "graph"), CWD: req.CWD, Worktree: req.Worktree, Created: time.Now().UnixMilli(), Updated: time.Now().UnixMilli()}
	seen := map[string]bool{}
	// idMap maps every way a node might be referenced (its raw id, its raw name,
	// and the sanitized id) to the final sanitized id, so dependsOn edges resolve
	// even when a node name has spaces/punctuation that safeName rewrites.
	idMap := map[string]string{}
	for i, rn := range req.Nodes {
		nid := safeName(firstNonEmpty(rn.ID, rn.Name, fmt.Sprintf("n%d", i+1)))
		if seen[nid] {
			nid = fmt.Sprintf("%s-%d", nid, i+1)
		}
		seen[nid] = true
		if rn.ID != "" {
			idMap[rn.ID] = nid
		}
		if rn.Name != "" {
			idMap[rn.Name] = nid
		}
		idMap[nid] = nid
		typ := rn.Type
		if typ != "approval" {
			typ = "agent"
		}
		g.Nodes = append(g.Nodes, &graphNode{
			ID: nid, Name: firstNonEmpty(rn.Name, nid), Prompt: rn.Prompt, Type: typ,
			Verify: rn.Verify, DependsOn: rn.DependsOn, Status: "pending",
			Session: fmt.Sprintf("%s-%s", id, nid),
		})
	}
	// normalize dependsOn references through the same mapping (idMap first, then
	// safeName as a fallback) so they point at the sanitized node ids.
	for _, n := range g.Nodes {
		for j := range n.DependsOn {
			ref := n.DependsOn[j].Node
			if mapped, ok := idMap[ref]; ok {
				n.DependsOn[j].Node = mapped
			} else {
				n.DependsOn[j].Node = safeName(ref)
			}
		}
	}
	// validate edges point at real nodes
	for _, n := range g.Nodes {
		for _, d := range n.DependsOn {
			if nodeByID(g, d.Node) == nil {
				return nil, errf(http.StatusBadRequest, "node %q depends on unknown node %q", n.ID, d.Node)
			}
		}
	}
	graphMu.Lock()
	graphStore[id] = g
	graphMu.Unlock()
	saveGraph(g)
	runSchedule(g)
	return rawJSON(g)
}

func handleGraphs(ctx *gofr.Context) (any, error) {
	graphMu.Lock()
	defer graphMu.Unlock()
	out := make([]*taskGraph, 0, len(graphStore))
	for _, g := range graphStore {
		out = append(out, g)
	}
	return rawJSON(out)
}

type graphApproveReq struct {
	ID       string `json:"id"`
	Node     string `json:"node"`
	Approved bool   `json:"approved"`
}

// handleGraphApprove resolves an approval-interrupt node: approve routes its
// pass-edges, reject routes its fail-edges.
func handleGraphApprove(ctx *gofr.Context) (any, error) {
	var req graphApproveReq
	if err := ctx.Bind(&req); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	graphMu.Lock()
	g := graphStore[req.ID]
	graphMu.Unlock()
	if g == nil {
		return nil, errf(http.StatusNotFound, "no such graph")
	}
	graphMu.Lock()
	n := nodeByID(g, req.Node)
	if n == nil || n.Type != "approval" {
		graphMu.Unlock()
		return nil, errf(http.StatusBadRequest, "no such approval node")
	}
	n.Status = "done"
	if req.Approved {
		n.Result = "pass"
	} else {
		n.Result = "fail"
	}
	g.Updated = time.Now().UnixMilli()
	graphMu.Unlock()
	saveGraph(g)
	runSchedule(g)
	return rawJSON(g)
}

// handleGraphDelete removes a graph (and its checkpoint). Does not kill any
// still-running agent pane — that stays for the user to stop from the roster.
func handleGraphDelete(ctx *gofr.Context) (any, error) {
	id := ctx.Param("id")
	if id == "" {
		return nil, errf(http.StatusBadRequest, "id required")
	}
	graphMu.Lock()
	delete(graphStore, id)
	graphMu.Unlock()
	if db != nil {
		_, _ = db.Exec(`DELETE FROM graphs WHERE id = ?`, id)
	}
	return rawJSON(map[string]any{"ok": true})
}

// handleGraphAdvance manually completes a graph's running node (fallback when the
// Stop signal doesn't fire).
func handleGraphAdvance(ctx *gofr.Context) (any, error) {
	id := ctx.Param("id")
	graphMu.Lock()
	g := graphStore[id]
	var running *graphNode
	if g != nil {
		for _, n := range g.Nodes {
			if n.Type == "agent" && n.Status == "running" {
				running = n
				break
			}
		}
	}
	graphMu.Unlock()
	if g == nil {
		return nil, errf(http.StatusNotFound, "no such graph")
	}
	if running != nil {
		completeGraphNode(g, running, "")
	}
	return rawJSON(g)
}
