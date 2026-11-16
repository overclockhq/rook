package main

import (
	"encoding/json"
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

// grEnv points every guardrails input at a temp home so no test reads the real
// ~/.claude, runs the real gate, or asks the real launchd.
type grEnv struct {
	home, claude string
	repos        []repoInfo
}

func newGrEnv(t *testing.T) *grEnv {
	t.Helper()
	home := t.TempDir()
	claude := filepath.Join(home, ".claude")
	require.NoError(t, os.MkdirAll(claude, 0o755))
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", claude)
	e := &grEnv{home: home, claude: claude}

	oldRepos, oldGate, oldSelf, oldLaunch, oldTimeout := guardrailRepoList, gateScriptPath, selftestScripts, launchctlList, selftestTimeout
	guardrailRepoList = func() []repoInfo { return e.repos }
	gateScriptPath = func() string { return filepath.Join(home, "gate.sh") }
	selftestScripts = func() []string { return nil }
	launchctlList = func() (string, error) { return "", nil }
	t.Cleanup(func() {
		guardrailRepoList, gateScriptPath, selftestScripts, launchctlList, selftestTimeout = oldRepos, oldGate, oldSelf, oldLaunch, oldTimeout
		gateMu.Lock()
		gateRuns = map[string]*gateRun{}
		gateMu.Unlock()
	})
	return e
}

func grWrite(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(body), mode))
}

// addGoRepo makes a real git repo with a go.mod and registers it as discovered.
func (e *grEnv) addGoRepo(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(e.home, "src", name)
	grWrite(t, filepath.Join(dir, "go.mod"), "module x\n", 0o644)
	out, err := exec.Command("git", "-C", dir, "init", "-q", "-b", "main").CombinedOutput()
	require.NoError(t, err, string(out))
	e.repos = append(e.repos, repoInfo{Path: dir, Name: name})
	return dir
}

func jsonCtx(t *testing.T, method, target, ctype, body string) *gofr.Context {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	return &gofr.Context{Context: req.Context(), Request: gofrHTTP.NewRequest(req)}
}

func rawOf(t *testing.T, v any) map[string]any {
	t.Helper()
	r, ok := v.(resp.Raw)
	require.True(t, ok, "want resp.Raw, got %T", v)
	b, err := json.Marshal(r.Data)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(b, &m))
	return m
}

func statusOfErr(err error) int {
	if he, ok := err.(*httpErr); ok {
		return he.code
	}
	return 0
}

func TestResolveHookScript(t *testing.T) {
	home, _ := os.UserHomeDir()
	cases := []struct {
		name, cmd, project string
		script             string
		via                bool
	}{
		{"home var", "$HOME/.claude/hooks/guard.sh", "", home + "/.claude/hooks/guard.sh", false},
		{"braced home", "${HOME}/x.sh arg", "", home + "/x.sh", false},
		{"tilde", "~/h.sh", "", home + "/h.sh", false},
		{"interpreter", "bash /opt/h.sh --flag", "", "/opt/h.sh", true},
		{"env assignment then interp", "FOO=1 python3 -u /a/b.py", "", "/a/b.py", true},
		{"project dir", `"$CLAUDE_PROJECT_DIR"/.claude/h.sh`, "/repo", "/repo/.claude/h.sh", false},
		{"inline command", "jq -r .x", "", "", false},
		{"empty", "", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, via := resolveHookScript(c.cmd, c.project)
			assert.Equal(t, c.script, s)
			assert.Equal(t, c.via, via)
		})
	}
}

func TestScriptPurposeAndHealth(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name, body string
		mode       os.FileMode
		via        bool
		purpose    string
		health     string
	}{
		{"shebang then comment", "#!/bin/bash\n# Guard: blocks bad things.\n# more\necho hi\n", 0o755, false, "Guard: blocks bad things.", "ok"},
		{"blank comment lines skipped", "#!/bin/sh\n#\n#   Notify me\n", 0o755, false, "Notify me", "ok"},
		{"no comment", "#!/bin/sh\necho hi\n# late\n", 0o755, false, "", "ok"},
		{"not executable", "# x\n", 0o644, false, "x", "not-executable"},
		{"not executable via interpreter", "# y\n", 0o644, true, "y", "ok"},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := filepath.Join(dir, c.name+string(rune('a'+i))+".sh")
			grWrite(t, p, c.body, c.mode)
			assert.Equal(t, c.purpose, scriptPurpose(p))
			_, _, h := fileHealth(p, c.via)
			assert.Equal(t, c.health, h)
		})
	}
	_, _, h := fileHealth(filepath.Join(dir, "nope.sh"), false)
	assert.Equal(t, "missing", h)
	_, _, h = fileHealth("", false)
	assert.Equal(t, "inline", h)
}

