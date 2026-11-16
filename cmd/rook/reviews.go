package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gofr.dev/pkg/gofr"
)

// Reviews page: a headless senior-review pipeline. A run asks the user's
// read-only `tech-lead` agent to review one PR or one local branch and return
// structured JSON, then sends every blocker/major finding to the read-only
// `finding-verifier` agent, which tries to disprove each one.
//
// Decision: this sits beside the auto-review in review.go instead of extending
// it. The auto-review is an interactive tmux reviewer fired on the Stop hook for
// an agent's worktree, with free-text output a human reads in the terminal.
// This pipeline is headless (`claude -p`), targets a PR or a branch the user
// picks, returns structured findings that are persisted and verified, and must
// never be triggered by agent activity. Both share diff.go's PR diff, merge-base
// and numstat helpers and repos.go's checkout discovery.

// reviewClaudeBin is the claude binary the pipeline runs. Tests point it at a
// fake script; ROOK_CLAUDE_BIN overrides it at runtime.
var reviewClaudeBin = func() string {
	if b := os.Getenv("ROOK_CLAUDE_BIN"); b != "" {
		return b
	}
	return "claude"
}()

// reviewMaxTurns caps each agent call; reviewTimeout bounds a whole agent call.
var (
	reviewMaxTurns = 40
	reviewTimeout  = 30 * time.Minute
)

const (
	reviewAgent   = "tech-lead"
	verifierAgent = "finding-verifier"
	maxRawBytes   = 256 << 10
)

// Run statuses. queued waits for the single review slot.
const (
	rsQueued    = "queued"
	rsReviewing = "reviewing"
	rsVerifying = "verifying"
	rsDone      = "done"
	rsFailed    = "failed"
	rsCanceled  = "canceled"
)

// reviewRunsSchema persists review runs. Findings, blast radius and questions
// are stored as JSON text: they are only ever read back whole.
const reviewRunsSchema = `CREATE TABLE IF NOT EXISTS review_runs (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	kind            TEXT NOT NULL,
	repo            TEXT NOT NULL DEFAULT '',
	pr              INTEGER NOT NULL DEFAULT 0,
	path            TEXT NOT NULL,
	base            TEXT NOT NULL DEFAULT '',
	status          TEXT NOT NULL,
	error           TEXT NOT NULL DEFAULT '',
	verdict         TEXT NOT NULL DEFAULT '',
	intent          TEXT NOT NULL DEFAULT '',
	blast_radius    TEXT NOT NULL DEFAULT '[]',
	findings        TEXT NOT NULL DEFAULT '[]',
	questions       TEXT NOT NULL DEFAULT '[]',
	diff_files      INTEGER NOT NULL DEFAULT 0,
	diff_add        INTEGER NOT NULL DEFAULT 0,
	diff_del        INTEGER NOT NULL DEFAULT 0,
	cost_usd        REAL NOT NULL DEFAULT 0,
	turns           INTEGER NOT NULL DEFAULT 0,
	verify_cost_usd REAL NOT NULL DEFAULT 0,
	verify_turns    INTEGER NOT NULL DEFAULT 0,
	verify_error    TEXT NOT NULL DEFAULT '',
	raw_review      TEXT NOT NULL DEFAULT '',
	raw_verify      TEXT NOT NULL DEFAULT '',
	session_id      TEXT NOT NULL DEFAULT '',
	created_at      INTEGER NOT NULL,
	started_at      INTEGER NOT NULL DEFAULT 0,
	finished_at     INTEGER NOT NULL DEFAULT 0
)`

// migrateReviewRuns creates the table and fails any run a previous rook process
// left mid-flight: its claude child died with that process.
func migrateReviewRuns(d *sql.DB) error {
	if d == nil {
		return nil // store disabled; handlers report it
	}
	if _, err := d.Exec(reviewRunsSchema); err != nil {
		return err
	}
	_, err := d.Exec(`UPDATE review_runs SET status = ?, error = 'interrupted: rook restarted', finished_at = ?
		WHERE status IN (?, ?, ?)`, rsFailed, time.Now().UnixMilli(), rsQueued, rsReviewing, rsVerifying)
	return err
}

