package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gofr.dev/pkg/gofr"
	gofrHTTP "gofr.dev/pkg/gofr/http"
	resp "gofr.dev/pkg/gofr/http/response"
)

// fakeTmux logs every call to $FAKE_TMUX_LOG, answers list-panes from
// $FAKE_TMUX_PANES and fails new-session/kill-session when $FAKE_TMUX_FAIL is set.
const fakeTmux = `#!/bin/sh
echo "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  list-panes) cat "$FAKE_TMUX_PANES" 2>/dev/null; exit 0 ;;
  capture-pane) printf 'pass 3\nStopped: 3 passes with no new passing task (1/3). Needs you.\n'; exit 0 ;;
  new-session|kill-session) [ -n "$FAKE_TMUX_FAIL" ] && { echo "tmux boom"; exit 1; }; exit 0 ;;
esac
exit 0
`

type loopEnv struct {
	home, repo, tmuxLog, panes string
}

func (e loopEnv) tmuxCalls(t *testing.T) string {
	t.Helper()
	b, _ := os.ReadFile(e.tmuxLog)
	return string(b)
}

func (e loopEnv) setPanes(t *testing.T, lines string) {
	t.Helper()
	writeLoopFile(t, e.panes, lines)
}

// newLoopEnv builds a fake HOME with a repo root (via ~/.rook/config.json), one
// loop "demo", the runner script, a fake tmux and a stubbed branch/process scan.
func newLoopEnv(t *testing.T, branch string) loopEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	loopRepoCacheMu.Lock()
	loopRepoCache = nil
	loopRepoCacheMu.Unlock()
	t.Cleanup(func() {
		loopRepoCacheMu.Lock()
		loopRepoCache = nil
		loopRepoCacheMu.Unlock()
	})

	e := loopEnv{home: home, repo: filepath.Join(home, "work", "proj"), tmuxLog: filepath.Join(home, "tmux.log"), panes: filepath.Join(home, "panes")}
	writeLoopFile(t, filepath.Join(home, ".rook", "config.json"), `{"repoRoots":["~/work"]}`)
	d := filepath.Join(e.repo, ".loop", "demo")
	writeLoopFile(t, filepath.Join(d, "spec.md"), "## Goal\nDemo goal.\n")
	writeLoopFile(t, filepath.Join(d, "tasks.json"), `[{"id":"T1","desc":"a","passes":true},{"id":"T2","desc":"b","passes":false}]`)
	writeLoopFile(t, filepath.Join(d, "runner.log"), "=== pass 1 ===\ndone\n")
	writeLoopFile(t, filepath.Join(home, ".claude", "skills", "loop-spec", "scripts", "loop-run.sh"), "#!/bin/bash\n")
	writeLoopFile(t, filepath.Join(home, ".claude", "state", "loops.jsonl"), `{"loop":"demo","repo":"`+e.repo+`","pass":1}`+"\n")

	bin := filepath.Join(home, "bin", "tmux")
	writeLoopFile(t, bin, fakeTmux)
	require.NoError(t, os.Chmod(bin, 0o755))
	t.Setenv("FAKE_TMUX_LOG", e.tmuxLog)
	t.Setenv("FAKE_TMUX_PANES", e.panes)
	origTmux, origExt := tmuxBin, externalLoopRunners
	tmuxBin = bin
	externalLoopRunners = func() map[string]bool { return map[string]bool{} }
	t.Cleanup(func() { tmuxBin, externalLoopRunners = origTmux, origExt })
	stubLoopBranch(t, branch)
	return e
}

func loopCtx(method, target, body string) *gofr.Context {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return &gofr.Context{Context: r.Context(), Request: gofrHTTP.NewRequest(r)}
}

func loopStatusOfErr(t *testing.T, err error) int {
	t.Helper()
	var he *httpErr
	require.True(t, errors.As(err, &he), "want an httpErr, got %v", err)
	return he.StatusCode()
}

func rawData(t *testing.T, v any) any {
	t.Helper()
	r, ok := v.(resp.Raw)
	require.True(t, ok, "want resp.Raw, got %T", v)
	return r.Data
}

