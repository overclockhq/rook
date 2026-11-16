package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeLoopFile(t *testing.T, path, body string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(body), 0o644))
}

func TestParseLoopGoal(t *testing.T) {
	tests := []struct {
		name, spec, want string
	}{
		{"first paragraph only", "# Loop\n\n## Goal\n\nShip the rules\nfor AWS.\n\nSecond para.\n## Acceptance\n- x", "Ship the rules for AWS."},
		{"stops at next heading", "## Goal\nOne line\n## Do not\nstuff", "One line"},
		{"case-insensitive heading", "## goal\n\nlower", "lower"},
		{"subheading is not the goal", "### Goal\nnope\n## Other\nx", ""},
		{"no goal section", "# Title\n\nbody", ""},
		{"empty goal then heading", "## Goal\n\n## Next\ntext", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, parseLoopGoal(tc.spec))
		})
	}
}

func TestParseLoopTasks(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []loopTask
		wantErr bool
	}{
		{"basic", `[{"id":"T1","desc":"a","passes":true,"attempts":2},{"id":"T2","desc":"b","passes":false}]`,
			[]loopTask{{ID: "T1", Desc: "a", Passes: true, Attempts: 2}, {ID: "T2", Desc: "b"}}, false},
		{"needs_user bool and note", `[{"id":"T1","needs_user":true},{"id":"T2","needs_user":"pick a db"},{"id":"T3","needs_user":false}]`,
			[]loopTask{{ID: "T1", NeedsUser: "yes"}, {ID: "T2", NeedsUser: "pick a db"}, {ID: "T3"}}, false},
		{"numeric id", `[{"id":7}]`, []loopTask{{ID: "7"}}, false},
		{"corrupt", `[{"id":`, nil, true},
		{"not an array", `{"id":"T1"}`, nil, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseLoopTasks([]byte(tc.in))
			if tc.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestComputeLoopMetrics(t *testing.T) {
	ps := []loopPass{
		// T1 passes on its first pass
		{Task: "T1", PassingBefore: 0, PassingAfter: 1, Seconds: 120, CostUSD: 0.5, At: "a"},
		// T2 fails first (wasted, error, 2 denials), then passes
		{Task: "T2", PassingBefore: 1, PassingAfter: 1, Seconds: 60, CostUSD: 0.25, ExitCode: 1, PermissionDenials: 2, At: "b"},
		{Task: "T2", PassingBefore: 1, PassingAfter: 2, Seconds: 60, CostUSD: 0.254, At: "c"},
		// a pass that touched no task: wasted, counted as an error via is_error
		{Task: "", PassingBefore: 2, PassingAfter: 2, Seconds: 0, IsError: true, At: "d"},
	}
	m := computeLoopMetrics(ps)
	assert.Equal(t, 4, m.Passes)
	assert.Equal(t, 2, m.TasksPassed)
	assert.Equal(t, 2, m.Wasted)
	assert.Equal(t, 1, m.FirstTry)
	assert.Equal(t, 2, m.Tried)
	assert.InDelta(t, 0.5, m.FirstTryRate, 1e-9)
	assert.Equal(t, 2, m.Errors)
	assert.Equal(t, 2, m.Denials)
	assert.InDelta(t, 4.0, m.Minutes, 1e-9)
	assert.InDelta(t, 1.0, m.CostUSD, 1e-9)
	assert.Equal(t, "d", m.LastPassAt)

	assert.Equal(t, loopMetrics{}, computeLoopMetrics(nil))
}

func TestParseLoopPasses_SkipsCorrupt(t *testing.T) {
	in := `{"loop":"a","pass":1}` + "\n\nnot json\n" + `{"loop":"a","pass":2,"turns":null,"cost_usd":null}` + "\n"
	ps, bad := parseLoopPasses(strings.NewReader(in))
	assert.Equal(t, 1, bad)
	require.Len(t, ps, 2)
	assert.Equal(t, 2, ps[1].Pass)
}

func TestLastLinesAndTailFile(t *testing.T) {
	assert.Equal(t, "c\nd", lastLines("a\nb\nc\nd\n", 2, false))
	assert.Equal(t, "b\nc", lastLines("partial\nb\nc", 5, true))

	p := filepath.Join(t.TempDir(), "log")
	var sb strings.Builder
	for i := 1; i <= 300; i++ {
		fmt.Fprintf(&sb, "line %d\n", i)
	}
	writeLoopFile(t, p, sb.String())
	got, err := tailFile(p, 200)
	require.NoError(t, err)
	lines := strings.Split(got, "\n")
	assert.Len(t, lines, 200)
	assert.Equal(t, "line 101", lines[0])
	assert.Equal(t, "line 300", lines[199])

	_, err = tailFile(filepath.Join(t.TempDir(), "missing"), 5)
	assert.True(t, os.IsNotExist(err))
}

func TestLoopSessionName(t *testing.T) {
	tests := []struct{ repo, name, want string }{
		{"/x/rook", "demo", "rook-loop-rook-demo"},
		{"/x/my.repo", "v1.2", "rook-loop-my-repo-v1-2"},
		{"/x/a b:c", "n", "rook-loop-a-b-c-n"},
	}
	for _, tc := range tests {
		got := loopSessionName(tc.repo, tc.name)
		assert.Equal(t, tc.want, got)
		assert.NotContains(t, got, ".")
		assert.NotContains(t, got, ":")
	}
}

func TestParseRunnerProc(t *testing.T) {
	tests := []struct {
		ln      string
		pid     int
		name    string
		matched bool
	}{
		{"  4242 bash /Users/me/.claude/skills/loop-spec/scripts/loop-run.sh demo", 4242, "demo", true},
		{"17 /bin/bash loop-run.sh rules-aws", 17, "rules-aws", true},
		{"99 vim loop-run.sh", 0, "", false},
		{"12 bash other.sh demo", 0, "", false},
		{"x bash loop-run.sh demo", 0, "", false},
	}
	for _, tc := range tests {
		pid, name, ok := parseRunnerProc(tc.ln)
		assert.Equal(t, tc.matched, ok, tc.ln)
		assert.Equal(t, tc.pid, pid, tc.ln)
		assert.Equal(t, tc.name, name, tc.ln)
	}
}

func TestShellQuoteAndLaunchCmd(t *testing.T) {
	assert.Equal(t, `'a'\''b'`, shellQuote("a'b"))
	assert.Equal(t, `bash '/h/My Docs/loop-run.sh' 'demo'`, loopLaunchCmd("/h/My Docs/loop-run.sh", "demo"))
}

func TestProtectedLoopBranch(t *testing.T) {
	for _, b := range []string{"", "main", "master", "development", "develop"} {
		assert.True(t, protectedLoopBranch(b), b)
	}
	for _, b := range []string{"feature/issue-1", "fix/x", "mainline"} {
		assert.False(t, protectedLoopBranch(b), b)
	}
}

func TestLoopCandidateReposAndFindLoopDirs(t *testing.T) {
	root := t.TempDir()
	repoA := filepath.Join(root, "a")
	repoB := filepath.Join(root, "b")
	repoC := filepath.Join(t.TempDir(), "c") // only known via the metrics log
	writeLoopFile(t, filepath.Join(repoA, ".loop", "one", "tasks.json"), "[]")
	writeLoopFile(t, filepath.Join(repoA, ".loop", "two", "tasks.json"), "[]")
	writeLoopFile(t, filepath.Join(repoA, ".loop", "stray.txt"), "x") // files are not loops
	require.NoError(t, os.MkdirAll(filepath.Join(repoB, "src"), 0o755))
	writeLoopFile(t, filepath.Join(repoC, ".loop", "z", "tasks.json"), "[]")

	cands := loopCandidateRepos([]string{repoA}, []string{root}, []loopPass{{Repo: repoC}, {Repo: repoA}})
	assert.Contains(t, cands, repoA)
	assert.Contains(t, cands, repoB)
	assert.Contains(t, cands, repoC)
	n := 0
	for _, c := range cands {
		if c == repoA {
			n++
		}
	}
	assert.Equal(t, 1, n, "repo listed once")

	refs := findLoopDirs(append(cands, repoA+string(filepath.Separator)))
	assert.Equal(t, []loopRef{{repoA, "one"}, {repoA, "two"}, {repoC, "z"}}, refs)
}

func TestExpandHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	assert.Equal(t, filepath.Join(home, "x"), expandHome("~/x"))
	assert.Equal(t, "/abs", expandHome("/abs"))
}

func TestRookRepoRoots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	assert.Nil(t, rookRepoRoots())
	writeLoopFile(t, filepath.Join(home, ".rook", "config.json"), `{"repoRoots":["~/code","/srv"]}`)
	assert.Equal(t, []string{"~/code", "/srv"}, rookRepoRoots())
	writeLoopFile(t, filepath.Join(home, ".rook", "config.json"), `{bad`)
	assert.Nil(t, rookRepoRoots())
}

