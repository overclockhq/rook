package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

// codeContextTimeout bounds a single search so a huge tree can't hang the request.
const codeContextTimeout = 10 * time.Second

// codeContextMax caps how many matches searchCode returns when the caller passes
// a non-positive max, and clamps oversized requests.
const codeContextMax = 100

// codeMatch is one file:line hit from a code search.
type codeMatch struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// Decision: grep/agentic-search retrieval, no vector store.
// Context: naive embedding/vector RAG is unreliable at whole-codebase scale —
// chunking loses structure and nearest-neighbour recall misses exact symbols.
// Choice: shell out to a literal/regex line searcher (ripgrep > git grep > grep)
// and return exact file:line hits.
// Reason: exact, dependency-free, respects the repo's own ignore rules (rg/git),
// and matches diff.go's "shell out to git, parse text" style.
// Alternatives rejected: embedding index (build cost, staleness, fuzzy recall),
// in-process file walk (reimplements ignore handling that rg/git already do).

// pickSearchTool decides which searcher searchCode will use for dir, so the
// handler can report the same tool name it actually ran.
// Prefer ripgrep (fast, honours .gitignore, skips .git) when on PATH; else
// git grep when dir is a work tree; else portable grep -r.
func pickSearchTool(dir string) string {
	if _, err := exec.LookPath("rg"); err == nil {
		return "rg"
	}
	if isWorkTree(dir) {
		return "git-grep"
	}
	return "grep"
}

// searchCode runs a literal/regex line search for query under dir and returns up
// to max matches. A search that finds nothing (grep/git exit status 1) is not an
// error — it yields zero matches. Only a bad/empty query or missing dir errors.
func searchCode(dir, query string, max int) ([]codeMatch, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errf(http.StatusBadRequest, "query is empty")
	}
	if max <= 0 || max > codeContextMax {
		max = codeContextMax
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "dir is not a directory")
	}

	var out []byte
	switch pickSearchTool(dir) {
	case "rg":
		// --no-heading -n gives file:line:text; --color=never keeps it parseable.
		// rg already skips .git and honours .gitignore, so no manual excludes.
		out, _ = execWithTimeout("rg", codeContextTimeout,
			"--no-heading", "-n", "--color=never", "-e", query, dir)
	case "git-grep":
		// -I skips binary files, -n adds line numbers; "." scopes to dir's subtree.
		// --untracked also searches not-yet-committed (non-ignored) files — without
		// it, a repo whose files aren't staged yet (e.g. a fresh worktree) returns
		// nothing. git grep exits 1 with no matches — ignore the error, parse output.
		out, _ = execWithTimeout("git", codeContextTimeout,
			"-C", dir, "grep", "-I", "-n", "--no-color", "--untracked", "-e", query, "--", ".")
	default:
		// portable fallback: recurse, skip the usual junk dirs, skip binaries.
		out, _ = execWithTimeout("grep", codeContextTimeout,
			"-rnI",
			"--exclude-dir=.git",
			"--exclude-dir=node_modules",
			"--exclude-dir=vendor",
			"--exclude-dir=dist",
			"-e", query, dir)
	}

	return parseGrepOutput(string(out), max), nil
}

// parseGrepOutput turns "file:line:text" lines into codeMatch values, capping at
// max and skipping lines that don't carry a numeric line number.
func parseGrepOutput(out string, max int) []codeMatch {
	matches := make([]codeMatch, 0, max)
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		// file paths can contain ':', so split into exactly 3 fields and trust the
		// middle to be the line number; if it isn't, the line isn't a match row.
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		n, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		matches = append(matches, codeMatch{
			File: parts[0],
			Line: n,
			Text: strings.TrimRight(parts[2], "\r"),
		})
		if len(matches) >= max {
			break
		}
	}
	return matches
}

// handleCodeContext backs the codebase-context retrieval surface:
// GET /api/context?dir=<repo-or-dir>&q=<query>. It returns exact file:line hits
// (no vector store) plus the tool that produced them.
func handleCodeContext(ctx *gofr.Context) (any, error) {
	dir := strings.TrimSpace(ctx.Param("dir"))
	q := ctx.Param("q")
	if dir == "" {
		return nil, errf(http.StatusBadRequest, "dir required")
	}
	dir = filepath.Clean(dir)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "dir is not a directory")
	}

	tool := pickSearchTool(dir)
	matches, err := searchCode(dir, q, codeContextMax)
	if err != nil {
		return nil, err
	}
	if matches == nil {
		matches = []codeMatch{}
	}
	return rawJSON(map[string]any{
		"query":   strings.TrimSpace(q),
		"matches": matches,
		"count":   len(matches),
		"tool":    tool,
	})
}