func TestMatchersOverlap(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"*", "Bash", true},
		{"", "Edit|Write", true},
		{"Bash", "Bash", true},
		{"Bash", "Edit|Write", false},
		{"Read|Edit", "Write|Edit", true},
		{"mcp__.*", "Bash", false},
		{"Bash", "mcp__.*", false},
		{"mcp__.*", "mcp__github", true},
		{"Ba.*", "Bash|Edit", true},
		{"a.*", "b.*", true}, // two regexes: cannot rule it out
	}
	for _, c := range cases {
		assert.Equal(t, c.want, matchersOverlap(c.a, c.b), "%q vs %q", c.a, c.b)
	}
}

func TestFindConflicts(t *testing.T) {
	rookCmd := "/h/.rook/hooks/" + hookMarker
	hooks := []grHook{
		{Event: "PreToolUse", Matcher: "Bash", Command: "guard.sh"},
		{Event: "PreToolUse", Matcher: "mcp__.*", Command: "guard.sh"},
		{Event: "PreToolUse", Matcher: "*", Command: rookCmd, Rook: true},
		{Event: "Stop", Command: "stop-gate.sh"},
		{Event: "Stop", Command: rookCmd, Rook: true},
		{Event: "SubagentStop", Command: rookCmd, Rook: true}, // no user hook: no conflict
		{Event: "PostToolUse", Matcher: "Bash", Command: "track.sh"},
	}
	got := findConflicts(hooks, grRook{Gate: true, AutoVerify: true})
	require.Len(t, got, 2)
	assert.Equal(t, "PreToolUse", got[0].Event)
	assert.Equal(t, "warn", got[0].Severity)
	assert.Equal(t, []string{"Bash", "mcp__.*"}, got[0].UserMatchers)
	assert.Contains(t, got[0].Note, "rook gate is on")
	assert.Equal(t, "Stop", got[1].Event)
	assert.Equal(t, "warn", got[1].Severity)

	quiet := findConflicts(hooks, grRook{})
	assert.Equal(t, "info", quiet[1].Severity, "Stop overlap is informational when rook's auto-verify/review are off")

	// A user hook on a matcher rook's entry does not cover is not a conflict.
	none := findConflicts([]grHook{
		{Event: "PreToolUse", Matcher: "Edit", Command: "a.sh"},
		{Event: "PreToolUse", Matcher: "Bash", Command: rookCmd, Rook: true},
	}, grRook{})
	assert.Empty(t, none)
}

func TestCredentialKind(t *testing.T) {
	cases := []struct {
		in   string
		kind string
	}{
		{"Bash(aws s3 ls --profile AKIAIOSFODNN7EXAMPLE)", "AWS access key"},
		{"Bash(gh api -H 'x' ghp_abcdefghijklmnopqrstuvwxyz0123456789)", "GitHub token"},
		{"Bash(curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123')", "bearer token"},
		{"Bash(export API_KEY=hunter22secret)", "inline secret"},
		{"Bash(echo xoxb-1234567890-abcdef)", "Slack token"},
		{"Bash(echo Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O)", "high-entropy string"},
		{"Bash(go test ./...)", ""},
		{"mcp__claude_ai_Google_Drive__download_file_content", ""},
		{"Bash(git show 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39)", ""},
		{"Read(//Users/me/.project-secrets/**)", ""},
		{"Bash(gofmt -l .)", ""},
		{"Bash(AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' aws s3 ls)", "inline secret"},
		{"Bash(TOKEN=$GITHUB_TOKEN gh api)", ""},
		{"Bash(curl https://hooks.example.com/services/T00000000/B00000000/9fXk2LmQ7rT4vZpA8sWd3Ny1)", "high-entropy string"},
		{"Bash(ls /Users/me/.claude/projects/-Users-me-Desktop-github-Claude-claude-zopnight-123/x)", ""},
		{"Bash(ARM_CLIENT_ID=3f2a9c1e-8b7d-4a5f-9e3d-2c1b0a9f8e7d terraform plan)", ""},
		{"Bash(go test -run TestS3BucketLifecycleHandler_DeleteExpired ./...)", ""},
	}
	for _, c := range cases {
		assert.Equal(t, c.kind, credentialKind(c.in), c.in)
	}
}

func TestPermSetFromLocalHidesEntries(t *testing.T) {
	var s claudeSettings
	s.Permissions.Allow = []string{"Bash(ls)", "Bash(curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123')"}
	s.Permissions.Deny = []string{"Bash(rm -rf /)"}

	local := permSetFrom(s, "global-local", "", "/x/settings.local.json", true)
	assert.Nil(t, local.Allow)
	assert.Nil(t, local.Deny)
	assert.Equal(t, 2, local.AllowN)
	assert.Equal(t, 1, local.DenyN)
	require.Len(t, local.Flags, 1)
	assert.Equal(t, "allow entry 2 looks like a credential (bearer token)", local.Flags[0].Message)
	b, _ := json.Marshal(local)
	assert.NotContains(t, string(b), "abcdefghijklmnop", "the secret text must never be returned")

	shared := permSetFrom(s, "global", "", "/x/settings.json", false)
	assert.Equal(t, s.Permissions.Allow, shared.Allow)
}