// verification is the finding-verifier's result for one finding.
type verification struct {
	Verdict  string `json:"verdict"` // confirmed | disproved | unclear
	Evidence string `json:"evidence"`
	Note     string `json:"note"`
}

// reviewFinding mirrors one tech-lead finding, plus the verifier's result.
type reviewFinding struct {
	ID              string        `json:"id"`
	Severity        string        `json:"severity"`
	Lens            string        `json:"lens"`
	File            string        `json:"file"`
	Line            int           `json:"line"`
	Claim           string        `json:"claim"`
	FailureScenario string        `json:"failure_scenario"`
	Evidence        string        `json:"evidence"`
	Fix             string        `json:"fix"`
	Verification    *verification `json:"verification,omitempty"`
}

// techLeadOutput is the JSON the tech-lead agent returns.
type techLeadOutput struct {
	Verdict     string          `json:"verdict"`
	Intent      string          `json:"intent"`
	BlastRadius []string        `json:"blast_radius"`
	Findings    []reviewFinding `json:"findings"`
	Questions   []string        `json:"questions"`
}

// verifierOutput is the JSON the finding-verifier agent returns.
type verifierOutput struct {
	Results []struct {
		ID       string `json:"id"`
		Verdict  string `json:"verdict"`
		Evidence string `json:"evidence"`
		Note     string `json:"note"`
	} `json:"results"`
}

// claudeEnvelope is `claude -p --output-format json`'s single result object.
type claudeEnvelope struct {
	Type         string  `json:"type"`
	Subtype      string  `json:"subtype"`
	IsError      bool    `json:"is_error"`
	Result       string  `json:"result"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	NumTurns     int     `json:"num_turns"`
}

// reviewRun is one persisted run. The list endpoint omits the raw outputs.
type reviewRun struct {
	ID            int64           `json:"id"`
	Kind          string          `json:"kind"` // pr | local
	Repo          string          `json:"repo"`
	PR            int             `json:"pr"`
	Path          string          `json:"path"`
	Base          string          `json:"base"`
	Status        string          `json:"status"`
	Error         string          `json:"error"`
	Verdict       string          `json:"verdict"`
	Intent        string          `json:"intent"`
	BlastRadius   []string        `json:"blastRadius"`
	Findings      []reviewFinding `json:"findings"`
	Questions     []string        `json:"questions"`
	Counts        map[string]int  `json:"counts"`
	DiffFiles     int             `json:"diffFiles"`
	DiffAdd       int             `json:"diffAdd"`
	DiffDel       int             `json:"diffDel"`
	CostUSD       float64         `json:"costUsd"`
	Turns         int             `json:"turns"`
	VerifyCostUSD float64         `json:"verifyCostUsd"`
	VerifyTurns   int             `json:"verifyTurns"`
	VerifyError   string          `json:"verifyError"`
	RawReview     string          `json:"rawReview,omitempty"`
	RawVerify     string          `json:"rawVerify,omitempty"`
	CreatedAt     int64           `json:"createdAt"`
	StartedAt     int64           `json:"startedAt"`
	FinishedAt    int64           `json:"finishedAt"`
}

func (r reviewRun) active() bool {
	return r.Status == rsQueued || r.Status == rsReviewing || r.Status == rsVerifying
}

// ---- in-memory run control ----

var (
	// reviewSlot serialises runs: each one is a long Opus session on the
	// user's plan, so a second request queues instead of running in parallel.
	reviewSlot = make(chan struct{}, 1)

	reviewMu      sync.Mutex
	reviewCancels = map[int64]context.CancelFunc{}
	// reviewSessions holds the claude session ids of in-flight agent calls, so
	// the hooks bridge can ignore their Stop events (see isReviewSession).
	reviewSessions = map[string]bool{}
)

// isReviewSession reports whether a hook event came from a review-pipeline
// agent. Its Stop must not fire auto-review/auto-verify or advance a chain in
// the user's checkout.
func isReviewSession(id string) bool {
	if id == "" {
		return false
	}
	reviewMu.Lock()
	defer reviewMu.Unlock()
	return reviewSessions[id]
}

// skipReviewStops wraps the hooks bridge so a review agent's Stop or
// SubagentStop is acknowledged and dropped: it must not fire auto-review or
// auto-verify, or advance a chain, in the user's checkout. Every other event
// reaches the wrapped handler with its payload intact.
func skipReviewStops(next gofr.Handler) gofr.Handler {
	return func(ctx *gofr.Context) (any, error) {
		var raw map[string]any
		if err := ctx.Bind(&raw); err != nil {
			return nil, errf(http.StatusBadRequest, "bad hook payload")
		}
		ev, _ := raw["hook_event_name"].(string)
		sid, _ := raw["session_id"].(string)
		if (ev == "Stop" || ev == "SubagentStop") && isReviewSession(sid) {
			return rawJSON(map[string]any{})
		}
		ctx.Request = boundRequest{Request: ctx.Request, body: raw}
		return next(ctx)
	}
}

// boundRequest replays an already-decoded JSON body to a handler's Bind.
type boundRequest struct {
	gofr.Request
	body map[string]any
}

func (b boundRequest) Bind(into any) error {
	buf, err := json.Marshal(b.body)
	if err != nil {
		return err
	}
	return json.Unmarshal(buf, into)
}

// ---- request validation + run creation ----

type reviewStartReq struct {
	Repo string `json:"repo"` // owner/name (PR mode)
	PR   int    `json:"pr"`
	Path string `json:"path"` // local checkout; optional in PR mode
	Base string `json:"base"` // base branch (local mode)
}

// baseRefRe keeps the base branch a plain ref name: it reaches git's command
// line, so no leading dash and no shell or revision syntax.
var baseRefRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$`)

