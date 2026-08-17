package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

type cloneReq struct {
	Repo string `json:"repo"` // owner/repo
	Dir  string `json:"dir"`  // parent directory to clone into
}

// handleSessionPR reports the PR (if any) opened from a session's working dir's
// current branch — this closes the loop from issue -> agent -> PR. Returns
// {"pr": null} when the branch has no associated PR.
func handleSessionPR(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	cwd := ctx.Param("cwd")
	if cwd == "" || gitToplevel(cwd) == "" {
		return rawJSON(map[string]any{"pr": nil})
	}
	tctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(tctx, ghBin, "pr", "view", "--json", "number,title,url,state,isDraft")
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return rawJSON(map[string]any{"pr": nil}) // no PR for this branch
	}
	var pr json.RawMessage = out
	return rawJSON(map[string]any{"pr": pr})
}

// handleClone clones a GitHub repo into <dir>/<repo-name> via the gh CLI (which
// carries the user's auth, so private repos work). If a checkout already exists
// there, it's reused. This is a local write the user explicitly triggers.
func handleClone(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	var req cloneReq
	if err := ctx.Bind(&req); err != nil || !repoRe.MatchString(req.Repo) {
		return nil, errf(http.StatusBadRequest, "bad request (need repo owner/name + dir)")
	}
	if fi, err := os.Stat(req.Dir); err != nil || !fi.IsDir() {
		return nil, errf(http.StatusBadRequest, "parent directory does not exist")
	}
	target := filepath.Join(req.Dir, path.Base(req.Repo))
	if _, err := os.Stat(target); err == nil {
		if gitToplevel(target) != "" {
			return rawJSON(map[string]any{"ok": true, "path": target, "reused": true})
		}
		return nil, errf(http.StatusConflict, "target already exists and is not a git repo: %s", target)
	}
	tctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if out, err := exec.CommandContext(tctx, ghBin, "repo", "clone", req.Repo, target).CombinedOutput(); err != nil {
		return nil, errf(http.StatusInternalServerError, "clone failed: %s", strings.TrimSpace(string(out)))
	}
	return rawJSON(map[string]any{"ok": true, "path": target})
}

// ghBin is resolved once; empty if the GitHub CLI isn't installed.
var ghBin = func() string {
	p, err := exec.LookPath("gh")
	if err != nil {
		return ""
	}
	return p
}()

var (
	ownerRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	repoRe  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
	numRe   = regexp.MustCompile(`^[0-9]{1,9}$`)
)

// handleGHPRDetail returns one PR with its body, conversation comments, review
// summaries, and linked (closing) issues — so a PR-review agent's workspace can
// show the full context in-app instead of the user hunting for it on GitHub.
func handleGHPRDetail(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	repo, num := ctx.Param("repo"), ctx.Param("number")
	if !repoRe.MatchString(repo) || !numRe.MatchString(num) {
		return nil, errf(http.StatusBadRequest, "repo and number required")
	}
	return proxyJSON("pr", "view", num, "--repo", repo,
		"--json", "number,title,body,state,author,url,createdAt,headRefName,baseRefName,isDraft,labels,comments,reviews,commits,closingIssuesReferences")
}

// handleGHIssueDetail returns one issue with its body + comments.
func handleGHIssueDetail(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	repo, num := ctx.Param("repo"), ctx.Param("number")
	if !repoRe.MatchString(repo) || !numRe.MatchString(num) {
		return nil, errf(http.StatusBadRequest, "repo and number required")
	}
	return proxyJSON("issue", "view", num, "--repo", repo,
		"--json", "number,title,body,state,author,url,createdAt,labels,comments")
}

// runGH executes a gh command with a timeout. Callers pass only read-only
// subcommands — this helper never accepts user-chosen verbs, only fixed ones.
func runGH(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, ghBin, args...).Output()
}

func ghGuard() error {
	if ghBin == "" {
		return errf(http.StatusServiceUnavailable, "gh CLI not installed")
	}
	return nil
}

// proxyJSON runs a read-only gh command and returns its JSON output verbatim.
func proxyJSON(args ...string) (any, error) {
	out, err := runGH(args...)
	if err != nil {
		msg := "gh command failed"
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			msg = string(ee.Stderr)
		}
		return nil, errf(http.StatusBadGateway, "%s", msg)
	}
	return textResp(out, "application/json")
}

// handleGHOrgs returns the authed user login plus the orgs they belong to.
func handleGHOrgs(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	login, _ := runGH("api", "user", "--jq", ".login")
	orgsRaw, err := runGH("api", "user/orgs", "--paginate", "--jq", "[.[].login]")
	if err != nil {
		return nil, errf(http.StatusBadGateway, "failed to list orgs")
	}
	var orgs []string
	_ = json.Unmarshal(orgsRaw, &orgs)
	return rawJSON(map[string]any{
		"login": trimNL(string(login)),
		"orgs":  orgs,
	})
}

// handleGHRepos lists repositories for an owner (user or org), read-only.
func handleGHRepos(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	owner := ctx.Param("owner")
	if !ownerRe.MatchString(owner) {
		return nil, errf(http.StatusBadRequest, "bad owner")
	}
	return proxyJSON("repo", "list", owner,
		"--limit", "100", "--source",
		"--json", "nameWithOwner,name,description,isPrivate,isArchived,updatedAt,url,primaryLanguage,stargazerCount")
}

// handleGHIssues lists open issues for a repo, read-only.
func handleGHIssues(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	repo := ctx.Param("repo")
	if !repoRe.MatchString(repo) {
		return nil, errf(http.StatusBadRequest, "bad repo")
	}
	return proxyJSON("issue", "list", "--repo", repo,
		"--state", "open", "--limit", "60",
		"--json", "number,title,author,labels,assignees,comments,updatedAt,url")
}

// handleGHPRs lists open pull requests for a repo, read-only.
func handleGHPRs(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	repo := ctx.Param("repo")
	if !repoRe.MatchString(repo) {
		return nil, errf(http.StatusBadRequest, "bad repo")
	}
	return proxyJSON("pr", "list", "--repo", repo,
		"--state", "open", "--limit", "60",
		"--json", "number,title,author,isDraft,labels,assignees,reviewDecision,statusCheckRollup,updatedAt,url,additions,deletions")
}

func trimNL(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == '"') {
		s = s[:len(s)-1]
	}
	for len(s) > 0 && s[0] == '"' {
		s = s[1:]
	}
	return s
}