func TestHandleLoops_ListsLoopFromRepoRoots(t *testing.T) {
	e := newLoopEnv(t, "feature/x")
	e.setPanes(t, "rook-loop-proj-demo\t1\t3\nother\t0\t0\n")

	out, err := handleLoops(loopCtx(http.MethodGet, "/api/loops", ""))
	require.NoError(t, err)
	r := rawData(t, out).(loopsResp)
	assert.True(t, r.RunnerInstalled)
	assert.True(t, r.TmuxAvailable)
	require.Len(t, r.Loops, 1)
	l := r.Loops[0]
	assert.Equal(t, e.repo, l.Repo)
	assert.Equal(t, "demo", l.Name)
	assert.Equal(t, "Demo goal.", l.Goal)
	assert.Equal(t, 1, l.Passing)
	assert.Equal(t, 2, l.Total)
	assert.True(t, l.Exited)
	assert.Equal(t, 3, l.ExitCode)
	assert.Equal(t, "needs-you", l.Status)
	assert.Contains(t, l.RunnerOutput, "Needs you")
	require.Len(t, r.Recent, 1)
	assert.Equal(t, "demo", r.Recent[0].Loop)
}

func TestHandleLoopStart(t *testing.T) {
	tests := []struct {
		name     string
		branch   string
		body     string
		setup    func(t *testing.T, e loopEnv)
		wantCode int
		wantMsg  string
	}{
		{name: "starts in a detached tmux session", branch: "feature/x", body: `{"repo":"REPO","name":"demo"}`},
		{name: "bad json", branch: "feature/x", body: `{`, wantCode: http.StatusBadRequest},
		{name: "unknown loop", branch: "feature/x", body: `{"repo":"REPO","name":"ghost"}`, wantCode: http.StatusNotFound},
		{name: "path-ish name", branch: "feature/x", body: `{"repo":"REPO","name":"../x"}`, wantCode: http.StatusNotFound},
		{name: "protected branch", branch: "main", body: `{"repo":"REPO","name":"demo"}`, wantCode: http.StatusConflict, wantMsg: "refusing to loop on main"},
		{name: "already running", branch: "feature/x", body: `{"repo":"REPO","name":"demo"}`,
			setup: func(t *testing.T, e loopEnv) { e.setPanes(t, "rook-loop-proj-demo\t0\t0\n") }, wantCode: http.StatusConflict, wantMsg: "already running"},
		{name: "runner script missing", branch: "feature/x", body: `{"repo":"REPO","name":"demo"}`,
			setup: func(t *testing.T, e loopEnv) {
				require.NoError(t, os.Remove(filepath.Join(e.home, ".claude", "skills", "loop-spec", "scripts", "loop-run.sh")))
			}, wantCode: http.StatusPreconditionFailed},
		{name: "tmux fails", branch: "feature/x", body: `{"repo":"REPO","name":"demo"}`,
			setup: func(t *testing.T, _ loopEnv) { t.Setenv("FAKE_TMUX_FAIL", "1") }, wantCode: http.StatusConflict, wantMsg: "tmux boom"},
		{name: "no tmux", branch: "feature/x", body: `{"repo":"REPO","name":"demo"}`,
			setup: func(t *testing.T, _ loopEnv) { tmuxBin = "" }, wantCode: http.StatusServiceUnavailable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newLoopEnv(t, tc.branch)
			if tc.setup != nil {
				tc.setup(t, e)
			}
			out, err := handleLoopStart(loopCtx(http.MethodPost, "/api/loops/start", strings.ReplaceAll(tc.body, "REPO", e.repo)))
			if tc.wantCode != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.wantCode, loopStatusOfErr(t, err))
				if tc.wantMsg != "" {
					assert.Contains(t, err.Error(), tc.wantMsg)
				}
				if tc.wantMsg != "tmux boom" {
					assert.NotContains(t, e.tmuxCalls(t), "new-session -d", "no runner started on refusal")
				}
				return
			}
			require.NoError(t, err)
			m := rawData(t, out).(map[string]any)
			assert.Equal(t, "rook-loop-proj-demo", m["session"])
			calls := e.tmuxCalls(t)
			script := filepath.Join(e.home, ".claude", "skills", "loop-spec", "scripts", "loop-run.sh")
			assert.Contains(t, calls, "new-session -d -s rook-loop-proj-demo -x 200 -y 50 -c "+e.repo+" bash '"+script+"' 'demo'")
			assert.Contains(t, calls, "remain-on-exit on")
			assert.Contains(t, calls, "kill-session -t =rook-loop-proj-demo", "a finished runner's pane is cleared first")
		})
	}
}

