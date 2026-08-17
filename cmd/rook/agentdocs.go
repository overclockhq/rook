package main

import (
	"net/http"
	"os"
	"path/filepath"

	"gofr.dev/pkg/gofr"
)

// agentDocNames are repo instruction files worth surfacing to a new agent, in
// priority order. AGENTS.md is the cross-tool convention many agents don't
// auto-load; CLAUDE.md is Claude's; the rest are common house rules.
var agentDocNames = []string{"AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md", filepath.Join(".github", "copilot-instructions.md")}

type agentDoc struct {
	Name  string `json:"name"`  // basename, e.g. AGENTS.md
	Rel   string `json:"rel"`   // path relative to the repo root
	Bytes int64  `json:"bytes"` // file size
}

// detectAgentDocs lists instruction files present at the repo root for dir. It
// resolves to the git top-level so a subdirectory launch still finds the repo's
// root-level conventions; falls back to dir when it isn't a git repo.
func detectAgentDocs(dir string) []agentDoc {
	root := gitToplevel(dir)
	if root == "" {
		root = dir
	}
	var out []agentDoc
	for _, name := range agentDocNames {
		p := filepath.Join(root, name)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			out = append(out, agentDoc{Name: filepath.Base(name), Rel: name, Bytes: fi.Size()})
		}
	}
	return out
}

// handleAgentDocs surfaces a repo's agent-instruction files so the launcher can
// offer to have a new agent read and follow them (opt-in).
func handleAgentDocs(ctx *gofr.Context) (any, error) {
	p := ctx.Param("path")
	if p == "" {
		return nil, errf(http.StatusBadRequest, "path required")
	}
	p = filepath.Clean(p)
	fi, err := os.Stat(p)
	if err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "path is not a directory")
	}
	return rawJSON(map[string]any{"files": detectAgentDocs(p)})
}