func TestParseSelftest(t *testing.T) {
	pass, fail, failing, sum := parseSelftest("FAIL want=deny got=allow :: x\nnoise\nguard: 40 passed, 1 failed\n")
	assert.Equal(t, 40, pass)
	assert.Equal(t, 1, fail)
	assert.Equal(t, []string{"FAIL want=deny got=allow :: x"}, failing)
	assert.Equal(t, "guard: 40 passed, 1 failed", sum)

	pass, fail, _, sum = parseSelftest("ok\nok one\nFAIL two\n")
	assert.Equal(t, 2, pass)
	assert.Equal(t, 1, fail)
	assert.Empty(t, sum)
}

func TestValidBriefDate(t *testing.T) {
	for d, ok := range map[string]bool{
		"2026-11-16": true, "2026-02-30": false, "2026-1-16": false, "../etc/passwd": false,
		"2026-11-16.md": false, "": false, "2026-11-16/../x": false,
	} {
		assert.Equal(t, ok, validBriefDate(d), d)
	}
}

func TestLaunchdStatus(t *testing.T) {
	list := "PID\tStatus\tLabel\n-\t0\tcom.other\n123\t0\tdev.local.claude.morning-brief\n"
	loaded, running, exit := launchdStatus(list, morningBriefLabel)
	assert.True(t, loaded)
	assert.True(t, running)
	assert.Equal(t, "0", exit)
	loaded, _, _ = launchdStatus("-\t0\tdev.local.claude.morning-brief.extra\n", morningBriefLabel)
	assert.False(t, loaded)
}

func TestDescribeSchedule(t *testing.T) {
	entry := func(wd, h, m string) string {
		w := ""
		if wd != "" {
			w = "<key>Weekday</key><integer>" + wd + "</integer>"
		}
		return "<dict>" + w + "<key>Hour</key><integer>" + h + "</integer><key>Minute</key><integer>" + m + "</integer></dict>"
	}
	wrap := func(inner string) string {
		return `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x"><plist version="1.0"><dict>` +
			`<key>Label</key><string>x</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>/s.sh</string></array>` +
			inner + `<key>KeepAlive</key><false/></dict></plist>`
	}
	weekdays := ""
	for _, d := range []string{"1", "2", "3", "4", "5"} {
		weekdays += entry(d, "11", "30")
	}
	cases := []struct{ name, xml, want string }{
		{"weekdays", wrap("<key>StartCalendarInterval</key><array>" + weekdays + "</array>"), "Weekdays at 11:30"},
		{"single dict daily", wrap("<key>StartCalendarInterval</key>" + entry("", "9", "5")), "Daily at 09:05"},
		{"some days", wrap("<key>StartCalendarInterval</key><array>" + entry("1", "8", "0") + entry("3", "8", "0") + "</array>"), "Mon, Wed at 08:00"},
		{"interval", wrap("<key>StartInterval</key><integer>900</integer>"), "Every 15 min"},
		{"none", wrap(""), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root, err := parsePlist(strings.NewReader(c.xml))
			require.NoError(t, err)
			assert.Equal(t, c.want, describeSchedule(root))
			assert.Equal(t, "/s.sh", root.dict["ProgramArguments"].arr[1].str)
		})
	}
}

func TestSetGateOff(t *testing.T) {
	repo := t.TempDir()
	marker := filepath.Join(repo, ".claude", gateOffFile)

	require.NoError(t, setGateOff(repo, true))
	assert.FileExists(t, marker)
	require.NoError(t, setGateOff(repo, true), "turning off twice is idempotent")
	require.NoError(t, setGateOff(repo, false))
	assert.NoFileExists(t, marker)
	require.NoError(t, setGateOff(repo, false), "removing a missing marker is fine")
	assert.DirExists(t, filepath.Join(repo, ".claude"), "only the marker is removed, never the .claude dir")

	require.NoError(t, os.MkdirAll(marker, 0o755))
	assert.Error(t, setGateOff(repo, false), "refuses to remove a directory named gate-off")
}

