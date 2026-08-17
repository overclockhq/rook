package main

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// diffGitRe extracts the a/ and b/ paths from a "diff --git a/x b/y" header.
var diffGitRe = regexp.MustCompile(`^diff --git a/(.*) b/(.*)$`)

// maxPatchBytes caps the unified diff we ship to the review UI so a huge
// generated-file diff can't blow up the response.
const maxPatchBytes = 1_500_000

// diffFile is one changed path in a worktree's review diff.
type diffFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M, A, D, R, or "?" for untracked
	Add    int    `json:"add"`
	Del    int    `json:"del"`
}

// diffResult is the agent's total contribution in a worktree: everything that
// differs from the fork point (committed + uncommitted), plus untracked files.
type diffResult struct {
	Base      string     `json:"base"`  // the ref/commit the diff is against
	Files     []diffFile `json:"files"`
	Patch     string     `json:"patch"`
	Add       int        `json:"add"`
	Del       int        `json:"del"`
	Truncated bool       `json:"truncated"`
}

// gitOut runs a git subcommand in dir and returns trimmed stdout+stderr. For
// commands that signal "differences found" via exit code 1 (e.g. diff
// --no-index), the caller should ignore the error and read the output.
func gitOut(dir string, args ...string) (string, error) {
	full := append([]string{"-C", dir}, args...)
	out, err := execWithTimeout("git", 15*time.Second, full...)
	return strings.TrimSpace(string(out)), err
}