func stubLoopBranch(t *testing.T, b string) {
	t.Helper()
	orig := loopBranch
	loopBranch = func(string) string { return b }
	t.Cleanup(func() { loopBranch = orig })
}

func TestReadLoop(t *testing.T) {
	stubLoopBranch(t, "feature/x")
	repo := t.TempDir()
	d := filepath.Join(repo, ".loop", "demo")
	writeLoopFile(t, filepath.Join(d, "spec.md"), "# demo\n\n## Goal\nMake all three pass.\n\n## Acceptance\n- gate\n")
	writeLoopFile(t, filepath.Join(d, "tasks.json"), `[{"id":"T1","desc":"a","passes":true,"attempts":1},{"id":"T2","desc":"b","passes":false,"attempts":3,"needs_user":"decide schema"},{"id":"T3","desc":"c","passes":false,"attempts":0}]`)
	writeLoopFile(t, filepath.Join(d, "budget.json"), `{"max_iters":20}`)
	writeLoopFile(t, filepath.Join(d, "progress.md"), "p1\np2\n")
	writeLoopFile(t, filepath.Join(d, "metrics.jsonl"), `{"task":"T1","passing_before":0,"passing_after":1,"seconds":60}`+"\ngarbage\n")

	li := readLoop(loopRef{Repo: repo, Name: "demo"})
	assert.Equal(t, "Make all three pass.", li.Goal)
	assert.Equal(t, "feature/x", li.Branch)
	assert.False(t, li.ProtectedBranch)
	assert.Equal(t, 1, li.Passing)
	assert.Equal(t, 3, li.Total)
	assert.Equal(t, 1, li.NeedsUser)
	assert.JSONEq(t, `{"max_iters":20}`, string(li.Budget))
	assert.Equal(t, "p1\np2", li.ProgressTail)
	assert.Equal(t, 1, li.Metrics.Passes)
	assert.Contains(t, li.Error, "1 corrupt line")
	assert.Positive(t, li.LastActivity)
	assert.Equal(t, filepath.Base(repo), li.RepoName)
}