func TestGateToggleHandler(t *testing.T) {
	e := newGrEnv(t)
	repo := e.addGoRepo(t, "svc")
	notGo := filepath.Join(e.home, "src", "web")
	require.NoError(t, os.MkdirAll(filepath.Join(notGo, ".git"), 0o755))
	e.repos = append(e.repos, repoInfo{Path: notGo, Name: "web"})

	cases := []struct {
		name, ctype, body string
		code              int
		off               bool
	}{
		{"turn off", "application/json", `{"repo":"` + repo + `","off":true}`, 0, true},
		{"turn on", "application/json", `{"repo":"` + repo + `","off":false}`, 0, false},
		{"form post rejected", "application/x-www-form-urlencoded", "repo=" + repo + "&off=true", http.StatusBadRequest, false},
		{"no content type rejected", "", `{"repo":"` + repo + `","off":true}`, http.StatusBadRequest, false},
		{"unknown dir", "application/json", `{"repo":"/tmp","off":true}`, http.StatusNotFound, false},
		{"traversal is not a known repo", "application/json", `{"repo":"` + repo + `/../../","off":true}`, http.StatusNotFound, false},
		{"relative path", "application/json", `{"repo":"svc","off":true}`, http.StatusBadRequest, false},
		{"not a go repo", "application/json", `{"repo":"` + notGo + `","off":true}`, http.StatusBadRequest, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := handleGateToggle(jsonCtx(t, http.MethodPost, "/api/guardrails/gate-toggle", c.ctype, c.body))
			if c.code != 0 {
				require.Error(t, err)
				assert.Equal(t, c.code, statusOfErr(err))
				assert.NoFileExists(t, filepath.Join(e.home, ".claude", gateOffFile))
				return
			}
			require.NoError(t, err)
			assert.Equal(t, c.off, rawOf(t, out)["gateOff"])
			_, statErr := os.Stat(filepath.Join(repo, ".claude", gateOffFile))
			assert.Equal(t, c.off, statErr == nil)
		})
	}
	assert.NoFileExists(t, filepath.Join(notGo, ".claude", gateOffFile))
}

func waitGate(t *testing.T, repo string) *gateRun {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if r := gateSnapshot(repo); r != nil && r.Status != "running" {
			return r
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("gate did not finish")
	return nil
}

func TestGateRunWithFakeScript(t *testing.T) {
	cases := []struct {
		name, script string
		status       string
		code         int
		outHas       string
	}{
		{"pass", "echo build ok; pwd; exit 0", "pass", 0, "build ok"},
		{"fail", "echo 'FAIL coverage 80%'; exit 1", "fail", 1, "FAIL coverage"},
		{"nothing", "echo nothing to check; exit 2", "nothing", 2, "nothing to check"},
		{"crash", "exit 7", "error", 7, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newGrEnv(t)
			repo := e.addGoRepo(t, "svc")
			grWrite(t, gateScriptPath(), c.script+"\n", 0o644)

			out, err := handleGateRun(jsonCtx(t, http.MethodPost, "/api/guardrails/gate", "application/json", `{"repo":"`+repo+`"}`))
			require.NoError(t, err)
			assert.Equal(t, "running", rawOf(t, out)["status"])

			r := waitGate(t, repo)
			assert.Equal(t, c.status, r.Status)
			assert.Equal(t, c.code, r.ExitCode)
			assert.Contains(t, r.Output, c.outHas)
			if c.name == "pass" {
				assert.Contains(t, r.Output, filepath.Join("src", "svc"), "the gate runs inside the repo")
			}
			assert.GreaterOrEqual(t, r.DurationMs, int64(0))

			st, err := handleGateStatus(jsonCtx(t, http.MethodGet, "/api/guardrails/gate?repo="+repo, "", ""))
			require.NoError(t, err)
			assert.Equal(t, c.status, rawOf(t, st)["status"])
		})
	}
}

func TestGateOneRunPerRepoAndTail(t *testing.T) {
	e := newGrEnv(t)
	repo := e.addGoRepo(t, "svc")
	grWrite(t, gateScriptPath(), "for i in $(seq 1 450); do echo line$i; done; sleep 1\n", 0o644)

	_, err := handleGateRun(jsonCtx(t, http.MethodPost, "/", "application/json", `{"repo":"`+repo+`"}`))
	require.NoError(t, err)
	_, err = handleGateRun(jsonCtx(t, http.MethodPost, "/", "application/json", `{"repo":"`+repo+`"}`))
	require.Error(t, err)
	assert.Equal(t, http.StatusConflict, statusOfErr(err))

	r := waitGate(t, repo)
	assert.Equal(t, "pass", r.Status)
	assert.Equal(t, 450, r.TotalLines)
	lines := strings.Split(r.Output, "\n")
	assert.Len(t, lines, gateOutputLines)
	assert.Equal(t, "line51", lines[0])
	assert.Equal(t, "line450", lines[len(lines)-1])
}

