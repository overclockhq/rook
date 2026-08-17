package main

import (
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"gofr.dev/pkg/gofr"
)

// A chain is a linear task dependency graph: an ordered list of agent steps that
// run one at a time in a shared working directory, each auto-unblocking the next
// when it finishes (detected via the Stop hook). This is rook's local take on
// Agent Teams' "finishing a task auto-unblocks its dependents" — agent-to-agent
// hand-off without a cloud fleet.

type chainStep struct {
	Name    string `json:"name"`
	Prompt  string `json:"prompt"`
	Status  string `json:"status"`  // pending | running | done
	Session string `json:"session"` // tmux session it launched as
}

type chain struct {
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	CWD      string       `json:"cwd"`      // shared working dir all steps run in
	Worktree bool         `json:"worktree"` // isolate the whole chain in one worktree
	Steps    []*chainStep `json:"steps"`
	Created  int64        `json:"created"`
	Done     bool         `json:"done"`
	runCWD   string       // resolved run dir (the worktree, if any)
	startedAt int64       // ms when the current step launched (debounce Stop)
}

var (
	chainMu  sync.Mutex
	chains   = map[string]*chain{}
	chainSeq int64
	// stepLauncher is the function that actually starts a step. Indirected so
	// tests can drive the state machine without spawning real agents.
	stepLauncher = defaultLaunchStep
)

// defaultLaunchStep spawns a claude agent for a chain step in the chain's run
// dir. The first step of a worktree chain creates the worktree; later steps
// reuse it (hand-off in place).
func defaultLaunchStep(c *chain, s *chainStep) error {
	req := spawnReq{Name: s.Session, CWD: c.CWD, Agent: "claude", Prompt: s.Prompt, Autonomous: true}
	// worktree only on the first step; later steps run in the created dir
	if c.Worktree && c.runCWD == "" {
		req.Worktree = true
	} else if c.runCWD != "" {
		req.CWD = c.runCWD
	}
	_, wt, _, err := spawnAgentSession(req)
	if err != nil {
		return err
	}
	if wt != "" {
		c.runCWD = wt
	} else if c.runCWD == "" {
		c.runCWD = c.CWD
	}
	return nil
}

type chainReq struct {
	Title    string `json:"title"`
	CWD      string `json:"cwd"`
	Worktree bool   `json:"worktree"`
	Steps    []struct {
		Name   string `json:"name"`
		Prompt string `json:"prompt"`
	} `json:"steps"`
}

func handleChainCreate(ctx *gofr.Context) (any, error) {
	var req chainReq
	if err := ctx.Bind(&req); err != nil || req.CWD == "" || len(req.Steps) == 0 {
		return nil, errf(http.StatusBadRequest, "cwd and at least one step required")
	}
	id := fmt.Sprintf("chain-%d", atomic.AddInt64(&chainSeq, 1))
	c := &chain{ID: id, Title: firstNonEmpty(req.Title, "chain"), CWD: req.CWD, Worktree: req.Worktree, Created: time.Now().UnixMilli()}
	for i, st := range req.Steps {
		c.Steps = append(c.Steps, &chainStep{
			Name:    fmt.Sprintf("%s-s%d-%s", id, i+1, safeName(st.Name)),
			Prompt:  st.Prompt,
			Status:  "pending",
			Session: fmt.Sprintf("%s-s%d-%s", id, i+1, safeName(st.Name)),
		})
	}
	chainMu.Lock()
	chains[id] = c
	chainMu.Unlock()

	if err := startNextStep(c); err != nil {
		return nil, errf(http.StatusConflict, "start first step: %v", err)
	}
	return rawJSON(c)
}

// startNextStep launches the first pending step, marking it running. Returns nil
// when there's nothing left (chain complete). Caller need not hold chainMu.
func startNextStep(c *chain) error {
	chainMu.Lock()
	defer chainMu.Unlock()
	for _, s := range c.Steps {
		if s.Status == "pending" {
			if err := stepLauncher(c, s); err != nil {
				return err
			}
			s.Status = "running"
			c.startedAt = time.Now().UnixMilli()
			return nil
		}
	}
	c.Done = true
	return nil
}

// advanceChain marks the running step done and starts the next. Returns true if
// it advanced (or completed) a chain.
func advanceChain(c *chain) bool {
	chainMu.Lock()
	advanced := false
	for _, s := range c.Steps {
		if s.Status == "running" {
			s.Status = "done"
			advanced = true
			break
		}
	}
	chainMu.Unlock()
	if advanced {
		_ = startNextStep(c)
	}
	return advanced
}

// advanceChainsForCWD is called from the Stop hook: a session finished in cwd, so
// advance any chain whose current step runs there. Debounced so the step's own
// startup Stop can't instantly skip it.
func advanceChainsForCWD(cwd string) {
	if cwd == "" {
		return
	}
	now := time.Now().UnixMilli()
	chainMu.Lock()
	var toAdvance []*chain
	for _, c := range chains {
		if c.Done {
			continue
		}
		runDir := c.runCWD
		if runDir == "" {
			runDir = c.CWD
		}
		if runDir == cwd && now-c.startedAt > 4000 {
			toAdvance = append(toAdvance, c)
		}
	}
	chainMu.Unlock()
	for _, c := range toAdvance {
		advanceChain(c)
	}
}

func handleChains(ctx *gofr.Context) (any, error) {
	chainMu.Lock()
	defer chainMu.Unlock()
	out := make([]*chain, 0, len(chains))
	for _, c := range chains {
		out = append(out, c)
	}
	return rawJSON(out)
}

// handleChainAdvance manually advances a chain (fallback when the auto-signal
// doesn't fire, e.g. the agent is stuck idle rather than truly stopped).
func handleChainAdvance(ctx *gofr.Context) (any, error) {
	id := ctx.Param("id")
	chainMu.Lock()
	c := chains[id]
	chainMu.Unlock()
	if c == nil {
		return nil, errf(http.StatusNotFound, "no such chain")
	}
	advanceChain(c)
	return rawJSON(c)
}

// chainSummary is a compact projection for the board's Queued column.
func pendingChainSteps() []map[string]any {
	chainMu.Lock()
	defer chainMu.Unlock()
	var out []map[string]any
	for _, c := range chains {
		if c.Done {
			continue
		}
		for _, s := range c.Steps {
			if s.Status == "pending" {
				out = append(out, map[string]any{"chain": c.Title, "step": s.Name, "prompt": clip(s.Prompt, 80)})
			}
		}
	}
	return out
}
