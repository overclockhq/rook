package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gofr.dev/pkg/gofr"
	"gofr.dev/pkg/gofr/http/response"
	_ "modernc.org/sqlite"
)

// fakeClaude is a stand-in for the claude binary. For each --agent it prints
// $FAKE_DIR/<agent>.out, writes stderr from <agent>.err, exits with the code in
// <agent>.exit, sleeps <agent>.sleep seconds first, and records its argv in
// <agent>.args — so tests pin both what the pipeline sends and how it parses.
const fakeClaude = `#!/bin/sh
agent=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--agent" ]; then agent="$a"; fi
  prev="$a"
done
for a in "$@"; do printf '%s\n' "$a"; done > "$FAKE_DIR/$agent.args"
[ -f "$FAKE_DIR/$agent.sleep" ] && sleep "$(cat "$FAKE_DIR/$agent.sleep")"
[ -f "$FAKE_DIR/$agent.err" ] && cat "$FAKE_DIR/$agent.err" >&2
[ -f "$FAKE_DIR/$agent.out" ] && cat "$FAKE_DIR/$agent.out"
code=0; [ -f "$FAKE_DIR/$agent.exit" ] && code=$(cat "$FAKE_DIR/$agent.exit")
exit "$code"
`

func withReviewDB(t *testing.T) {
	t.Helper()
	prev := db
	d, err := sql.Open("sqlite", ":memory:")
	require.NoError(t, err)
	d.SetMaxOpenConns(1)
	require.NoError(t, migrateReviewRuns(d))
	db = d
	t.Cleanup(func() { _ = d.Close(); db = prev })
}

// withFakeClaude installs the fake binary and canned outputs; returns FAKE_DIR.
func withFakeClaude(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	require.NoError(t, os.WriteFile(bin, []byte(fakeClaude), 0o755))
	for name, body := range files {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644))
	}
	t.Setenv("FAKE_DIR", dir)
	prevBin, prevStats := reviewClaudeBin, diffStats
	reviewClaudeBin = bin
	diffStats = func(reviewRun) (int, int, int, error) { return 3, 10, 2, nil }
	t.Cleanup(func() { reviewClaudeBin, diffStats = prevBin, prevStats })
	return dir
}

// envelope wraps an agent's text result the way `claude -p --output-format json` does.
func envelope(result string, cost float64, turns int) string {
	return mustJSON(map[string]any{"type": "result", "subtype": "success", "is_error": false,
		"result": result, "total_cost_usd": cost, "num_turns": turns})
}

const techLeadJSON = `{"verdict":"request-changes","intent":"add a cache","blast_radius":["handler","db"],
"findings":[
 {"id":"F1","severity":"minor","lens":"tests","file":"a.go","line":3,"claim":"m","failure_scenario":"x","evidence":"e","fix":"f"},
 {"id":"F2","severity":"Blocker","lens":"correctness","file":"b.go","line":9,"claim":"nil deref","failure_scenario":"nil → panic","evidence":"b.go:9","fix":"guard"},
 {"id":"F3","severity":"major","lens":"security","file":"c.go","line":1,"claim":"injection","failure_scenario":"' → sql","evidence":"c.go:1","fix":"bind"}
],"questions":["is it hot?"],"adr":null}`

func newRun(t *testing.T, dir string) int64 {
	t.Helper()
	id, err := insertReviewRun(reviewRun{Kind: "local", Path: dir, Base: "main", Status: rsQueued})
	require.NoError(t, err)
	return id
}