func TestGateRunErrors(t *testing.T) {
	e := newGrEnv(t)
	repo := e.addGoRepo(t, "svc")
	_, err := handleGateRun(jsonCtx(t, http.MethodPost, "/", "application/json", `{"repo":"`+repo+`"}`))
	assert.Equal(t, http.StatusFailedDependency, statusOfErr(err), "missing gate script")

	_, err = handleGateRun(jsonCtx(t, http.MethodPost, "/", "application/json", `{"repo":"/etc"}`))
	assert.Equal(t, http.StatusNotFound, statusOfErr(err))

	st, err := handleGateStatus(jsonCtx(t, http.MethodGet, "/?repo=/nowhere", "", ""))
	require.NoError(t, err)
	assert.Equal(t, "none", rawOf(t, st)["status"])
}

func TestRunScriptTimeoutKillsGroup(t *testing.T) {
	dir := t.TempDir()
	s := filepath.Join(dir, "slow.sh")
	grWrite(t, s, "sleep 30 & sleep 30\n", 0o644)
	start := time.Now()
	_, err := runScript(s, dir, 300*time.Millisecond, &tailLines{max: 10})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "timed out")
	assert.Less(t, time.Since(start), 8*time.Second)
}

func TestSelftest(t *testing.T) {
	e := newGrEnv(t)
	good := filepath.Join(e.home, "t", "good_test.sh")
	bad := filepath.Join(e.home, "t", "bad_test.sh")
	grWrite(t, good, "echo 'guard: 12 passed, 0 failed'\n", 0o644)
	grWrite(t, bad, "echo 'FAIL want=deny got=allow :: git push -f'\necho 'x: 3 passed, 1 failed'\nexit 1\n", 0o644)

	run := func(scripts ...string) selftestState {
		selftestScripts = func() []string { return scripts }
		_, err := handleSelftestRun(jsonCtx(t, http.MethodPost, "/", "application/json", "{}"))
		require.NoError(t, err)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			selftestMu.Lock()
			cur := selftestCur
			selftestMu.Unlock()
			if cur.Status != "running" {
				return cur
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("selftest did not finish")
		return selftestState{}
	}

	st := run(good)
	assert.Equal(t, "pass", st.Status)
	assert.Equal(t, 12, st.Results[0].Pass)

	st = run(good, bad)
	assert.Equal(t, "fail", st.Status)
	assert.Equal(t, 1, st.Results[1].Fail)
	assert.Equal(t, []string{"FAIL want=deny got=allow :: git push -f"}, st.Results[1].Failing)

	st = run(filepath.Join(e.home, "missing.sh"))
	assert.Equal(t, "missing", st.Status)
	assert.True(t, st.Results[0].Missing)
}

func TestBriefHandler(t *testing.T) {
	e := newGrEnv(t)
	grWrite(t, filepath.Join(e.claude, "state", "briefs", "2026-11-16.md"), "# Monday\n- item\n", 0o644)

	out, err := handleBrief(jsonCtx(t, http.MethodGet, "/api/guardrails/brief?date=2026-11-16", "", ""))
	require.NoError(t, err)
	assert.Equal(t, "# Monday\n- item\n", rawOf(t, out)["markdown"])

	_, err = handleBrief(jsonCtx(t, http.MethodGet, "/api/guardrails/brief?date=../../settings", "", ""))
	assert.Equal(t, http.StatusBadRequest, statusOfErr(err))
	_, err = handleBrief(jsonCtx(t, http.MethodGet, "/api/guardrails/brief?date=2026-11-17", "", ""))
	assert.Equal(t, http.StatusNotFound, statusOfErr(err))
}

func TestBuildGuardrails(t *testing.T) {
	e := newGrEnv(t)
	hooks := filepath.Join(e.claude, "hooks")
	grWrite(t, filepath.Join(hooks, "guard.sh"), "#!/bin/bash\n# PreToolUse guard: denies force-push.\n", 0o755)
	grWrite(t, filepath.Join(hooks, "statusline.sh"), "#!/bin/bash\n# Statusline: model and cost.\n", 0o755)
	grWrite(t, filepath.Join(e.claude, "settings.json"), `{
	  "hooks": {
	    "PreToolUse": [
	      {"matcher": "Bash", "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/guard.sh"}]},
	      {"matcher": "*", "hooks": [{"type": "command", "command": "/x/.rook/hooks/rook-hook.sh"}]}
	    ],
	    "Stop": [{"hooks": [{"type": "command", "command": "$HOME/.claude/hooks/stop-gate.sh", "timeout": 900}]}]
	  },
	  "permissions": {"allow": ["Bash(ls)", "Bash(go test ./...)"], "deny": ["Bash(git push --force)"]},
	  "statusLine": {"type": "command", "command": "$HOME/.claude/hooks/statusline.sh"}
	}`, 0o644)
	grWrite(t, filepath.Join(e.claude, "settings.local.json"),
		`{"permissions": {"allow": ["Bash(ls)", "Bash(export TOKEN=AKIAIOSFODNN7EXAMPLE)"]}}`, 0o644)

	repo := e.addGoRepo(t, "svc")
	grWrite(t, filepath.Join(repo, ".claude", "settings.json"), `{"permissions": {"ask": ["Bash(make deploy)"]}}`, 0o644)
	grWrite(t, filepath.Join(repo, ".claude", gateOffFile), "", 0o644)
	grWrite(t, filepath.Join(repo, "dirty.txt"), "x", 0o644)
	broken := filepath.Join(e.home, "src", "broken")
	require.NoError(t, os.MkdirAll(filepath.Join(broken, ".git"), 0o755))
	grWrite(t, filepath.Join(broken, ".claude", "settings.json"), "{not json", 0o644)
	e.repos = append(e.repos, repoInfo{Path: broken, Name: "broken"})

	grWrite(t, filepath.Join(e.claude, "state", "briefs", "2026-11-13.md"), "a", 0o644)
	grWrite(t, filepath.Join(e.claude, "state", "briefs", "2026-11-16.md"), "bb", 0o644)
	grWrite(t, filepath.Join(e.claude, "state", "briefs", "launchd.err"), "", 0o644)
	launchctlList = func() (string, error) { return "-\t0\t" + morningBriefLabel + "\n", nil }

	g := buildGuardrails()

	require.Len(t, g.Hooks, 3)
	byCmd := map[string]grHook{}
	for _, h := range g.Hooks {
		byCmd[filepath.Base(h.Script)+"|"+h.Event] = h
	}
	guard := byCmd["guard.sh|PreToolUse"]
	assert.Equal(t, "ok", guard.Health)
	assert.Equal(t, "PreToolUse guard: denies force-push.", guard.Purpose)
	assert.Equal(t, "global", guard.Source)
	stop := byCmd["stop-gate.sh|Stop"]
	assert.Equal(t, "missing", stop.Health)
	assert.Equal(t, 900, stop.Timeout)
	assert.True(t, byCmd["rook-hook.sh|PreToolUse"].Rook)

	require.Len(t, g.Conflicts, 1)
	assert.Equal(t, "PreToolUse", g.Conflicts[0].Event)

	require.Len(t, g.Permissions, 4, "global, global-local, repo, and the broken repo's error row")
	perms := map[string]grPermSet{}
	for _, p := range g.Permissions {
		if p.Error == "" {
			perms[p.Source] = p
		}
	}
	assert.Equal(t, 2, perms["global"].AllowN)
	assert.Equal(t, 1, perms["global"].DenyN)
	assert.Nil(t, perms["global-local"].Allow)
	require.Len(t, perms["global-local"].Flags, 1)
	assert.Equal(t, 2, perms["global-local"].Flags[0].Index)
	assert.Equal(t, []string{"Bash(make deploy)"}, perms["repo"].Ask)
	assert.NotEmpty(t, g.Errors, "an unparseable repo settings.json is reported, not fatal")
	b, _ := json.Marshal(g)
	assert.NotContains(t, string(b), "AKIAIOSFODNN7EXAMPLE")

	require.Len(t, g.Gate, 1, "only Go repos are gate rows")
	assert.Equal(t, "main", g.Gate[0].Branch)
	assert.True(t, g.Gate[0].GateOff)
	assert.GreaterOrEqual(t, g.Gate[0].Dirty, 2)

	require.NotNil(t, g.Statusline)
	assert.Equal(t, "Statusline: model and cost.", g.Statusline.Purpose)

	assert.True(t, g.Morning.Loaded)
	require.Len(t, g.Morning.Briefs, 2)
	assert.Equal(t, "2026-11-16", g.Morning.Briefs[0].Date)
	assert.Equal(t, int64(2), g.Morning.Briefs[0].Size)
	assert.False(t, g.GateScriptOK)
}

func TestConfigRepoRoots(t *testing.T) {
	e := newGrEnv(t)
	grWrite(t, filepath.Join(e.home, ".rook", "config.json"), `{"repoRoots": ["~/code", "/abs/x", "relative", ""]}`, 0o644)
	assert.Equal(t, []string{filepath.Join(e.home, "code"), "/abs/x"}, configRepoRoots())
}

func TestDiscoverGuardrailRepos(t *testing.T) {
	e := newGrEnv(t)
	root := filepath.Join(e.home, "myroots")
	for _, d := range []string{"alpha", "Beta", ".hidden", "plain"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, d), 0o755))
	}
	for _, d := range []string{"alpha", "Beta", ".hidden"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, d, ".git"), 0o755))
	}
	rookWT := filepath.Join(e.home, ".rook", "worktrees", "wt")
	require.NoError(t, os.MkdirAll(filepath.Join(rookWT, ".git"), 0o755))
	grWrite(t, filepath.Join(e.home, ".rook", "config.json"),
		`{"repoRoots": ["`+root+`", "`+filepath.Join(root, "alpha")+`", "`+filepath.Join(e.home, ".rook", "worktrees")+`", "/does/not/exist"]}`, 0o644)

	got := discoverGuardrailRepos()
	var names []string
	for _, r := range got {
		names = append(names, r.Name)
	}
	assert.Equal(t, []string{"alpha", "Beta"}, names, "git repos one level under each root, sorted case-insensitively; dot dirs, non-repos, duplicates and rook worktrees skipped")
}