// isWorkTree reports whether dir is inside a git work tree.
func isWorkTree(dir string) bool {
	out, err := gitOut(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

// defaultBranchRef finds the base branch to diff a worktree against — the repo's
// default branch (origin/HEAD), falling back to common names. Returns "" if none
// resolve, in which case the caller diffs against HEAD (uncommitted only).
func defaultBranchRef(dir string) string {
	if out, err := gitOut(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "origin/HEAD"); err == nil && out != "" && !strings.Contains(out, "fatal") {
		return out
	}
	for _, c := range []string{"origin/main", "origin/master", "main", "master"} {
		if _, err := gitOut(dir, "rev-parse", "--verify", "--quiet", c); err == nil {
			return c
		}
	}
	return ""
}

// prBaseCache memoizes the PR base ref per worktree dir. A PR's base branch is
// stable, and the Diff tab reloads on every session switch, so one gh lookup per
// worktree is plenty. "-" is the sentinel for "checked, no PR / no gh".
var (
	prBaseCache = map[string]string{}
	prBaseMu    sync.Mutex
)

// prBaseRef resolves the base branch a checkout should be compared against when
// it belongs to a PR — the PR's OWN base (e.g. "development"), which gh detects
// from the current branch. Guessing main/master is wrong for repos that
// integrate on another branch, and inflates the diff with unrelated commits.
// Returns a git ref ("origin/development") or "" when there's no PR / no gh.
func prBaseRef(dir string) string {
	prBaseMu.Lock()
	if v, ok := prBaseCache[dir]; ok {
		prBaseMu.Unlock()
		if v == "-" {
			return ""
		}
		return v
	}
	prBaseMu.Unlock()

	ref := resolvePRBaseRef(dir)

	prBaseMu.Lock()
	if ref == "" {
		prBaseCache[dir] = "-"
	} else {
		prBaseCache[dir] = ref
	}
	prBaseMu.Unlock()
	return ref
}

// ghDirOut runs a read-only gh command with its working directory set to dir, so
// gh detects the PR from the checked-out branch. Callers guard ghBin=="".
func ghDirOut(dir string, args ...string) (string, error) {
	tctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(tctx, ghBin, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// resolvePRBaseRef asks gh (inside dir) for the current branch's PR base branch,
// then maps it to a local git ref. Used only as a fallback when the canonical
// gh pr diff is unavailable.
func resolvePRBaseRef(dir string) string {
	if ghBin == "" {
		return ""
	}
	base, err := ghDirOut(dir, "pr", "view", "--json", "baseRefName", "-q", ".baseRefName")
	if err != nil || base == "" {
		return ""
	}
	if _, err := gitOut(dir, "rev-parse", "--verify", "--quiet", "origin/"+base); err == nil {
		return "origin/" + base
	}
	if _, err := gitOut(dir, "rev-parse", "--verify", "--quiet", base); err == nil {
		return base
	}
	return ""
}

// parseUnifiedDiff derives the per-file list and total add/del counts from a
// unified diff (e.g. `gh pr diff`), so a PR diff needs no extra numstat call.
// Status comes from the git file-mode/rename headers; default is Modified.
func parseUnifiedDiff(patch string) ([]diffFile, int, int) {
	var files []diffFile
	var cur *diffFile
	totAdd, totDel := 0, 0
	flush := func() {
		if cur != nil {
			files = append(files, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			flush()
			f := diffFile{Status: "M"}
			if m := diffGitRe.FindStringSubmatch(line); m != nil {
				f.Path = m[2] // the b/ path
			}
			cur = &f
		case cur == nil:
			continue
		case strings.HasPrefix(line, "new file mode"):
			cur.Status = "A"
		case strings.HasPrefix(line, "deleted file mode"):
			cur.Status = "D"
		case strings.HasPrefix(line, "rename from"):
			cur.Status = "R"
		case strings.HasPrefix(line, "rename to "):
			cur.Path = strings.TrimSpace(strings.TrimPrefix(line, "rename to "))
		case strings.HasPrefix(line, "+++ "):
			if p := strings.TrimPrefix(line, "+++ "); p != "/dev/null" {
				cur.Path = strings.TrimPrefix(p, "b/")
			}
		case strings.HasPrefix(line, "--- "), strings.HasPrefix(line, "@@"):
			// diff header / hunk marker — not content
		case strings.HasPrefix(line, "+"):
			cur.Add++
			totAdd++
		case strings.HasPrefix(line, "-"):
			cur.Del++
			totDel++
		}
	}
	flush()
	return files, totAdd, totDel
}

// prDiff returns the canonical PR diff — exactly what GitHub shows for the pull
// request this checkout belongs to. It's authoritative: unlike a local
// merge-base diff, it isn't thrown off by stale refs or merge commits the PR
// branch pulled in from its base. Returns ok=false when there's no PR / no gh.
func prDiff(dir string) (diffResult, bool) {
	if ghBin == "" {
		return diffResult{}, false
	}
	num, err := ghDirOut(dir, "pr", "view", "--json", "number", "-q", ".number")
	if err != nil || num == "" {
		return diffResult{}, false
	}
	return prDiffByNumber(dir, num)
}

// prNumRe guards the PR number before it reaches the gh command line.
var prNumRe = regexp.MustCompile(`^[0-9]+$`)

// prDiffByNumber serves the canonical `gh pr diff <num>` — used when the caller
// already knows the PR number (a review agent), so the diff is correct even
// before the worktree has checked the PR branch out.
func prDiffByNumber(dir, num string) (diffResult, bool) {
	if ghBin == "" || !prNumRe.MatchString(num) {
		return diffResult{}, false
	}
	patch, err := ghDirOut(dir, "pr", "diff", num)
	if err != nil {
		return diffResult{}, false
	}
	files, add, del := parseUnifiedDiff(patch)
	r := diffResult{Base: "PR #" + num, Files: files, Add: add, Del: del}
	if len(patch) > maxPatchBytes {
		patch = patch[:maxPatchBytes]
		r.Truncated = true
	}
	r.Patch = patch
	return r, true
}

// diffBase returns the commit to diff against: the merge-base between HEAD and
// the base branch (the fork point), so the review shows what THIS worktree added
// and not unrelated commits the base gained since. Prefers the PR's own base
// branch; falls back to the repo default, then HEAD.
func diffBase(dir string) string {
	base := prBaseRef(dir)
	if base == "" {
		base = defaultBranchRef(dir)
	}
	if base != "" {
		if mb, err := gitOut(dir, "merge-base", "HEAD", base); err == nil && mb != "" {
			return mb
		}
		return base
	}
	return "HEAD"
}

// parseNumstat turns `git diff --numstat` output into per-file add/del counts,
// keyed by path. Binary files ("-\t-\tpath") are recorded with -1/-1.
func parseNumstat(out string) map[string][2]int {
	m := map[string][2]int{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		add, del := -1, -1
		if parts[0] != "-" {
			add, _ = strconv.Atoi(parts[0])
		}
		if parts[1] != "-" {
			del, _ = strconv.Atoi(parts[1])
		}
		m[parts[2]] = [2]int{add, del}
	}
	return m
}

// computeDiff builds the review diff for a worktree/repo directory.
func computeDiff(dir string) (diffResult, error) {
	var r diffResult
	if !isWorkTree(dir) {
		return r, errf(http.StatusBadRequest, "not a git work tree")
	}

	// Decision: prefer the canonical PR diff for a review checkout.
	// A checkout tied to a pull request should show exactly what GitHub shows
	// for that PR. A local merge-base diff gets polluted when the PR branch has
	// merged its base in (dragging other PRs' files into view) or when the local
	// base ref is stale — which is precisely what made a 2-file PR read as 56.
	if pr, ok := prDiff(dir); ok {
		return pr, nil
	}

	base := diffBase(dir)
	r.Base = base

	// tracked changes vs the fork point (committed + uncommitted)
	nameStatus, _ := gitOut(dir, "diff", "--name-status", "-M", base)
	nums := parseNumstat(mustOut(gitOut(dir, "diff", "--numstat", base)))
	for _, line := range strings.Split(nameStatus, "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		st := fields[0]
		p := fields[len(fields)-1] // for renames (Rxx\told\tnew) take the new path
		f := diffFile{Path: p, Status: string(st[0])}
		if n, ok := nums[p]; ok {
			f.Add, f.Del = n[0], n[1]
		}
		r.Files = append(r.Files, f)
		if f.Add > 0 {
			r.Add += f.Add
		}
		if f.Del > 0 {
			r.Del += f.Del
		}
	}

	var patch strings.Builder
	if p := mustOut(gitOut(dir, "diff", "-M", base)); p != "" {
		patch.WriteString(p)
		patch.WriteString("\n")
	}

	// untracked files: show each as an addition (read-only; no index mutation)
	untracked := mustOut(gitOut(dir, "ls-files", "--others", "--exclude-standard"))
	count := 0
	for _, up := range strings.Split(untracked, "\n") {
		if up == "" || count >= 200 {
			continue
		}
		count++
		// --no-index exits 1 when files differ; ignore the error, read output
		np, _ := gitOut(dir, "diff", "--no-index", "--numstat", "--", os.DevNull, up)
		add := 0
		for path, ad := range parseNumstat(np) {
			_ = path
			if ad[0] > 0 {
				add = ad[0]
			}
		}
		r.Files = append(r.Files, diffFile{Path: up, Status: "?", Add: add})
		r.Add += add
		if patch.Len() < maxPatchBytes {
			dp, _ := gitOut(dir, "diff", "--no-index", "--", os.DevNull, up)
			patch.WriteString(dp)
			patch.WriteString("\n")
		}
	}

	s := patch.String()
	if len(s) > maxPatchBytes {
		s = s[:maxPatchBytes]
		r.Truncated = true
	}
	r.Patch = s
	return r, nil
}

// mustOut drops the error from a gitOut call (used where a non-zero exit just
// means "no output / differences found" and an empty string is the right value).
func mustOut(out string, _ error) string { return out }

// handleDiff backs the review surface: GET /api/diff?path=<worktree-or-repo>.
// diffCache memoizes computeDiff per (dir, HEAD) for a short TTL, so opening the
// Diff tab (which can double-fire) doesn't run two sequential ~20s `gh pr diff`
// calls. Invalidated when HEAD moves; the short TTL bounds working-tree staleness.
type diffCacheEntry struct {
	at   time.Time
	head string
	res  diffResult
}

var (
	diffCacheMu sync.Mutex
	diffCache   = map[string]diffCacheEntry{}
)

const diffCacheTTL = 3 * time.Second

func cachedDiff(dir string) (diffResult, error) {
	head := ""
	if out, err := execWithTimeout("git", 5*time.Second, "-C", dir, "rev-parse", "HEAD"); err == nil {
		head = strings.TrimSpace(string(out))
	}
	diffCacheMu.Lock()
	e, ok := diffCache[dir]
	diffCacheMu.Unlock()
	if ok && e.head == head && time.Since(e.at) < diffCacheTTL {
		return e.res, nil
	}
	res, err := computeDiff(dir)
	if err != nil {
		return res, err
	}
	diffCacheMu.Lock()
	diffCache[dir] = diffCacheEntry{at: time.Now(), head: head, res: res}
	diffCacheMu.Unlock()
	return res, nil
}

func handleDiff(ctx *gofr.Context) (any, error) {
	p := ctx.Param("path")
	if p == "" {
		return nil, errf(http.StatusBadRequest, "path required")
	}
	p = filepath.Clean(p)
	fi, err := os.Stat(p)
	if err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "path is not a directory")
	}
	// A review agent passes the PR number it is reviewing, so we serve the
	// canonical PR diff by number — independent of whether the worktree has
	// checked the PR branch out yet (which is what made it show the local diff).
	if pr := ctx.Param("pr"); prNumRe.MatchString(pr) {
		if d, ok := prDiffByNumber(p, pr); ok {
			return rawJSON(d)
		}
	}
	res, err := cachedDiff(p)
	if err != nil {
		return nil, err
	}
	return rawJSON(res)
}