func TestExecuteReviewRun(t *testing.T) {
	fenced := "```json\n" + techLeadJSON + "\n```\n\nVerdict: request-changes. Top points: {nil deref}."
	verifier := envelope(`{"results":[{"id":"F2","verdict":"confirmed","evidence":"b.go:9 no guard","note":"real"},`+
		`{"id":"F3","verdict":"disproved","evidence":"c.go:1 uses placeholders","note":"bound"}]}`, 0.5, 4)
	onlyMinor := `{"verdict":"approve-with-nits","intent":"i","blast_radius":[],"findings":[{"id":"F1","severity":"nit","file":"a.go","line":1,"claim":"c"}],"questions":[]}`

	tests := []struct {
		name         string
		files        map[string]string
		stats        func(reviewRun) (int, int, int, error)
		wantStatus   string
		wantErr      string
		wantVerdict  string
		wantVerifier bool
		check        func(t *testing.T, r reviewRun)
	}{
		{
			name:         "success: ranked findings and verifier disproves one",
			files:        map[string]string{"tech-lead.out": envelope(techLeadJSON, 1.25, 12), "finding-verifier.out": verifier},
			wantStatus:   rsDone,
			wantVerdict:  "request-changes",
			wantVerifier: true,
			check: func(t *testing.T, r reviewRun) {
				require.Len(t, r.Findings, 3)
				assert.Equal(t, []string{"F2", "F3", "F1"}, []string{r.Findings[0].ID, r.Findings[1].ID, r.Findings[2].ID})
				assert.Equal(t, "blocker", r.Findings[0].Severity)
				require.NotNil(t, r.Findings[0].Verification)
				assert.Equal(t, "confirmed", r.Findings[0].Verification.Verdict)
				require.NotNil(t, r.Findings[1].Verification)
				assert.Equal(t, "disproved", r.Findings[1].Verification.Verdict)
				assert.Equal(t, "c.go:1 uses placeholders", r.Findings[1].Verification.Evidence)
				assert.Nil(t, r.Findings[2].Verification, "minor findings are not sent to the verifier")
				assert.Equal(t, map[string]int{"blocker": 1, "major": 0, "minor": 1, "nit": 0, "disproved": 1}, r.Counts)
				assert.InDelta(t, 1.25, r.CostUSD, 1e-9)
				assert.Equal(t, 12, r.Turns)
				assert.InDelta(t, 0.5, r.VerifyCostUSD, 1e-9)
				assert.Equal(t, []string{"handler", "db"}, r.BlastRadius)
				assert.Equal(t, []string{"is it hot?"}, r.Questions)
				assert.Equal(t, 3, r.DiffFiles)
				assert.NotEmpty(t, r.RawReview)
				assert.NotEmpty(t, r.RawVerify)
			},
		},
		{
			name:         "fenced JSON followed by a prose summary still parses",
			files:        map[string]string{"tech-lead.out": envelope(fenced, 1, 1), "finding-verifier.out": verifier},
			wantStatus:   rsDone,
			wantVerdict:  "request-changes",
			wantVerifier: true,
		},
		{
			name:       "malformed review JSON fails the run and keeps raw output",
			files:      map[string]string{"tech-lead.out": envelope("I reviewed it, looks {broken", 0.3, 2)},
			wantStatus: rsFailed,
			wantErr:    "no review JSON",
			check: func(t *testing.T, r reviewRun) {
				assert.Contains(t, r.RawReview, "looks {broken")
				assert.InDelta(t, 0.3, r.CostUSD, 1e-9, "cost is kept even when parsing fails")
			},
		},
		{
			name:       "non-JSON stdout fails the run",
			files:      map[string]string{"tech-lead.out": "not json at all"},
			wantStatus: rsFailed,
			wantErr:    "not JSON",
		},
		{
			name:       "non-zero exit fails the run with stderr",
			files:      map[string]string{"tech-lead.err": "auth expired", "tech-lead.exit": "3"},
			wantStatus: rsFailed,
			wantErr:    "auth expired",
		},
		{
			name: "max-turns stop fails the run",
			files: map[string]string{"tech-lead.out": mustJSON(map[string]any{"type": "result", "subtype": "error_max_turns",
				"is_error": true, "total_cost_usd": 2.0, "num_turns": 40})},
			wantStatus: rsFailed,
			wantErr:    "error_max_turns",
		},
		{
			name:        "no blocker or major: verifier is not run",
			files:       map[string]string{"tech-lead.out": envelope(onlyMinor, 0.2, 3)},
			wantStatus:  rsDone,
			wantVerdict: "approve-with-nits",
		},
		{
			name:         "malformed verifier output: run done, findings unverified",
			files:        map[string]string{"tech-lead.out": envelope(techLeadJSON, 1, 1), "finding-verifier.out": envelope("could not decide", 0.1, 1)},
			wantStatus:   rsDone,
			wantVerdict:  "request-changes",
			wantVerifier: true,
			check: func(t *testing.T, r reviewRun) {
				assert.Contains(t, r.VerifyError, "no results JSON")
				for _, f := range r.Findings {
					assert.Nil(t, f.Verification)
				}
			},
		},
		{
			name:         "verifier non-zero exit: run done with verify error",
			files:        map[string]string{"tech-lead.out": envelope(techLeadJSON, 1, 1), "finding-verifier.exit": "1", "finding-verifier.err": "boom"},
			wantStatus:   rsDone,
			wantVerifier: true,
			wantVerdict:  "request-changes",
			check: func(t *testing.T, r reviewRun) {
				assert.Contains(t, r.VerifyError, "boom")
			},
		},
		{
			name:       "empty diff fails before any agent runs",
			files:      map[string]string{"tech-lead.out": envelope(techLeadJSON, 1, 1)},
			stats:      func(reviewRun) (int, int, int, error) { return 0, 0, 0, nil },
			wantStatus: rsFailed,
			wantErr:    "nothing to review",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			withReviewDB(t)
			fake := withFakeClaude(t, tc.files)
			if tc.stats != nil {
				diffStats = tc.stats
			}
			id := newRun(t, t.TempDir())

			executeReviewRun(context.Background(), id)

			r, err := getReviewRun(id)
			require.NoError(t, err)
			assert.Equal(t, tc.wantStatus, r.Status, "error: %s", r.Error)
			if tc.wantErr != "" {
				assert.Contains(t, r.Error, tc.wantErr)
			}
			assert.Equal(t, tc.wantVerdict, r.Verdict)
			assert.NotZero(t, r.FinishedAt)
			_, verr := os.Stat(filepath.Join(fake, "finding-verifier.args"))
			assert.Equal(t, tc.wantVerifier, verr == nil, "verifier invoked")
			if tc.stats != nil {
				_, terr := os.Stat(filepath.Join(fake, "tech-lead.args"))
				assert.True(t, os.IsNotExist(terr), "tech-lead must not run on an empty diff")
			}
			if tc.check != nil {
				tc.check(t, r)
			}
		})
	}
}

