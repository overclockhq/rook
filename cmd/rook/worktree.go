package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// worktreeReg maps a spawned tmux session name to the git worktree created for
// it, so Stop can auto-remove it.
var (
	worktreeMu  sync.Mutex
	worktreeReg = map[string]string{}
)

func rememberWorktree(name, path string) {
	worktreeMu.Lock()
	worktreeReg[name] = path
	worktreeMu.Unlock()
}

func worktreeForTarget(target string) string {
	worktreeMu.Lock()
	defer worktreeMu.Unlock()
	return worktreeReg[target]
}

func forgetWorktree(target string) {
	worktreeMu.Lock()
	delete(worktreeReg, target)
	worktreeMu.Unlock()
}

func worktreesDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rook", "worktrees")
}

// removeWorktree tears down a git worktree: resolve its main repo, run
// `git worktree remove --force`, then clean up any remnants and prune. Returns
// an error if the directory is still present afterwards — the caller used to
// discard every failure and report success over a no-op.
func removeWorktree(path string) error {
	main := ""
	if out, err := execWithTimeout("git", 10*time.Second, "-C", path, "rev-parse", "--git-common-dir"); err == nil {
		gitdir := strings.TrimSpace(string(out))
		if !filepath.IsAbs(gitdir) {
			gitdir = filepath.Join(path, gitdir)
		}
		main = filepath.Dir(gitdir) // parent of the .git dir
	}
	if main != "" {
		_, _ = execWithTimeout("git", 30*time.Second, "-C", main, "worktree", "remove", "--force", path)
	}
	if _, err := os.Stat(path); err == nil {
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove %s: %w", path, err)
		}
	}
	if main != "" {
		_, _ = execWithTimeout("git", 15*time.Second, "-C", main, "worktree", "prune")
		// best-effort: drop the throwaway rook/<dir> branch createWorktree made
		_, _ = execWithTimeout("git", 10*time.Second, "-C", main, "branch", "-D", "rook/"+filepath.Base(path))
	}
	// Confirm it's actually gone rather than trusting the commands ran.
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("worktree still present after removal: %s", path)
	}
	return nil
}

// worktreeDirty reports whether a worktree has uncommitted changes, so a delete
// can refuse to silently discard work. Unreadable/non-git → not dirty (allow).
func worktreeDirty(path string) bool {
	out, err := execWithTimeout("git", 8*time.Second, "-C", path, "status", "--porcelain")
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) != ""
}

// Worktree describes an isolated agent worktree under ~/.rook/worktrees.
type Worktree struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Branch  string `json:"branch"`
	Repo    string `json:"repo"`
	InUse   bool   `json:"inUse"` // a live session is working in it
	Created int64  `json:"created"`
}

// listWorktrees scans ~/.rook/worktrees for agent worktrees.
func listWorktrees() []Worktree {
	entries, _ := os.ReadDir(worktreesDir())
	live := map[string]bool{}
	for _, s := range ScanSessions(0) {
		if s.Alive && s.CWD != "" {
			live[s.CWD] = true
		}
	}
	out := []Worktree{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(worktreesDir(), e.Name())
		wt := Worktree{Path: p, Name: e.Name(), InUse: live[p]}
		if fi, err := e.Info(); err == nil {
			wt.Created = fi.ModTime().UnixMilli()
		}
		if out2, err := execWithTimeout("git", 8*time.Second, "-C", p, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
			wt.Branch = strings.TrimSpace(string(out2))
		}
		if out2, err := execWithTimeout("git", 8*time.Second, "-C", p, "remote", "get-url", "origin"); err == nil {
			u := strings.TrimSpace(string(out2))
			u = strings.TrimSuffix(u, ".git")
			u = strings.TrimPrefix(u, "https://github.com/")
			u = strings.TrimPrefix(u, "git@github.com:")
			wt.Repo = u
		}
		out = append(out, wt)
	}
	return out
}

func handleWorktreesGet(ctx *gofr.Context) (any, error) {
	return rawJSON(listWorktrees())
}

// underWorktreesDir reports whether p is a CHILD of the managed worktrees dir.
// The trailing separator guards against a sibling like "<base>-evil" slipping
// past a bare prefix check.
func underWorktreesDir(p string) bool {
	if p == "" {
		return false
	}
	return strings.HasPrefix(filepath.Clean(p), worktreesDir()+string(filepath.Separator))
}

func handleWorktreesDelete(ctx *gofr.Context) (any, error) {
	p := ctx.Param("path")
	clean := filepath.Clean(p)
	if !underWorktreesDir(p) {
		return nil, errf(http.StatusBadRequest, "path must be under the rook worktrees dir")
	}
	if ctx.Param("force") != "1" && worktreeDirty(clean) {
		return nil, errf(http.StatusConflict, "worktree has uncommitted changes — pass force=1 to delete anyway")
	}
	if err := removeWorktree(clean); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true})
}