func TestConfigRepoRootsEdgeCases(t *testing.T) {
	e := newGrEnv(t)
	assert.Nil(t, configRepoRoots(), "no config file")
	cfg := filepath.Join(e.home, ".rook", "config.json")
	grWrite(t, cfg, "{broken", 0o644)
	assert.Nil(t, configRepoRoots(), "invalid JSON")
	grWrite(t, cfg, `{"repoRoots": ["~", " /a/b/ "]}`, 0o644)
	assert.Equal(t, []string{e.home, "/a/b"}, configRepoRoots())
}

func TestReadSettingsFile(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.json")
	grWrite(t, empty, "  \n", 0o644)
	bad := filepath.Join(dir, "bad.json")
	grWrite(t, bad, "{", 0o644)
	cases := []struct {
		name, path   string
		exists, fail bool
	}{
		{"missing", filepath.Join(dir, "nope.json"), false, false},
		{"empty", empty, true, false},
		{"invalid json", bad, true, true},
		{"directory", dir, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, exists, err := readSettingsFile(c.path)
			assert.Equal(t, c.exists, exists)
			assert.Equal(t, c.fail, err != nil)
		})
	}
}

func TestScriptPurposeMissingAndBadMatcher(t *testing.T) {
	dir := t.TempDir()
	assert.Empty(t, scriptPurpose(filepath.Join(dir, "nope.sh")))
	only := filepath.Join(dir, "only.sh")
	grWrite(t, only, "#!/bin/sh\n#\n\n", 0o755)
	assert.Empty(t, scriptPurpose(only), "a header of empty comments has no purpose")
	assert.True(t, matchersOverlap("(", "Bash"), "an invalid regex cannot be ruled out")
}