func TestReadLoop_MissingAndCorruptFiles(t *testing.T) {
	stubLoopBranch(t, "main")
	repo := t.TempDir()
	d := filepath.Join(repo, ".loop", "broken")
	writeLoopFile(t, filepath.Join(d, "tasks.json"), `{not json`)
	writeLoopFile(t, filepath.Join(d, "budget.json"), `{nope`)

	li := readLoop(loopRef{Repo: repo, Name: "broken"})
	assert.Contains(t, li.Error, "spec.md missing")
	assert.Contains(t, li.Error, "tasks.json")
	assert.Contains(t, li.Error, "budget.json")
	assert.Empty(t, li.Tasks)
	assert.NotNil(t, li.Tasks, "tasks serialises as [] not null")
	assert.True(t, li.ProtectedBranch)
}

func TestApplyRunnerState(t *testing.T) {
	base := loopInfo{Repo: "/r", Name: "n", Session: "rook-loop-r-n"}
	tests := []struct {
		name       string
		li         loopInfo
		panes      map[string]runnerPane
		external   map[string]bool
		wantStatus string
		wantRunner string
		wantExited bool
	}{
		{"rook runner alive", base, map[string]runnerPane{"rook-loop-r-n": {}}, nil, "running", "rook", false},
		{"external runner", base, nil, map[string]bool{"/r\x00n": true}, "running", "external", false},
		{"rook runner exited with stall code", base, map[string]runnerPane{"rook-loop-r-n": {Dead: true, Status: 3}}, nil, "needs-you", "", true},
		{"all passing", func() loopInfo { l := base; l.Passing, l.Total = 2, 2; return l }(), nil, nil, "done", "", false},
		{"needs user task", func() loopInfo { l := base; l.Total, l.NeedsUser = 2, 1; return l }(), nil, nil, "needs-you", "", false},
		{"idle", func() loopInfo { l := base; l.Total = 2; return l }(), nil, nil, "idle", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			li := tc.li
			applyRunnerState(&li, tc.panes, tc.external)
			assert.Equal(t, tc.wantStatus, li.Status)
			assert.Equal(t, tc.wantRunner, li.Runner)
			assert.Equal(t, tc.wantExited, li.Exited)
		})
	}
}

