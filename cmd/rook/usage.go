package main

import (
	"sort"
	"time"

	"gofr.dev/pkg/gofr"
)

// ---------- cost / usage breakdown ----------

// modelCost aggregates every live session that ran on one model.
type modelCost struct {
	Model       string  `json:"model"`
	Sessions    int     `json:"sessions"`
	TokensTotal int64   `json:"tokensTotal"`
	CostUSD     float64 `json:"costUsd"`
}

// runCost is a single session's cost line item.
type runCost struct {
	SessionID   string  `json:"sessionId"`
	Title       string  `json:"title"`
	Project     string  `json:"project"`
	Model       string  `json:"model"`
	TokensTotal int64   `json:"tokensTotal"`
	CostUSD     float64 `json:"costUsd"`
}

// usageBreakdown is a Langfuse-style cost/token view over live sessions: the
// rolling token windows (with typed input/output/cache buckets), per-model
// aggregates, per-run line items, and grand totals.
type usageBreakdown struct {
	Windows     []TokenWindow `json:"windows"`
	Models      []modelCost   `json:"models"`
	Runs        []runCost     `json:"runs"`
	TokensTotal int64         `json:"tokensTotal"`
	CostUSD     float64       `json:"costUsd"`
}

// maxRuns caps the per-session line items returned (top spenders first).
const maxRuns = 50

// computeUsage aggregates live sessions into a cost/token breakdown. It groups
// by Model, maps each session to a run, and sums grand totals. Windows are
// passed through untouched (they already carry typed buckets and cost).
func computeUsage(sessions []Session, windows []TokenWindow) usageBreakdown {
	out := usageBreakdown{Windows: windows}

	// group by model, preserving first-seen order for stable output
	idx := map[string]int{}
	for _, s := range sessions {
		if i, ok := idx[s.Model]; ok {
			out.Models[i].Sessions++
			out.Models[i].TokensTotal += s.TokensTotal
			out.Models[i].CostUSD += s.CostUSD
		} else {
			idx[s.Model] = len(out.Models)
			out.Models = append(out.Models, modelCost{
				Model:       s.Model,
				Sessions:    1,
				TokensTotal: s.TokensTotal,
				CostUSD:     s.CostUSD,
			})
		}

		out.Runs = append(out.Runs, runCost{
			SessionID:   s.SessionID,
			Title:       s.Title,
			Project:     s.Project,
			Model:       s.Model,
			TokensTotal: s.TokensTotal,
			CostUSD:     s.CostUSD,
		})

		out.TokensTotal += s.TokensTotal
		out.CostUSD += s.CostUSD
	}

	// most expensive runs first
	sort.Slice(out.Runs, func(i, j int) bool {
		return out.Runs[i].CostUSD > out.Runs[j].CostUSD
	})
	if len(out.Runs) > maxRuns {
		out.Runs = out.Runs[:maxRuns]
	}

	// costliest models first too, for a consistent dashboard ordering
	sort.Slice(out.Models, func(i, j int) bool {
		return out.Models[i].CostUSD > out.Models[j].CostUSD
	})

	return out
}

// handleUsageBreakdown serves the live cost/token breakdown across all agents.
func handleUsageBreakdown(ctx *gofr.Context) (any, error) {
	sessions := ScanAllSessions(maxToolsPerSession)
	windows := TokenWindows(time.Now())
	return rawJSON(computeUsage(sessions, windows))
}