// TestRunAgentArgs pins the command line: the read-only agent, JSON output,
// a turn cap, auto permission mode and nothing that widens permissions.
func TestRunAgentArgs(t *testing.T) {
	withReviewDB(t)
	fake := withFakeClaude(t, map[string]string{"tech-lead.out": envelope(`{"verdict":"approve","findings":[]}`, 0, 1)})
	dir := t.TempDir()
	id := newRun(t, dir)
	executeReviewRun(context.Background(), id)

	b, err := os.ReadFile(filepath.Join(fake, "tech-lead.args"))
	require.NoError(t, err)
	args := strings.Split(strings.TrimSpace(string(b)), "\n")
	joined := strings.Join(args, " ")
	assert.Equal(t, "-p", args[0])
	// the prompt spans several lines of the args file
	assert.Contains(t, joined, "against base `main`")
	assert.Contains(t, joined, "ONLY the tech-lead JSON")
	for _, want := range []string{"--agent tech-lead", "--output-format json", "--max-turns 40", "--permission-mode auto", "--disallowedTools Write,Edit,MultiEdit,NotebookEdit", "--session-id "} {
		assert.Contains(t, joined, want)
	}
	for _, banned := range []string{"bypassPermissions", "dangerously", "--allowedTools", "--add-dir", "acceptEdits"} {
		assert.NotContains(t, joined, banned)
	}
}

func TestReviewCancelKillsAgent(t *testing.T) {
	withReviewDB(t)
	fake := withFakeClaude(t, map[string]string{"tech-lead.sleep": "30", "tech-lead.out": envelope(techLeadJSON, 1, 1)})
	id := newRun(t, t.TempDir())
	startReviewRun(id)

	// wait until the fake agent is running, then read its session id
	var sid string
	require.Eventually(t, func() bool {
		b, err := os.ReadFile(filepath.Join(fake, "tech-lead.args"))
		if err != nil {
			return false
		}
		lines := strings.Split(string(b), "\n")
		for i, l := range lines {
			if l == "--session-id" && i+1 < len(lines) {
				sid = lines[i+1]
			}
		}
		return sid != ""
	}, 5*time.Second, 20*time.Millisecond)
	assert.True(t, isReviewSession(sid), "a running agent's Stop hook must be recognised")
	r, _ := getReviewRun(id)
	assert.Equal(t, rsReviewing, r.Status)

	start := time.Now()
	code, err := cancelReviewRun(id)
	require.NoError(t, err, "code %d", code)
	require.Eventually(t, func() bool { r, _ := getReviewRun(id); return r.Status == rsCanceled }, 10*time.Second, 20*time.Millisecond)
	assert.Less(t, time.Since(start), 10*time.Second, "cancel must kill the sleeping agent, not wait for it")
	assert.False(t, isReviewSession(sid))

	code, err = cancelReviewRun(id)
	assert.Error(t, err)
	assert.Equal(t, 409, code)
	code, _ = cancelReviewRun(9999)
	assert.Equal(t, 404, code)
}

func TestCancelQueuedRun(t *testing.T) {
	withReviewDB(t)
	withFakeClaude(t, nil)
	reviewSlot <- struct{}{} // occupy the slot so the run stays queued
	id := newRun(t, t.TempDir())
	startReviewRun(id)
	_, err := cancelReviewRun(id)
	require.NoError(t, err)
	<-reviewSlot
	require.Eventually(t, func() bool {
		reviewMu.Lock()
		defer reviewMu.Unlock()
		_, live := reviewCancels[id]
		return !live
	}, 5*time.Second, 10*time.Millisecond)
	r, _ := getReviewRun(id)
	assert.Equal(t, rsCanceled, r.Status)
	assert.Zero(t, r.StartedAt, "a run canceled in the queue never starts")
}

func TestMigrateReviewRunsFailsInterrupted(t *testing.T) {
	withReviewDB(t)
	a := newRun(t, "/x")
	b := newRun(t, "/y")
	setReviewFields(b, map[string]any{"status": rsDone})
	require.NoError(t, migrateReviewRuns(db))
	ra, _ := getReviewRun(a)
	rb, _ := getReviewRun(b)
	assert.Equal(t, rsFailed, ra.Status)
	assert.Contains(t, ra.Error, "interrupted")
	assert.Equal(t, rsDone, rb.Status)

	runs, err := listReviewRuns()
	require.NoError(t, err)
	require.Len(t, runs, 2)
	assert.Equal(t, b, runs[0].ID, "newest first")
	assert.Empty(t, runs[0].RawReview)
}

