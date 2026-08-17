package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"gofr.dev/pkg/gofr"
)

// repoInfo is one discoverable git repo the launcher can start an agent in.
type repoInfo struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Branch string `json:"branch"`
	Remote string `json:"remote"` // "owner/repo" from origin, so a GitHub PR/issue can auto-resolve its local checkout
}

// gitRemote reads origin's URL from .git/config (no subprocess) and normalizes
// it to "owner/repo" so the launcher can match a GitHub nameWithOwner to a
// local checkout — no more typing the working directory by hand.
func gitRemote(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if err != nil {
		return ""
	}
	return parseOrigin(string(b))
}

// parseOrigin pulls origin's "owner/repo" out of a git config's text.
func parseOrigin(cfg string) string {
	inOrigin := false
	for _, ln := range strings.Split(cfg, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "[remote ") {
			inOrigin = strings.Contains(t, `"origin"`)
			continue
		}
		if strings.HasPrefix(t, "[") {
			inOrigin = false
			continue
		}
		if inOrigin && strings.HasPrefix(t, "url") {
			if eq := strings.Index(t, "="); eq >= 0 {
				return normalizeRemote(strings.TrimSpace(t[eq+1:]))
			}
		}
	}
	return ""
}

// repoForDir resolves the "owner/repo" for any working dir — including a git
// worktree, whose .git is a file pointing at the main repo's config. Cached by
// dir because it's called for every session on every scan.
var (
	repoDirCache = map[string]string{}
	repoDirMu    sync.Mutex
)

func repoForDir(dir string) string {
	if dir == "" {
		return ""
	}
	repoDirMu.Lock()
	if v, ok := repoDirCache[dir]; ok {
		repoDirMu.Unlock()
		return v
	}
	repoDirMu.Unlock()
	r := gitRemote(dir)
	if r == "" {
		// worktree: .git is a file "gitdir: /main/.git/worktrees/<name>"
		if b, err := os.ReadFile(filepath.Join(dir, ".git")); err == nil {
			gd := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(b)), "gitdir:"))
			if gd != "" {
				if b2, err := os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(gd)), "config")); err == nil {
					r = parseOrigin(string(b2))
				}
			}
		}
	}
	repoDirMu.Lock()
	repoDirCache[dir] = r
	repoDirMu.Unlock()
	return r
}

// normalizeRemote turns git@host:owner/repo.git or https://host/owner/repo(.git)
// into "owner/repo" (lowercased for stable matching).
func normalizeRemote(url string) string {
	url = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(url, "/"), ".git"))
	if url == "" {
		return ""
	}
	// strip scheme + host: everything up to the last host separator (':' for scp, '/' after host)
	if i := strings.Index(url, "://"); i >= 0 {
		url = url[i+3:]
		if s := strings.Index(url, "/"); s >= 0 {
			url = url[s+1:] // drop host
		}
	} else if c := strings.LastIndex(url, ":"); c >= 0 {
		url = url[c+1:] // scp form host:owner/repo
	}
	parts := strings.Split(strings.Trim(url, "/"), "/")
	if len(parts) >= 2 {
		return strings.ToLower(parts[len(parts)-2] + "/" + parts[len(parts)-1])
	}
	return ""
}

// commonRepoParents are the directories we scan (one level deep) for git repos,
// so the launcher can offer a real repo picker instead of a free-text path box.
func commonRepoParents() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	rel := []string{
		"", "Desktop", "Desktop/github", "repos", "Repos", "Projects",
		"projects", "dev", "code", "src", "work", "git", "go/src",
	}
	out := make([]string, 0, len(rel))
	for _, r := range rel {
		out = append(out, filepath.Join(home, r))
	}
	return out
}

// isGitRepo reports whether dir is the root of a git repo (has a .git entry).
func isGitRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// gitBranch reads the current branch straight from .git/HEAD (no subprocess).
// Returns "" for a detached HEAD or unreadable HEAD.
func gitBranch(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, ".git", "HEAD"))
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(b))
	if ref := strings.TrimPrefix(s, "ref: refs/heads/"); ref != s {
		return ref
	}
	return "" // detached HEAD (raw sha) — not useful to show
}

// discoverRepos finds candidate git repos: git roots of live-session cwds, plus
// a one-level scan of common dev parent directories. Worktrees under
// ~/.rook/worktrees are excluded — those aren't repos you launch fresh work in.
func discoverRepos() []repoInfo {
	seen := map[string]bool{}
	var roots []string

	add := func(dir string) {
		if dir == "" || seen[dir] {
			return
		}
		if strings.Contains(dir, string(filepath.Separator)+".rook"+string(filepath.Separator)) {
			return
		}
		if !isGitRepo(dir) {
			return
		}
		seen[dir] = true
		roots = append(roots, dir)
	}

	// git roots of directories agents are already running in
	for _, s := range ScanSessions(0) {
		if s.CWD != "" {
			add(gitToplevel(s.CWD))
		}
	}

	// one-level scan of common parents
	for _, parent := range commonRepoParents() {
		add(parent) // the parent itself may be a repo
		entries, err := os.ReadDir(parent)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				add(filepath.Join(parent, e.Name()))
			}
		}
	}

	out := make([]repoInfo, 0, len(roots))
	for _, r := range roots {
		out = append(out, repoInfo{Path: r, Name: filepath.Base(r), Branch: gitBranch(r), Remote: gitRemote(r)})
	}
	sort.Slice(out, func(i, j int) bool {
		if strings.EqualFold(out[i].Name, out[j].Name) {
			return out[i].Path < out[j].Path
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	const cap = 200
	if len(out) > cap {
		out = out[:cap]
	}
	return out
}

// handleRepos backs the launcher's repo picker.
func handleRepos(ctx *gofr.Context) (any, error) {
	return rawJSON(discoverRepos())
}