// resolveCheckout finds the local checkout of owner/name via rook's repo
// discovery (git remote match), as the launcher does.
var resolveCheckout = func(repo string) string {
	want := strings.ToLower(repo)
	for _, r := range discoverRepos() {
		if r.Remote == want {
			return r.Path
		}
	}
	return ""
}

// validateReviewReq normalises a start request into a queued run or returns a
// 4xx error. It never runs an agent.
func validateReviewReq(req reviewStartReq) (reviewRun, error) {
	run := reviewRun{Status: rsQueued}
	req.Repo = strings.TrimSpace(req.Repo)
	req.Path = strings.TrimSpace(req.Path)
	req.Base = strings.TrimSpace(req.Base)
	switch {
	case req.Repo != "" || req.PR != 0:
		if !repoRe.MatchString(req.Repo) || req.PR <= 0 {
			return run, errf(http.StatusBadRequest, "repo must be owner/name and pr a positive number")
		}
		path := req.Path
		if path == "" {
			path = resolveCheckout(strings.ToLower(req.Repo))
		}
		if path == "" {
			return run, errf(http.StatusBadRequest, "no local checkout of %s found; clone it first", req.Repo)
		}
		run.Kind, run.Repo, run.PR, run.Path = "pr", strings.ToLower(req.Repo), req.PR, path
	case req.Path != "":
		if !baseRefRe.MatchString(req.Base) || strings.Contains(req.Base, "..") {
			return run, errf(http.StatusBadRequest, "base branch required (e.g. origin/main)")
		}
		run.Kind, run.Path, run.Base = "local", req.Path, req.Base
	default:
		return run, errf(http.StatusBadRequest, "give repo + pr, or path + base")
	}
	run.Path = filepath.Clean(run.Path)
	if fi, err := os.Stat(run.Path); err != nil || !fi.IsDir() {
		return run, errf(http.StatusBadRequest, "path is not a directory")
	}
	if !isWorkTree(run.Path) {
		return run, errf(http.StatusBadRequest, "not a git work tree")
	}
	if run.Kind == "local" {
		if _, err := gitOut(run.Path, "rev-parse", "--verify", "--quiet", run.Base+"^{commit}"); err != nil {
			return run, errf(http.StatusBadRequest, "base %q is not a branch or commit in this repo", run.Base)
		}
	}
	if run.Repo == "" {
		run.Repo = repoForDir(run.Path)
	}
	return run, nil
}