func TestValidateReviewReq(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"commit", "-q", "--allow-empty", "-m", "base"}} {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	prev := resolveCheckout
	resolveCheckout = func(r string) string {
		if r == "acme/app" {
			return repo
		}
		return ""
	}
	t.Cleanup(func() { resolveCheckout = prev })

	tests := []struct {
		name     string
		req      reviewStartReq
		wantErr  string
		wantKind string
	}{
		{"pr resolves checkout", reviewStartReq{Repo: "Acme/App", PR: 7}, "", "pr"},
		{"pr with explicit path", reviewStartReq{Repo: "other/x", PR: 7, Path: repo}, "", "pr"},
		{"pr without checkout", reviewStartReq{Repo: "other/x", PR: 7}, "no local checkout", ""},
		{"pr bad repo", reviewStartReq{Repo: "nope", PR: 7}, "owner/name", ""},
		{"pr missing number", reviewStartReq{Repo: "acme/app"}, "owner/name", ""},
		{"local ok", reviewStartReq{Path: repo, Base: "main"}, "", "local"},
		{"local missing base", reviewStartReq{Path: repo}, "base branch required", ""},
		{"local base looks like a flag", reviewStartReq{Path: repo, Base: "--output=/tmp/x"}, "base branch required", ""},
		{"local base range syntax", reviewStartReq{Path: repo, Base: "main..HEAD"}, "base branch required", ""},
		{"local unknown base", reviewStartReq{Path: repo, Base: "development"}, "not a branch or commit", ""},
		{"local not a repo", reviewStartReq{Path: t.TempDir(), Base: "main"}, "not a git work tree", ""},
		{"local missing dir", reviewStartReq{Path: "/does/not/exist", Base: "main"}, "not a directory", ""},
		{"nothing given", reviewStartReq{}, "give repo + pr", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			run, err := validateReviewReq(tc.req)
			if tc.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.wantKind, run.Kind)
			assert.Equal(t, rsQueued, run.Status)
			assert.Equal(t, filepath.Clean(repo), run.Path)
			if tc.wantKind == "pr" {
				assert.Equal(t, strings.ToLower(tc.req.Repo), run.Repo)
			}
		})
	}
}

func TestLocalDiffStats(t *testing.T) {
	dir := gitFixture(t) // one commit on main + uncommitted modify/delete/untracked
	files, add, _, err := diffStats(reviewRun{Kind: "local", Path: dir, Base: "main"})
	require.NoError(t, err)
	assert.Equal(t, 3, files, "modified + deleted + untracked")
	assert.Positive(t, add)
	_, _, _, err = diffStats(reviewRun{Kind: "local", Path: dir, Base: "nope"})
	assert.Error(t, err)
}

func TestExtractJSONObject(t *testing.T) {
	tests := []struct {
		name, in, want string
		ok             bool
	}{
		{"bare", `{"verdict":"approve"}`, "approve", true},
		{"fenced with prose", "Here:\n```json\n{\"verdict\":\"approve\"}\n```\nSummary {x}", "approve", true},
		{"prose then object then prose", `I think {not json} so: {"verdict":"approve-with-nits"} done`, "approve-with-nits", true},
		{"no object", "nothing here", "", false},
		{"truncated", `{"verdict":"appr`, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var out techLeadOutput
			err := extractJSONObject(tc.in, &out)
			assert.Equal(t, tc.ok, err == nil, "err=%v", err)
			assert.Equal(t, tc.want, out.Verdict)
		})
	}
}

func TestApplyVerificationNormalises(t *testing.T) {
	fs := []reviewFinding{{ID: "F1", Severity: "major"}, {ID: "F2", Severity: "minor"}}
	v := verifierOutput{}
	v.Results = append(v.Results, struct {
		ID       string `json:"id"`
		Verdict  string `json:"verdict"`
		Evidence string `json:"evidence"`
		Note     string `json:"note"`
	}{ID: "F1", Verdict: "Maybe"}, struct {
		ID       string `json:"id"`
		Verdict  string `json:"verdict"`
		Evidence string `json:"evidence"`
		Note     string `json:"note"`
	}{ID: "F2", Verdict: "disproved"})
	out := applyVerification(fs, v)
	require.NotNil(t, out[0].Verification)
	assert.Equal(t, "unclear", out[0].Verification.Verdict)
	assert.Nil(t, out[1].Verification, "the verifier can't override a minor finding")
}