func TestHandleLoopStop(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		panes    string
		fail     bool
		noTmux   bool
		wantCode int
	}{
		{name: "kills the rook session", body: `{"repo":"REPO","name":"demo"}`, panes: "rook-loop-proj-demo\t0\t0\n"},
		{name: "no rook session", body: `{"repo":"REPO","name":"demo"}`, wantCode: http.StatusNotFound},
		{name: "bad name", body: `{"repo":"REPO","name":"a b"}`, wantCode: http.StatusBadRequest},
		{name: "missing repo", body: `{"name":"demo"}`, wantCode: http.StatusBadRequest},
		{name: "kill fails", body: `{"repo":"REPO","name":"demo"}`, panes: "rook-loop-proj-demo\t0\t0\n", fail: true, wantCode: http.StatusInternalServerError},
		{name: "no tmux", body: `{"repo":"REPO","name":"demo"}`, noTmux: true, wantCode: http.StatusServiceUnavailable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newLoopEnv(t, "feature/x")
			e.setPanes(t, tc.panes)
			if tc.fail {
				t.Setenv("FAKE_TMUX_FAIL", "1")
			}
			if tc.noTmux {
				tmuxBin = ""
			}
			out, err := handleLoopStop(loopCtx(http.MethodPost, "/api/loops/stop", strings.ReplaceAll(tc.body, "REPO", e.repo)))
			if tc.wantCode != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.wantCode, loopStatusOfErr(t, err))
				return
			}
			require.NoError(t, err)
			assert.Equal(t, "rook-loop-proj-demo", rawData(t, out).(map[string]any)["session"])
			assert.Contains(t, e.tmuxCalls(t), "kill-session -t =rook-loop-proj-demo")
		})
	}
}

func TestHandleLoopLog(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		setup      func(t *testing.T, e loopEnv)
		wantCode   int
		wantLog    string
		wantExists bool
	}{
		{name: "tail of runner.log", query: "name=demo", wantLog: "=== pass 1 ===\ndone", wantExists: true},
		{name: "no runner.log yet", query: "name=demo", wantExists: false,
			setup: func(t *testing.T, e loopEnv) {
				require.NoError(t, os.Remove(filepath.Join(e.repo, ".loop", "demo", "runner.log")))
			}},
		{name: "unreadable runner.log", query: "name=demo", wantCode: http.StatusInternalServerError,
			setup: func(t *testing.T, e loopEnv) {
				p := filepath.Join(e.repo, ".loop", "demo", "runner.log")
				require.NoError(t, os.Remove(p))
				require.NoError(t, os.Mkdir(p, 0o755)) // a directory can be opened but not read
			}},
		{name: "unknown loop", query: "name=ghost", wantCode: http.StatusNotFound},
		{name: "path traversal name", query: "name=..", wantCode: http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newLoopEnv(t, "feature/x")
			if tc.setup != nil {
				tc.setup(t, e)
			}
			out, err := handleLoopLog(loopCtx(http.MethodGet, "/api/loops/log?repo="+e.repo+"&"+tc.query, ""))
			if tc.wantCode != 0 {
				require.Error(t, err)
				assert.Equal(t, tc.wantCode, loopStatusOfErr(t, err))
				return
			}
			require.NoError(t, err)
			m := rawData(t, out).(map[string]any)
			assert.Equal(t, tc.wantLog, m["log"])
			assert.Equal(t, tc.wantExists, m["exists"])
		})
	}
}

func TestDiscoveredRepoPaths_Caches(t *testing.T) {
	e := newLoopEnv(t, "feature/x")
	repo := filepath.Join(e.home, "repos", "r1")
	require.NoError(t, os.MkdirAll(filepath.Join(repo, ".git"), 0o755))
	first := discoveredRepoPaths()
	assert.Contains(t, first, repo)
	// a repo added after the first scan is not seen until the cache expires
	repo2 := filepath.Join(e.home, "repos", "r2")
	require.NoError(t, os.MkdirAll(filepath.Join(repo2, ".git"), 0o755))
	assert.NotContains(t, discoveredRepoPaths(), repo2)
}

func TestLoopCandidateRepos_SkipsBadRoots(t *testing.T) {
	got := loopCandidateRepos(nil, []string{"", "  ", filepath.Join(t.TempDir(), "missing")}, []loopPass{{Repo: ""}})
	assert.Len(t, got, 1, "a missing root is still listed itself but has no children")
}