func insertReviewRun(r reviewRun) (int64, error) {
	res, err := db.Exec(`INSERT INTO review_runs (kind, repo, pr, path, base, status, created_at) VALUES (?,?,?,?,?,?,?)`,
		r.Kind, r.Repo, r.PR, r.Path, r.Base, r.Status, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ---- persistence helpers ----

const reviewCols = `id, kind, repo, pr, path, base, status, error, verdict, intent, blast_radius, findings, questions,
	diff_files, diff_add, diff_del, cost_usd, turns, verify_cost_usd, verify_turns, verify_error, created_at, started_at, finished_at`

func scanReviewRun(sc interface{ Scan(...any) error }, extra ...any) (reviewRun, error) {
	var r reviewRun
	var blast, findings, questions string
	dest := []any{&r.ID, &r.Kind, &r.Repo, &r.PR, &r.Path, &r.Base, &r.Status, &r.Error, &r.Verdict, &r.Intent,
		&blast, &findings, &questions, &r.DiffFiles, &r.DiffAdd, &r.DiffDel, &r.CostUSD, &r.Turns,
		&r.VerifyCostUSD, &r.VerifyTurns, &r.VerifyError, &r.CreatedAt, &r.StartedAt, &r.FinishedAt}
	if err := sc.Scan(append(dest, extra...)...); err != nil {
		return r, err
	}
	_ = json.Unmarshal([]byte(blast), &r.BlastRadius)
	_ = json.Unmarshal([]byte(findings), &r.Findings)
	_ = json.Unmarshal([]byte(questions), &r.Questions)
	if r.BlastRadius == nil {
		r.BlastRadius = []string{}
	}
	if r.Findings == nil {
		r.Findings = []reviewFinding{}
	}
	if r.Questions == nil {
		r.Questions = []string{}
	}
	r.Counts = severityCounts(r.Findings)
	return r, nil
}

func listReviewRuns() ([]reviewRun, error) {
	rows, err := db.Query(`SELECT ` + reviewCols + ` FROM review_runs ORDER BY id DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []reviewRun{}
	for rows.Next() {
		r, err := scanReviewRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func getReviewRun(id int64) (reviewRun, error) {
	row := db.QueryRow(`SELECT `+reviewCols+`, raw_review, raw_verify FROM review_runs WHERE id = ?`, id)
	var rawReview, rawVerify string
	r, err := scanReviewRun(row, &rawReview, &rawVerify)
	r.RawReview, r.RawVerify = rawReview, rawVerify
	return r, err
}

// setReviewFields updates named columns on one run. Column names are fixed by
// callers, never user input.
func setReviewFields(id int64, fields map[string]any) {
	if db == nil || len(fields) == 0 {
		return
	}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sets := make([]string, len(keys))
	args := make([]any, 0, len(keys)+1)
	for i, k := range keys {
		sets[i] = k + " = ?"
		args = append(args, fields[k])
	}
	args = append(args, id)
	if _, err := db.Exec(`UPDATE review_runs SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		log.Printf("review run %d: update failed: %v", id, err)
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// ---- ranking ----

var severityRank = map[string]int{"blocker": 0, "major": 1, "minor": 2, "nit": 3}

func sevRank(s string) int {
	if r, ok := severityRank[s]; ok {
		return r
	}
	return len(severityRank)
}

// rankFindings normalises severities and orders findings blocker→nit, keeping
// the agent's order within a severity.
func rankFindings(fs []reviewFinding) []reviewFinding {
	for i := range fs {
		fs[i].Severity = strings.ToLower(strings.TrimSpace(fs[i].Severity))
		fs[i].Lens = strings.ToLower(strings.TrimSpace(fs[i].Lens))
		if fs[i].ID == "" {
			fs[i].ID = "F" + strconv.Itoa(i+1)
		}
	}
	sort.SliceStable(fs, func(i, j int) bool { return sevRank(fs[i].Severity) < sevRank(fs[j].Severity) })
	return fs
}

// severityCounts counts findings per severity, leaving out disproved ones (they
// are reported separately) so the list shows what still needs action.
func severityCounts(fs []reviewFinding) map[string]int {
	c := map[string]int{"blocker": 0, "major": 0, "minor": 0, "nit": 0, "disproved": 0}
	for _, f := range fs {
		if f.Verification != nil && f.Verification.Verdict == "disproved" {
			c["disproved"]++
			continue
		}
		if _, ok := severityRank[f.Severity]; ok {
			c[f.Severity]++
		}
	}
	return c
}

// ---- output parsing ----

var fenceRe = regexp.MustCompile("(?s)```(?:json|JSON)?\\s*\n(.*?)\n\\s*```")

// extractJSONObject pulls the first JSON object out of an agent's text result:
// a fenced ```json block if there is one, else the first decodable object.
// Trailing prose (the tech-lead appends a human summary) is ignored.
func extractJSONObject(s string, into any) error {
	var candidates []string
	for _, m := range fenceRe.FindAllStringSubmatch(s, -1) {
		candidates = append(candidates, m[1])
	}
	candidates = append(candidates, s)
	for _, c := range candidates {
		for i := strings.IndexByte(c, '{'); i >= 0; {
			dec := json.NewDecoder(strings.NewReader(c[i:]))
			if err := dec.Decode(into); err == nil {
				return nil
			}
			next := strings.IndexByte(c[i+1:], '{')
			if next < 0 {
				break
			}
			i += next + 1
		}
	}
	return errors.New("no JSON object in the agent's result")
}

// parseEnvelope decodes claude's --output-format json result.
func parseEnvelope(stdout []byte) (claudeEnvelope, error) {
	var env claudeEnvelope
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return env, errors.New("claude printed nothing")
	}
	if err := json.Unmarshal(trimmed, &env); err != nil {
		return env, fmt.Errorf("claude output is not JSON: %w", err)
	}
	return env, nil
}

// ---- agent execution ----

// agentResult is one claude -p call's outcome.
type agentResult struct {
	env    claudeEnvelope
	raw    string
	stderr string
	err    error
}

// runAgent runs `claude -p` with a read-only agent in dir and waits for it.
// It passes no flag that widens the agent's tools or permissions; the agents'
// own PreToolUse hooks deny writes outside the temp directory.
func runAgent(ctx context.Context, dir, agent, prompt string) agentResult {
	sid := newSessionID()
	reviewMu.Lock()
	reviewSessions[sid] = true
	reviewMu.Unlock()
	defer func() {
		reviewMu.Lock()
		delete(reviewSessions, sid)
		reviewMu.Unlock()
	}()

	tctx, cancel := context.WithTimeout(ctx, reviewTimeout)
	defer cancel()
	cmd := exec.CommandContext(tctx, reviewClaudeBin,
		"-p", prompt,
		"--agent", agent,
		"--output-format", "json",
		"--max-turns", strconv.Itoa(reviewMaxTurns),
		"--permission-mode", "auto",
		"--session-id", sid,
	)
	cmd.Dir = dir
	// The Stop gate would only re-run checks on a repo this session changed
	// (none); turn it off so a review never pays for it.
	cmd.Env = append(os.Environ(), "CLAUDE_GATE=off", "ROOK_REVIEW_RUN=1")
	// Own process group, so cancel kills the agent's shells too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	runErr := cmd.Run()

	res := agentResult{raw: clipBytes(stdout.String(), maxRawBytes), stderr: tail(stderr.String(), 2000)}
	env, perr := parseEnvelope(stdout.Bytes())
	res.env = env
	switch {
	case ctx.Err() != nil:
		res.err = context.Canceled
	case tctx.Err() == context.DeadlineExceeded:
		res.err = fmt.Errorf("%s timed out after %s", agent, reviewTimeout)
	case runErr != nil:
		msg := strings.TrimSpace(res.stderr)
		if msg == "" && perr == nil {
			msg = firstNonEmpty(env.Result, env.Subtype)
		}
		res.err = fmt.Errorf("%s exited: %v %s", agent, runErr, clipBytes(msg, 400))
	case perr != nil:
		res.err = perr
	case env.IsError || (env.Subtype != "" && env.Subtype != "success"):
		res.err = fmt.Errorf("%s stopped: %s %s", agent, env.Subtype, clipBytes(env.Result, 300))
	}
	return res
}

func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---- prompts ----

func reviewTarget(r reviewRun) string {
	if r.Kind == "pr" {
		return fmt.Sprintf("pull request #%d of %s", r.PR, r.Repo)
	}
	return fmt.Sprintf("the current branch against base %s", r.Base)
}

// techLeadPrompt asks for a review of exactly one PR or branch diff.
func techLeadPrompt(r reviewRun) string {
	var how string
	if r.Kind == "pr" {
		how = fmt.Sprintf("Review pull request #%d of %s, and only that PR. Get the material with "+
			"`gh pr view %d --repo %s --json title,body,files,baseRefName,headRefName` and `gh pr diff %d --repo %s`. "+
			"This directory is a local checkout of the repo but may not be on the PR branch: to read the PR's version "+
			"of a file use `git fetch origin pull/%d/head` then `git show FETCH_HEAD:<path>`, or a `git worktree add` "+
			"under the temp directory. Never check out a branch in this directory.",
			r.PR, r.Repo, r.PR, r.Repo, r.PR, r.Repo, r.PR)
	} else {
		how = fmt.Sprintf("Review the changes on the current branch of this repository against base `%s`, and only those: "+
			"`git diff %s...HEAD` (committed since the fork point) plus `git diff`, `git diff --staged` and the untracked "+
			"files in `git status` (uncommitted work).", r.Base, r.Base)
	}
	return strings.Join([]string{
		how,
		"Follow your tech-lead review procedure. Report only defects these changes introduce, each with file:line, a concrete failure scenario and evidence.",
		"Do not modify files, commit, push, or post anything to GitHub.",
		"Your final message must be ONLY the tech-lead JSON object (verdict, intent, blast_radius, findings, questions, adr) — no human summary, no prose before or after it.",
	}, "\n\n")
}

// verifierPrompt hands the blocker/major findings to the finding-verifier.
func verifierPrompt(r reviewRun, fs []reviewFinding) string {
	return strings.Join([]string{
		"These review findings are about " + reviewTarget(r) + " in this repository. Try to disprove each one.",
		"```json\n" + mustJSON(fs) + "\n```",
		"Do not modify files in this directory, commit, push, or post anything to GitHub.",
		`Your final message must be ONLY the JSON object {"results":[{"id","verdict","evidence","note"}]} with one result per finding id.`,
	}, "\n\n")
}

// ---- pipeline ----

// diffStats sizes the change before spending an agent run on it, reusing the
// diff code the Diff tab uses. An empty or unreadable diff fails the run early.
var diffStats = func(r reviewRun) (files, add, del int, err error) {
	if r.Kind == "pr" {
		d, ok := prDiffByNumber(r.Path, strconv.Itoa(r.PR))
		if !ok {
			return 0, 0, 0, fmt.Errorf("couldn't read PR #%d's diff with gh (is gh installed and authenticated, and is this checkout's origin %s?)", r.PR, r.Repo)
		}
		return len(d.Files), d.Add, d.Del, nil
	}
	mb, err := gitOut(r.Path, "merge-base", "HEAD", r.Base)
	if err != nil || mb == "" {
		return 0, 0, 0, fmt.Errorf("no merge-base between HEAD and %s", r.Base)
	}
	nums := parseNumstat(mustOut(gitOut(r.Path, "diff", "--numstat", mb)))
	untracked := mustOut(gitOut(r.Path, "ls-files", "--others", "--exclude-standard"))
	for _, n := range nums {
		if n[0] > 0 {
			add += n[0]
		}
		if n[1] > 0 {
			del += n[1]
		}
	}
	files = len(nums)
	if untracked != "" {
		files += len(strings.Split(untracked, "\n"))
	}
	return files, add, del, nil
}

// startReviewRun queues the pipeline for a stored run in the background.
func startReviewRun(id int64) {
	ctx, cancel := context.WithCancel(context.Background())
	reviewMu.Lock()
	reviewCancels[id] = cancel
	reviewMu.Unlock()
	go func() {
		defer func() {
			cancel()
			reviewMu.Lock()
			delete(reviewCancels, id)
			reviewMu.Unlock()
		}()
		executeReviewRun(ctx, id)
	}()
}

// executeReviewRun runs one review to completion: wait for the slot, size the
// diff, run the tech-lead, then verify blocker/major findings.
func executeReviewRun(ctx context.Context, id int64) {
	select {
	case reviewSlot <- struct{}{}:
		defer func() { <-reviewSlot }()
	case <-ctx.Done():
		finishReview(id, rsCanceled, "canceled before it started")
		return
	}
	run, err := getReviewRun(id)
	if err != nil {
		log.Printf("review run %d: %v", id, err)
		return
	}
	if run.Status != rsQueued {
		return // canceled while queued
	}
	setReviewFields(id, map[string]any{"status": rsReviewing, "started_at": time.Now().UnixMilli()})

	files, add, del, err := diffStats(run)
	if err != nil {
		finishReview(id, rsFailed, err.Error())
		return
	}
	setReviewFields(id, map[string]any{"diff_files": files, "diff_add": add, "diff_del": del})
	if files == 0 {
		finishReview(id, rsFailed, "nothing to review: the diff is empty")
		return
	}

	res := runAgent(ctx, run.Path, reviewAgent, techLeadPrompt(run))
	setReviewFields(id, map[string]any{"raw_review": res.raw, "cost_usd": res.env.TotalCostUSD, "turns": res.env.NumTurns})
	if res.err != nil {
		finishAgentErr(id, res.err)
		return
	}
	var out techLeadOutput
	if err := extractJSONObject(res.env.Result, &out); err != nil || out.Verdict == "" {
		finishReview(id, rsFailed, "the tech-lead's answer had no review JSON (see raw output)")
		return
	}
	findings := rankFindings(out.Findings)
	if out.BlastRadius == nil {
		out.BlastRadius = []string{}
	}
	if out.Questions == nil {
		out.Questions = []string{}
	}
	setReviewFields(id, map[string]any{
		"verdict": strings.ToLower(out.Verdict), "intent": out.Intent,
		"blast_radius": mustJSON(out.BlastRadius), "findings": mustJSON(findings), "questions": mustJSON(out.Questions),
	})

	var toVerify []reviewFinding
	for _, f := range findings {
		if f.Severity == "blocker" || f.Severity == "major" {
			toVerify = append(toVerify, f)
		}
	}
	if len(toVerify) == 0 {
		finishReview(id, rsDone, "")
		return
	}

	setReviewFields(id, map[string]any{"status": rsVerifying})
	vres := runAgent(ctx, run.Path, verifierAgent, verifierPrompt(run, toVerify))
	setReviewFields(id, map[string]any{"raw_verify": vres.raw, "verify_cost_usd": vres.env.TotalCostUSD, "verify_turns": vres.env.NumTurns})
	if errors.Is(vres.err, context.Canceled) {
		finishReview(id, rsCanceled, "canceled")
		return
	}
	// Decision: a failed verifier leaves the run done, not failed. The review
	// itself is valid; its blocker/major findings just show as unverified.
	if vres.err != nil {
		setReviewFields(id, map[string]any{"verify_error": vres.err.Error()})
		finishReview(id, rsDone, "")
		return
	}
	var vout verifierOutput
	if err := extractJSONObject(vres.env.Result, &vout); err != nil {
		setReviewFields(id, map[string]any{"verify_error": "the verifier's answer had no results JSON (see raw output)"})
		finishReview(id, rsDone, "")
		return
	}
	setReviewFields(id, map[string]any{"findings": mustJSON(applyVerification(findings, vout))})
	finishReview(id, rsDone, "")
}

// applyVerification attaches each verifier result to its finding by id. Only
// blocker/major findings take a result; unknown verdicts become unclear.
func applyVerification(fs []reviewFinding, v verifierOutput) []reviewFinding {
	byID := map[string]verification{}
	for _, r := range v.Results {
		vd := strings.ToLower(strings.TrimSpace(r.Verdict))
		if vd != "confirmed" && vd != "disproved" && vd != "unclear" {
			vd = "unclear"
		}
		byID[r.ID] = verification{Verdict: vd, Evidence: r.Evidence, Note: r.Note}
	}
	for i := range fs {
		if fs[i].Severity != "blocker" && fs[i].Severity != "major" {
			continue
		}
		if vr, ok := byID[fs[i].ID]; ok {
			vr := vr
			fs[i].Verification = &vr
		}
	}
	return fs
}

func finishAgentErr(id int64, err error) {
	if errors.Is(err, context.Canceled) {
		finishReview(id, rsCanceled, "canceled")
		return
	}
	finishReview(id, rsFailed, err.Error())
}

func finishReview(id int64, status, msg string) {
	setReviewFields(id, map[string]any{"status": status, "error": msg, "finished_at": time.Now().UnixMilli()})
}

// ---- HTTP ----

// handleReviewStart backs POST /api/reviews. It validates, stores a queued run
// and returns at once; the agents run in the background.
func handleReviewStart(ctx *gofr.Context) (any, error) {
	if db == nil {
		return nil, errf(http.StatusServiceUnavailable, "review store unavailable")
	}
	var req reviewStartReq
	if err := ctx.Bind(&req); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	run, err := validateReviewReq(req)
	if err != nil {
		return nil, err
	}
	if run.Kind == "pr" && ghBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "gh CLI not installed")
	}
	for _, a := range []string{reviewAgent, verifierAgent} {
		if !agentInstalled(run.Path, a) {
			return nil, errf(http.StatusBadRequest, "the %s agent isn't installed: add %s.md to ~/.claude/agents or the repo's .claude/agents", a, a)
		}
	}
	id, err := insertReviewRun(run)
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	startReviewRun(id)
	run, _ = getReviewRun(id)
	run.RawReview, run.RawVerify = "", ""
	return rawJSON(run)
}

// agentInstalled reports whether a Claude Code agent definition exists for
// the user or the repo, so a run fails fast instead of after a claude start.
func agentInstalled(repoDir, name string) bool {
	for _, dir := range []string{filepath.Join(claudeDir(), "agents"), filepath.Join(repoDir, ".claude", "agents")} {
		if _, err := os.Stat(filepath.Join(dir, name+".md")); err == nil {
			return true
		}
	}
	return false
}

// handleReviewList backs GET /api/reviews (newest first, no raw output).
func handleReviewList(ctx *gofr.Context) (any, error) {
	if db == nil {
		return rawJSON([]reviewRun{})
	}
	runs, err := listReviewRuns()
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(runs)
}

func reviewIDParam(ctx *gofr.Context) (int64, error) {
	id, err := strconv.ParseInt(ctx.PathParam("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, errf(http.StatusBadRequest, "bad id")
	}
	if db == nil {
		return 0, errf(http.StatusServiceUnavailable, "review store unavailable")
	}
	return id, nil
}

// handleReviewGet backs GET /api/reviews/{id}: the full run incl. raw output.
func handleReviewGet(ctx *gofr.Context) (any, error) {
	id, err := reviewIDParam(ctx)
	if err != nil {
		return nil, err
	}
	run, err := getReviewRun(id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errf(http.StatusNotFound, "no such review")
	}
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(run)
}

// handleReviewCancel backs POST /api/reviews/{id}/cancel.
func handleReviewCancel(ctx *gofr.Context) (any, error) {
	id, err := reviewIDParam(ctx)
	if err != nil {
		return nil, err
	}
	if code, err := cancelReviewRun(id); err != nil {
		return nil, errf(code, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "id": id})
}

func cancelReviewRun(id int64) (int, error) {
	run, err := getReviewRun(id)
	if errors.Is(err, sql.ErrNoRows) {
		return http.StatusNotFound, errors.New("no such review")
	}
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !run.active() {
		return http.StatusConflict, fmt.Errorf("review is already %s", run.Status)
	}
	reviewMu.Lock()
	cancel := reviewCancels[id]
	reviewMu.Unlock()
	if run.Status == rsQueued {
		finishReview(id, rsCanceled, "canceled before it started")
	}
	if cancel != nil {
		cancel()
	} else {
		// no live goroutine (shouldn't happen after startup recovery): just close it out
		finishReview(id, rsCanceled, "canceled")
	}
	return 0, nil
}

// newSessionID returns a random v4 UUID for claude's --session-id.
func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