func TestNewSessionIDIsUUIDv4(t *testing.T) {
	id := newSessionID()
	assert.Regexp(t, `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, id)
	assert.NotEqual(t, id, newSessionID())
}

func TestAgentInstalled(t *testing.T) {
	home, repo := t.TempDir(), t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	require.NoError(t, os.MkdirAll(filepath.Join(home, "agents"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(repo, ".claude", "agents"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(home, "agents", "tech-lead.md"), []byte("x"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, ".claude", "agents", "finding-verifier.md"), []byte("x"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(home, "agents", "finding-verifier.md"), []byte("x"), 0o644))
	assert.True(t, agentInstalled(repo, "tech-lead"), "user agent")
	assert.False(t, agentInstalled(repo, "finding-verifier"), "a repo agent with the same name would replace the user's: refuse")
	assert.False(t, agentInstalled(repo, "missing"))
}

func TestKnownRepoPath(t *testing.T) {
	repo, other := t.TempDir(), t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "sub"), 0o755))
	require.NoError(t, os.Symlink(repo, filepath.Join(other, "link")))
	prev := knownRepoPathFn
	knownRepoPathFn = func() []string { return []string{repo, "/does/not/exist"} }
	t.Cleanup(func() { knownRepoPathFn = prev })

	assert.True(t, knownRepoPath(repo))
	assert.True(t, knownRepoPath(filepath.Join(repo, "sub")), "inside a known repo")
	assert.True(t, knownRepoPath(filepath.Join(other, "link")), "symlink to a known repo resolves")
	assert.False(t, knownRepoPath(other), "unknown directory")
	assert.False(t, knownRepoPath(repo+"-sibling"), "prefix of the name is not inside")
	assert.False(t, knownRepoPath(filepath.Join(repo, "missing")))
}

func TestValidateReviewReq_UnknownRepoRefused(t *testing.T) {
	repo := gitInitRepo(t)
	prev := knownRepoPathFn
	knownRepoPathFn = func() []string { return nil }
	t.Cleanup(func() { knownRepoPathFn = prev })

	_, err := validateReviewReq(reviewStartReq{Path: repo, Base: "HEAD"})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "discovered repos")
}

// fakeReq is a minimal gofr.Request for calling handlers directly.
type fakeReq struct {
	path map[string]string
	body string
}

func (f fakeReq) Context() context.Context { return context.Background() }
func (f fakeReq) Param(string) string      { return "" }
func (f fakeReq) PathParam(k string) string {
	return f.path[k]
}
func (f fakeReq) Bind(i any) error       { return json.Unmarshal([]byte(f.body), i) }
func (f fakeReq) HostName() string       { return "" }
func (f fakeReq) Params(string) []string { return nil }

func hctx(body string, path map[string]string) *gofr.Context {
	return &gofr.Context{Context: context.Background(), Request: fakeReq{path: path, body: body}}
}

func statusOf(t *testing.T, err error) int {
	t.Helper()
	var he *httpErr
	require.ErrorAs(t, err, &he)
	return he.StatusCode()
}

// body unwraps a rawJSON response.
func body(t *testing.T, v any) any {
	t.Helper()
	r, ok := v.(response.Raw)
	require.True(t, ok, "want a raw JSON response, got %T", v)
	return r.Data
}

func gitRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"commit", "-q", "--allow-empty", "-m", "base"}} {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	return repo
}

func TestReviewHandlers(t *testing.T) {
	withReviewDB(t)
	withFakeClaude(t, map[string]string{"tech-lead.out": envelope(techLeadJSON, 1, 2), "finding-verifier.out": envelope(`{"results":[]}`, 0.1, 1)})
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	repo := gitRepo(t)

	// missing agents: rejected before any run is stored
	_, err := handleReviewStart(hctx(`{"path":"`+repo+`","base":"main"}`, nil))
	assert.Equal(t, 400, statusOf(t, err))
	assert.Contains(t, err.Error(), "tech-lead agent isn't installed")

	require.NoError(t, os.MkdirAll(filepath.Join(home, "agents"), 0o755))
	for _, a := range []string{"tech-lead", "finding-verifier"} {
		require.NoError(t, os.WriteFile(filepath.Join(home, "agents", a+".md"), []byte("x"), 0o644))
	}

	_, err = handleReviewStart(hctx(`not json`, nil))
	assert.Equal(t, 400, statusOf(t, err))
	_, err = handleReviewStart(hctx(`{"path":"`+repo+`"}`, nil))
	assert.Equal(t, 400, statusOf(t, err))

	prevGh := ghBin
	ghBin = ""
	_, err = handleReviewStart(hctx(`{"repo":"a/b","pr":1,"path":"`+repo+`"}`, nil))
	ghBin = prevGh
	assert.Equal(t, 503, statusOf(t, err))

	out, err := handleReviewStart(hctx(`{"path":"`+repo+`","base":"main"}`, nil))
	require.NoError(t, err)
	started := body(t, out).(reviewRun)
	assert.Equal(t, "local", started.Kind)
	assert.Empty(t, started.RawReview)
	require.Eventually(t, func() bool { r, _ := getReviewRun(started.ID); return r.Status == rsDone }, 10*time.Second, 20*time.Millisecond)

	out, err = handleReviewList(hctx("", nil))
	require.NoError(t, err)
	runs := body(t, out).([]reviewRun)
	require.Len(t, runs, 1)
	assert.Empty(t, runs[0].RawReview, "the list omits raw output")

	out, err = handleReviewGet(hctx("", map[string]string{"id": strconv.FormatInt(started.ID, 10)}))
	require.NoError(t, err)
	full := body(t, out).(reviewRun)
	assert.NotEmpty(t, full.RawReview, "detail carries raw output for debugging")
	assert.Equal(t, "request-changes", full.Verdict)

	_, err = handleReviewGet(hctx("", map[string]string{"id": "999"}))
	assert.Equal(t, 404, statusOf(t, err))
	_, err = handleReviewGet(hctx("", map[string]string{"id": "x"}))
	assert.Equal(t, 400, statusOf(t, err))

	_, err = handleReviewCancel(hctx("", map[string]string{"id": strconv.FormatInt(started.ID, 10)}))
	assert.Equal(t, 409, statusOf(t, err))
	_, err = handleReviewCancel(hctx("", map[string]string{"id": "0"}))
	assert.Equal(t, 400, statusOf(t, err))
	id := newRun(t, repo) // a queued run with no goroutine behind it
	out, err = handleReviewCancel(hctx("", map[string]string{"id": strconv.FormatInt(id, 10)}))
	require.NoError(t, err)
	assert.Equal(t, true, body(t, out).(map[string]any)["ok"])
	r, _ := getReviewRun(id)
	assert.Equal(t, rsCanceled, r.Status)
}

func TestReviewHandlersWithoutStore(t *testing.T) {
	prev := db
	db = nil
	t.Cleanup(func() { db = prev })
	_, err := handleReviewStart(hctx(`{}`, nil))
	assert.Equal(t, 503, statusOf(t, err))
	out, err := handleReviewList(hctx("", nil))
	require.NoError(t, err)
	assert.Empty(t, body(t, out))
	_, err = handleReviewGet(hctx("", map[string]string{"id": "1"}))
	assert.Equal(t, 503, statusOf(t, err))
	assert.NoError(t, migrateReviewRuns(nil))
	setReviewFields(1, map[string]any{"status": "x"}) // no-op, no panic
}

func TestReviewStoreErrors(t *testing.T) {
	withReviewDB(t)
	id := newRun(t, "/x")
	require.NoError(t, db.Close())

	_, err := insertReviewRun(reviewRun{Kind: "local", Path: "/x"})
	assert.Error(t, err)
	_, err = listReviewRuns()
	assert.Error(t, err)
	assert.Error(t, migrateReviewRuns(db))
	setReviewFields(id, map[string]any{"status": rsDone}) // logs, no panic
	code, err := cancelReviewRun(id)
	assert.Error(t, err)
	assert.Equal(t, 500, code)
	_, err = handleReviewList(hctx("", nil))
	assert.Equal(t, 500, statusOf(t, err))
	_, err = handleReviewGet(hctx("", map[string]string{"id": "1"}))
	assert.Equal(t, 500, statusOf(t, err))
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	require.NoError(t, os.MkdirAll(filepath.Join(home, "agents"), 0o755))
	for _, a := range []string{"tech-lead", "finding-verifier"} {
		require.NoError(t, os.WriteFile(filepath.Join(home, "agents", a+".md"), []byte("x"), 0o644))
	}
	_, err = handleReviewStart(hctx(`{"path":"`+gitRepo(t)+`","base":"main"}`, nil))
	assert.Equal(t, 500, statusOf(t, err), "insert fails on a closed store")
	executeReviewRun(context.Background(), id) // can't load the run: returns quietly
}

func TestScanReviewRunBadRow(t *testing.T) {
	withReviewDB(t)
	_, err := db.Exec(`INSERT INTO review_runs (kind, path, status, created_at, pr) VALUES ('local','/x','queued',1,'not-a-number')`)
	require.NoError(t, err)
	_, err = listReviewRuns()
	assert.Error(t, err)
}

func TestExecuteReviewRunEdges(t *testing.T) {
	t.Run("canceled while waiting for the slot", func(t *testing.T) {
		withReviewDB(t)
		withFakeClaude(t, nil)
		id := newRun(t, t.TempDir())
		reviewSlot <- struct{}{}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		executeReviewRun(ctx, id)
		<-reviewSlot
		r, _ := getReviewRun(id)
		assert.Equal(t, rsCanceled, r.Status)
	})
	t.Run("run no longer queued is skipped", func(t *testing.T) {
		withReviewDB(t)
		fake := withFakeClaude(t, nil)
		id := newRun(t, t.TempDir())
		setReviewFields(id, map[string]any{"status": rsCanceled})
		executeReviewRun(context.Background(), id)
		_, err := os.Stat(filepath.Join(fake, "tech-lead.args"))
		assert.True(t, os.IsNotExist(err))
	})
	t.Run("diff error fails the run", func(t *testing.T) {
		withReviewDB(t)
		withFakeClaude(t, nil)
		diffStats = func(reviewRun) (int, int, int, error) { return 0, 0, 0, errors.New("no gh") }
		id := newRun(t, t.TempDir())
		executeReviewRun(context.Background(), id)
		r, _ := getReviewRun(id)
		assert.Equal(t, rsFailed, r.Status)
		assert.Equal(t, "no gh", r.Error)
	})
	t.Run("cancel during verification", func(t *testing.T) {
		withReviewDB(t)
		fake := withFakeClaude(t, map[string]string{"tech-lead.out": envelope(techLeadJSON, 1, 1), "finding-verifier.sleep": "30"})
		id := newRun(t, t.TempDir())
		startReviewRun(id)
		require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(fake, "finding-verifier.args")); return err == nil }, 10*time.Second, 20*time.Millisecond)
		_, err := cancelReviewRun(id)
		require.NoError(t, err)
		require.Eventually(t, func() bool { r, _ := getReviewRun(id); return r.Status == rsCanceled }, 10*time.Second, 20*time.Millisecond)
		r, _ := getReviewRun(id)
		assert.Equal(t, "request-changes", r.Verdict, "the review result is kept")
	})
	t.Run("agent timeout", func(t *testing.T) {
		withReviewDB(t)
		withFakeClaude(t, map[string]string{"tech-lead.sleep": "5"})
		prev := reviewTimeout
		reviewTimeout = 200 * time.Millisecond
		t.Cleanup(func() { reviewTimeout = prev })
		id := newRun(t, t.TempDir())
		executeReviewRun(context.Background(), id)
		r, _ := getReviewRun(id)
		assert.Equal(t, rsFailed, r.Status)
		assert.Contains(t, r.Error, "timed out")
	})
}

func TestPRModeDiffAndPrompt(t *testing.T) {
	prev := ghBin
	ghBin = ""
	t.Cleanup(func() { ghBin = prev })
	_, _, _, err := diffStats(reviewRun{Kind: "pr", PR: 5, Repo: "a/b", Path: t.TempDir()})
	assert.ErrorContains(t, err, "PR #5")

	r := reviewRun{Kind: "pr", PR: 5, Repo: "a/b"}
	p := techLeadPrompt(r)
	assert.Contains(t, p, "gh pr diff 5 --repo a/b")
	assert.Contains(t, p, "Never check out a branch")
	assert.Contains(t, verifierPrompt(r, nil), "pull request #5 of a/b")
}

func TestSkipReviewStops(t *testing.T) {
	var got map[string]any
	calls := 0
	next := func(ctx *gofr.Context) (any, error) {
		calls++
		got = nil
		require.NoError(t, ctx.Bind(&got))
		return "next", nil
	}
	h := skipReviewStops(next)
	sid := "11111111-2222-4333-8444-555555555555"
	reviewMu.Lock()
	reviewSessions[sid] = true
	reviewMu.Unlock()
	t.Cleanup(func() { reviewMu.Lock(); delete(reviewSessions, sid); reviewMu.Unlock() })

	tests := []struct {
		name     string
		body     string
		wantNext bool
	}{
		{"review Stop is dropped", `{"hook_event_name":"Stop","session_id":"` + sid + `","cwd":"/r"}`, false},
		{"review SubagentStop is dropped", `{"hook_event_name":"SubagentStop","session_id":"` + sid + `"}`, false},
		{"other session's Stop passes through", `{"hook_event_name":"Stop","session_id":"other","cwd":"/r"}`, true},
		{"review PreToolUse still reaches the gate", `{"hook_event_name":"PreToolUse","session_id":"` + sid + `","tool_name":"Bash"}`, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls = 0
			out, err := h(hctx(tc.body, nil))
			require.NoError(t, err)
			assert.Equal(t, tc.wantNext, calls == 1)
			if tc.wantNext {
				assert.Equal(t, "next", out)
				var want map[string]any
				require.NoError(t, json.Unmarshal([]byte(tc.body), &want))
				assert.Equal(t, want, got, "payload replayed intact")
			} else {
				assert.Empty(t, body(t, out))
			}
		})
	}
	_, err := h(hctx("{bad", nil))
	assert.Equal(t, 400, statusOf(t, err))
	assert.False(t, isReviewSession(""))
}

func TestSmallHelpers(t *testing.T) {
	assert.Equal(t, 4, sevRank("critical"))
	assert.Equal(t, "ab…", clipBytes("abcdef", 2))
	assert.Equal(t, "null", mustJSON(make(chan int)))
	fs := rankFindings([]reviewFinding{{Severity: " NIT "}, {Severity: "weird"}, {Severity: "Major", ID: "X"}})
	assert.Equal(t, []string{"X", "F1", "F2"}, []string{fs[0].ID, fs[1].ID, fs[2].ID})
	assert.Equal(t, "nit", fs[1].Severity)
	assert.Error(t, boundRequest{body: map[string]any{"c": make(chan int)}}.Bind(&map[string]any{}))
}

func TestScanReviewRunNullLists(t *testing.T) {
	withReviewDB(t)
	_, err := db.Exec(`INSERT INTO review_runs (kind, path, status, created_at, blast_radius, findings, questions)
		VALUES ('local','/x','done',1,'null','null','null')`)
	require.NoError(t, err)
	runs, err := listReviewRuns()
	require.NoError(t, err)
	require.Len(t, runs, 1)
	assert.NotNil(t, runs[0].BlastRadius, "the UI expects arrays, never null")
	assert.NotNil(t, runs[0].Findings)
	assert.NotNil(t, runs[0].Questions)
}

// Review tests create their repos under the temp dir; treat it as discovered.
func init() { knownRepoPathFn = func() []string { return []string{os.TempDir()} } }

func TestKillReviewProcs(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 60 & wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, cmd.Start())
	trackReviewProc(cmd.Process.Pid, true)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	assert.Equal(t, 1, killReviewProcs())

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("review agent's process group still running after shutdown kill")
	}
	assert.Equal(t, 0, killReviewProcs(), "killed processes are no longer tracked")
}

func TestStopReviewsOnSignal(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 60 & wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, cmd.Start())
	trackReviewProc(cmd.Process.Pid, true)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	stopReviewsOnSignal()
	// The handler is registered, so SIGTERM to the test process is caught, not fatal.
	require.NoError(t, syscall.Kill(os.Getpid(), syscall.SIGTERM))

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("review agent still running after rook received SIGTERM")
	}
}

// pins that the user's focus reaches the tech-lead prompt and survives a store round trip
func TestReviewFocus(t *testing.T) {
	r := reviewRun{Kind: "pr", PR: 5, Repo: "a/b", Focus: "check the auth handler"}
	p := techLeadPrompt(r)
	assert.Contains(t, p, "<user-focus>\ncheck the auth handler\n</user-focus>")
	assert.Less(t, strings.Index(p, "user-focus"), strings.Index(p, "Your final message"), "focus comes before the output contract")
	assert.NotContains(t, techLeadPrompt(reviewRun{Kind: "pr", PR: 5, Repo: "a/b"}), "user-focus")

	withReviewDB(t)
	id, err := insertReviewRun(reviewRun{Kind: "local", Path: "/x", Base: "main", Focus: "tests only", Status: rsQueued})
	require.NoError(t, err)
	got, err := getReviewRun(id)
	require.NoError(t, err)
	assert.Equal(t, "tests only", got.Focus)
}

func TestCleanFocus(t *testing.T) {
	tests := []struct {
		name, in, want string
		wantErr        bool
	}{
		{"trims", "  focus  ", "focus", false},
		{"keeps newlines and tabs", "a\n\tb", "a\n\tb", false},
		{"drops control characters", "a\x00b\x1bc\x7f", "abc", false},
		{"at the limit", strings.Repeat("é", maxFocusRunes), strings.Repeat("é", maxFocusRunes), false},
		{"too long", strings.Repeat("x", maxFocusRunes+1), "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := cleanFocus(tc.in)
			if tc.wantErr {
				assert.ErrorContains(t, err, "too long")
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

// pins the additive migration: a table created before focus existed gains the column, and re-running is a no-op
func TestAddColumnIfMissing(t *testing.T) {
	d, err := sql.Open("sqlite", ":memory:")
	require.NoError(t, err)
	d.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = d.Close() })
	_, err = d.Exec(`CREATE TABLE review_runs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL)`)
	require.NoError(t, err)
	_, err = d.Exec(`INSERT INTO review_runs (kind) VALUES ('pr')`)
	require.NoError(t, err)

	require.NoError(t, addColumnIfMissing(d, "review_runs", "focus", "TEXT NOT NULL DEFAULT ''"))
	require.NoError(t, addColumnIfMissing(d, "review_runs", "focus", "TEXT NOT NULL DEFAULT ''"))
	var f string
	require.NoError(t, d.QueryRow(`SELECT focus FROM review_runs`).Scan(&f))
	assert.Equal(t, "", f)

	_ = d.Close()
	assert.Error(t, addColumnIfMissing(d, "review_runs", "x", "TEXT"))
}

func TestValidateReviewReq_FocusTooLong(t *testing.T) {
	_, err := validateReviewReq(reviewStartReq{Repo: "a/b", PR: 1, Focus: strings.Repeat("x", maxFocusRunes+1)})
	assert.ErrorContains(t, err, "too long")
}