func TestCheckLoopStart(t *testing.T) {
	repo := t.TempDir()
	writeLoopFile(t, filepath.Join(repo, ".loop", "demo", "tasks.json"), "[]")
	sess := loopSessionName(repo, "demo")
	tests := []struct {
		name     string
		loop     string
		branch   string
		panes    map[string]runnerPane
		external map[string]bool
		wantCode int
		wantMsg  string
	}{
		{"ok on feature branch", "demo", "feature/x", nil, nil, 0, ""},
		{"exited runner does not block", "demo", "feature/x", map[string]runnerPane{sess: {Dead: true}}, nil, 0, ""},
		{"no tasks.json", "ghost", "feature/x", nil, nil, http.StatusBadRequest, "no tasks.json"},
		{"main refused", "demo", "main", nil, nil, http.StatusConflict, "refusing to loop on main"},
		{"develop refused", "demo", "develop", nil, nil, http.StatusConflict, "develop"},
		{"detached refused", "demo", "", nil, nil, http.StatusConflict, "detached HEAD"},
		{"rook runner alive", "demo", "fix/y", map[string]runnerPane{sess: {}}, nil, http.StatusConflict, "already running (rook)"},
		{"external runner alive", "demo", "fix/y", nil, map[string]bool{repo + "\x00demo": true}, http.StatusConflict, "already running (external)"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stubLoopBranch(t, tc.branch)
			code, err := checkLoopStart(loopRef{Repo: repo, Name: tc.loop}, tc.panes, tc.external)
			assert.Equal(t, tc.wantCode, code)
			if tc.wantMsg == "" {
				assert.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantMsg)
		})
	}
}

func TestReadRecentLoopPasses(t *testing.T) {
	p := filepath.Join(t.TempDir(), "loops.jsonl")
	var sb strings.Builder
	for i := 1; i <= 60; i++ {
		fmt.Fprintf(&sb, `{"loop":"l","pass":%d}`+"\n", i)
	}
	writeLoopFile(t, p, sb.String())
	got := readRecentLoopPasses(p, 50)
	require.Len(t, got, 50)
	assert.Equal(t, 60, got[0].Pass, "newest first")
	assert.Equal(t, 11, got[49].Pass)

	empty := readRecentLoopPasses(filepath.Join(t.TempDir(), "none"), 50)
	assert.NotNil(t, empty)
	assert.Empty(t, empty)
}