func TestConflictNoteEvents(t *testing.T) {
	cases := []struct {
		event, sev, has string
		rk              grRook
	}{
		{"PreToolUse", "warn", "rook gate is off", grRook{}},
		{"Stop", "warn", "auto-review (on)", grRook{AutoReview: true}},
		{"Stop", "info", "auto-verify (off)", grRook{}},
		{"Notification", "info", "two notifications", grRook{}},
		{"SubagentStop", "info", "Both hooks run", grRook{}},
	}
	for _, c := range cases {
		sev, note := conflictNote(c.event, c.rk)
		assert.Equal(t, c.sev, sev, c.event)
		assert.Contains(t, note, c.has, c.event)
	}
}

func TestTailLinesPartial(t *testing.T) {
	tl := &tailLines{max: 2}
	_, _ = tl.Write([]byte("a\nb\nc"))
	out, total := tl.String()
	assert.Equal(t, "b\nc", out, "an unterminated last line counts and the tail stays capped")
	assert.Equal(t, 3, total)
	_, _ = tl.Write([]byte("d\n"))
	out, total = tl.String()
	assert.Equal(t, "b\ncd", out)
	assert.Equal(t, 3, total)
}

func TestGateStatusFor(t *testing.T) {
	cases := []struct {
		code int
		err  error
		want string
	}{
		{0, nil, "pass"}, {1, nil, "fail"}, {2, nil, "nothing"}, {3, nil, "error"}, {-1, os.ErrDeadlineExceeded, "error"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, gateStatusFor(c.code, c.err))
	}
}

func TestListBriefsEdgeCases(t *testing.T) {
	dir := t.TempDir()
	assert.Empty(t, listBriefs(filepath.Join(dir, "missing")))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "2026-01-01.md"), 0o755))
	grWrite(t, filepath.Join(dir, "2026-13-01.md"), "x", 0o644)
	grWrite(t, filepath.Join(dir, "notes.md"), "x", 0o644)
	grWrite(t, filepath.Join(dir, "2026-01-02.md"), "x", 0o644)
	got := listBriefs(dir)
	require.Len(t, got, 1)
	assert.Equal(t, "2026-01-02", got[0].Date)
}