func TestNeedsUserNote(t *testing.T) {
	tests := []struct{ in, want string }{
		{``, ""},
		{`null`, ""},
		{`false`, ""},
		{`true`, "yes"},
		{`"  pick one "`, "pick one"},
		{`3`, "3"},
		{`{"why":"x"}`, `{"why":"x"}`},
	}
	for _, tc := range tests {
		assert.Equal(t, tc.want, needsUserNote([]byte(tc.in)), tc.in)
	}
}

func TestTailFile_LargeFileDropsPartialLine(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big")
	line := strings.Repeat("x", 99) + "\n" // 100 bytes per line
	writeLoopFile(t, p, "HEAD\n"+strings.Repeat(line, (loopTailBytes/100)+50)+"LAST\n")
	got, err := tailFile(p, 3)
	require.NoError(t, err)
	assert.Equal(t, strings.TrimSuffix(line, "\n")+"\n"+strings.TrimSuffix(line, "\n")+"\nLAST", got)

	all, err := tailFile(p, 1<<20)
	require.NoError(t, err)
	assert.NotContains(t, all, "HEAD", "reads only the last loopTailBytes")
	assert.True(t, strings.HasPrefix(all, strings.Repeat("x", 99)), "partial first line dropped")
}

func TestLoopPaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	assert.Equal(t, filepath.Join(home, ".claude", "state", "loops.jsonl"), globalLoopMetricsPath())
	assert.Equal(t, filepath.Join(home, ".claude", "skills", "loop-spec", "scripts", "loop-run.sh"), loopRunnerScript())
}

func TestFindKnownLoop_RejectsBadInput(t *testing.T) {
	e := newLoopEnv(t, "feature/x")
	_, ok := findKnownLoop("", "demo")
	assert.False(t, ok)
	_, ok = findKnownLoop(e.repo, "../demo")
	assert.False(t, ok)
	ref, ok := findKnownLoop(e.repo+"/", "demo")
	assert.True(t, ok, "trailing slash is cleaned")
	assert.Equal(t, e.repo, ref.Repo)
}

// TestExternalLoopRunners_FindsTerminalRunner runs a real process named like
// the runner inside a git repo and checks it is attributed to that repo.
func TestExternalLoopRunners_FindsTerminalRunner(t *testing.T) {
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("lsof not available")
	}
	repo := gitInitRepo(t)
	sub := filepath.Join(repo, "pkg")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	script := filepath.Join(t.TempDir(), "loop-run.sh")
	writeLoopFile(t, script, "#!/bin/bash\nsleep 30\n")
	cmd := exec.Command("bash", script, "extdemo")
	cmd.Dir = sub
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	top := gitToplevel(repo)
	var got map[string]bool
	for i := 0; i < 20; i++ {
		got = externalLoopRunners()
		if got[top+"\x00extdemo"] {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	assert.True(t, got[top+"\x00extdemo"], "runner in %s not found in %v", top, got)

	li := loopInfo{Repo: repo, Name: "extdemo"}
	applyRunnerState(&li, nil, got)
	assert.Equal(t, "external", li.Runner, "temp-dir symlinks resolve to the same repo")
}

func TestProcCwd(t *testing.T) {
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("lsof not available")
	}
	wd, err := os.Getwd()
	require.NoError(t, err)
	real, _ := filepath.EvalSymlinks(wd)
	got := procCwd(os.Getpid())
	gotReal, _ := filepath.EvalSymlinks(got)
	assert.Equal(t, real, gotReal)
	assert.Equal(t, "", procCwd(999999999))
}

func TestParseLsofCwd(t *testing.T) {
	tests := []struct{ in, want string }{
		{"p123\nfcwd\nn/Users/me/repo\n", "/Users/me/repo"},
		{"p123\nfcwd\n", ""},
		{"", ""},
		{"lsof: no such pid", ""},
	}
	for _, tc := range tests {
		assert.Equal(t, tc.want, parseLsofCwd(tc.in), tc.in)
	}
}

func TestPaneTail(t *testing.T) {
	assert.Equal(t, "b\nStopped: x\nPane is dead (status 3)", paneTail("a\nb\n\n\nStopped: x   \n\n\nPane is dead (status 3)\n\n", 3))
	assert.Equal(t, "", paneTail("\n \n", 5))
}