func TestParsePlistErrors(t *testing.T) {
	bad := []string{
		"",
		"<plist><dict><key>A</key><string>x",
		"<plist><array><string>x</string>",
		"<plist><dict><key>A</key><array><integer>1</integer>",
		"<plist><dict><key>A</key><true>",
		"<plist><dict><key>A",
	}
	for _, b := range bad {
		_, err := parsePlist(strings.NewReader(b))
		assert.Error(t, err, b)
	}
	root, err := parsePlist(strings.NewReader("<plist><dict><key>RunAtLoad</key><true/><key>D</key><date>2026-01-01T00:00:00Z</date></dict></plist>"))
	require.NoError(t, err)
	assert.Equal(t, "other", root.dict["D"].kind)
	assert.Equal(t, "At login", describeSchedule(root))
	assert.Empty(t, describeSchedule(nil))
}

func TestMorningInfo(t *testing.T) {
	e := newGrEnv(t)
	launchctlList = func() (string, error) { return "", os.ErrPermission }
	m := morningInfo()
	assert.False(t, m.Loaded)
	assert.False(t, m.PlistExists)
	assert.Empty(t, m.Briefs)

	grWrite(t, filepath.Join(e.home, "Library", "LaunchAgents", morningBriefLabel+".plist"),
		`<plist><dict><key>ProgramArguments</key><array><string>/bin/bash</string><string>/x/brief.sh</string></array>`+
			`<key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict></dict></plist>`, 0o644)
	launchctlList = func() (string, error) { return "88\t0\t" + morningBriefLabel, nil }
	m = morningInfo()
	assert.True(t, m.PlistExists)
	assert.True(t, m.Running)
	assert.Equal(t, "Daily at 07:00", m.Schedule)
	assert.Equal(t, "/x/brief.sh", m.Program)
}

func TestRepoBranchDirty(t *testing.T) {
	e := newGrEnv(t)
	repo := e.addGoRepo(t, "svc")
	git := func(args ...string) {
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	git("add", "-A")
	git("commit", "-q", "-m", "init")
	br, dirty := repoBranchDirty(repo)
	assert.Equal(t, "main", br)
	assert.Equal(t, 0, dirty)

	git("checkout", "-q", "--detach")
	br, _ = repoBranchDirty(repo)
	assert.True(t, strings.HasPrefix(br, "detached@"), br)

	br, dirty = repoBranchDirty(t.TempDir())
	assert.Empty(t, br)
	assert.Equal(t, -1, dirty, "not a repo")
}

func TestBindJSONBadBody(t *testing.T) {
	var v gateReq
	err := bindJSON(jsonCtx(t, http.MethodPost, "/", "application/json", `{"repo": 5}`), &v)
	assert.Equal(t, http.StatusBadRequest, statusOfErr(err))
	err = bindJSON(jsonCtx(t, http.MethodPost, "/", "application/json", `{"repo":"/x","off":true}`), &v)
	require.NoError(t, err)
	assert.Equal(t, gateReq{Repo: "/x", Off: true}, v)
}

func TestHandleGuardrailsEmptySetup(t *testing.T) {
	newGrEnv(t)
	out, err := handleGuardrails(jsonCtx(t, http.MethodGet, "/api/guardrails", "", ""))
	require.NoError(t, err)
	m := rawOf(t, out)
	for _, k := range []string{"hooks", "conflicts", "permissions", "gate"} {
		assert.Equal(t, []any{}, m[k], "%s is an empty list, never null, so the UI shows its empty state", k)
	}
	assert.Nil(t, m["statusline"])
}

func TestSetGateOffMkdirFails(t *testing.T) {
	repo := t.TempDir()
	grWrite(t, filepath.Join(repo, ".claude"), "a file, not a dir", 0o644)
	assert.Error(t, setGateOff(repo, true))
}

func TestSelftestAlreadyRunning(t *testing.T) {
	newGrEnv(t)
	selftestMu.Lock()
	prev := selftestCur
	selftestCur = selftestState{Status: "running", StartedAt: 42}
	selftestMu.Unlock()
	t.Cleanup(func() { selftestMu.Lock(); selftestCur = prev; selftestMu.Unlock() })

	called := false
	selftestScripts = func() []string { called = true; return nil }
	out, err := handleSelftestRun(jsonCtx(t, http.MethodPost, "/", "application/json", "{}"))
	require.NoError(t, err)
	assert.Equal(t, "running", rawOf(t, out)["status"])
	assert.False(t, called, "a second run is not started while one is in flight")

	st, err := handleSelftestStatus(jsonCtx(t, http.MethodGet, "/", "", ""))
	require.NoError(t, err)
	assert.Equal(t, float64(42), rawOf(t, st)["startedAt"])
}

func TestRunSelftestNonZeroWithoutFailLines(t *testing.T) {
	dir := t.TempDir()
	s := filepath.Join(dir, "x_test.sh")
	grWrite(t, s, "echo 'setup failed'\nexit 1\n", 0o644)
	res := runSelftest([]string{s})
	require.Len(t, res, 1)
	assert.Contains(t, res[0].Error, "exited 1: setup failed")
	assert.Equal(t, "fail", selftestVerdict(res))
}
