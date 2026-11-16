package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gofr.dev/pkg/gofr"
	gofrHTTP "gofr.dev/pkg/gofr/http"
	resp "gofr.dev/pkg/gofr/http/response"
)

func kitCtx(method, target string) *gofr.Context {
	r := httptest.NewRequest(method, target, http.NoBody)
	return &gofr.Context{Context: context.Background(), Request: gofrHTTP.NewRequest(r)}
}

// rawBody re-encodes a handler's rawJSON payload so tests assert on the wire shape.
func rawBody[T any](t *testing.T, v any) T {
	t.Helper()
	raw, ok := v.(resp.Raw)
	require.True(t, ok, "handler must answer with rawJSON")
	b, err := json.Marshal(raw.Data)
	require.NoError(t, err)
	var out T
	require.NoError(t, json.Unmarshal(b, &out))
	return out
}

// kitEnv points claudeDir() and repo discovery at a temp home holding a fake
// ~/.claude and one repo under ~/Desktop/github, and resets the repo cache.
func kitEnv(t *testing.T) (root, repoPath, home string) {
	home = realTemp(t)
	root = filepath.Join(home, ".claude")
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", root)
	kitWrite(t, filepath.Join(root, "agents", "rev.md"), "---\nname: rev\ntools: Read\n---\nprompt body\n")
	kitWrite(t, filepath.Join(root, "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: d\n---\n")
	kitWrite(t, filepath.Join(home, "secret.txt"), "token")
	repoPath = filepath.Join(home, "Desktop", "github", "svc")
	require.NoError(t, os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755))
	kitWrite(t, filepath.Join(repoPath, ".claude", "skills", "tk", "SKILL.md"), "---\nname: tk\n---\nbody\n")
	kitReposMu.Lock()
	kitReposSet, kitLastRepos = false, nil
	kitReposMu.Unlock()
	t.Cleanup(func() {
		kitReposMu.Lock()
		kitReposSet, kitLastRepos = false, nil
		kitReposMu.Unlock()
	})
	return root, repoPath, home
}

func TestHandleKit(t *testing.T) {
	root, repoPath, _ := kitEnv(t)
	out, err := handleKit(kitCtx(http.MethodGet, "/api/kit"))
	require.NoError(t, err)
	inv := rawBody[kitInventory](t, out)
	assert.Equal(t, root, inv.Home)
	require.Len(t, inv.Agents, 1)
	assert.Equal(t, "rev", inv.Agents[0].Name)
	require.Len(t, inv.Skills, 2)
	assert.Equal(t, []kitRepo{{Name: "svc", Path: repoPath}}, inv.Repos, "repos come from rook's repo discovery")
}

func TestHandleKitFile(t *testing.T) {
	root, repoPath, home := kitEnv(t)
	big := filepath.Join(root, "skills", "gate", "big.md")
	kitWrite(t, big, string(make([]byte, kitMaxFileBytes+1)))

	tests := []struct {
		name    string
		path    string
		code    int
		content string
	}{
		{"global agent", filepath.Join(root, "agents", "rev.md"), 0, "---\nname: rev\ntools: Read\n---\nprompt body\n"},
		{"repo skill from discovered repo", filepath.Join(repoPath, ".claude", "skills", "tk", "SKILL.md"), 0, "---\nname: tk\n---\nbody\n"},
		{"traversal out of .claude", filepath.Join(root, "agents") + "/../../secret.txt", http.StatusForbidden, ""},
		{"absolute outside path", filepath.Join(home, "secret.txt"), http.StatusForbidden, ""},
		{"settings.json beside the roots", filepath.Join(root, "agents", "..", "settings.json"), http.StatusForbidden, ""},
		{"missing param", "", http.StatusForbidden, ""},
		{"too large", big, http.StatusRequestEntityTooLarge, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out, err := handleKitFile(kitCtx(http.MethodGet, "/api/kit/file?path="+url.QueryEscape(tc.path)))
			if tc.code != 0 {
				require.Error(t, err)
				var he *httpErr
				require.ErrorAs(t, err, &he)
				assert.Equal(t, tc.code, he.StatusCode())
				assert.Nil(t, out)
				return
			}
			require.NoError(t, err)
			got := rawBody[map[string]any](t, out)
			assert.Equal(t, tc.content, got["content"])
			assert.Equal(t, tc.path, got["resolved"])
		})
	}
}

func TestHandleKitAudit(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	root, _, _ := kitEnv(t)
	kitWrite(t, kitAuditScript(root), "import time\ntime.sleep(0.4)\nprint('skill-audit: 1 skills')\nprint('WARN user/gate  description too short to choose by')\nprint('RESULT: PASS (0 fail, 1 warn)')\n")
	kitAuditMu.Lock()
	saved := kitAuditLast
	kitAuditLast = kitAuditResult{Findings: []kitFinding{}}
	kitAuditMu.Unlock()
	t.Cleanup(func() { kitAuditMu.Lock(); kitAuditLast = saved; kitAuditMu.Unlock() })

	out, err := handleKitAuditGet(kitCtx(http.MethodGet, "/api/kit/audit"))
	require.NoError(t, err)
	assert.Zero(t, rawBody[kitAuditResult](t, out).RanAt, "nothing cached before the first run")

	out, err = handleKitAuditRun(kitCtx(http.MethodPost, "/api/kit/audit"))
	require.NoError(t, err)
	assert.True(t, rawBody[kitAuditResult](t, out).Running, "POST returns at once with the run in progress")

	out, err = handleKitAuditRun(kitCtx(http.MethodPost, "/api/kit/audit"))
	require.NoError(t, err)
	assert.True(t, rawBody[kitAuditResult](t, out).Running, "a second POST while running does not start another run")

	var res kitAuditResult
	require.Eventually(t, func() bool {
		o, err := handleKitAuditGet(kitCtx(http.MethodGet, "/api/kit/audit"))
		require.NoError(t, err)
		res = rawBody[kitAuditResult](t, o)
		return !res.Running
	}, 10*time.Second, 50*time.Millisecond)
	assert.Equal(t, "PASS", res.Result)
	assert.NotZero(t, res.RanAt)
	require.Len(t, res.Findings, 1)
	assert.Equal(t, kitFinding{Skill: "gate", Scope: "user", Level: "warn", Message: "description too short to choose by"}, res.Findings[0])
}

func TestStrListUnmarshalEdges(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"mapping is ignored", "tools:\n  a: b", nil},
		{"sequence of maps fails YAML and falls back", "tools:\n  - a: b\n  - Read", []string{"a: b", "Read"}},
		{"quoted entries trimmed", "tools: \"'Read'\", ''", []string{"Read"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { assert.Equal(t, tc.want, []string(parseFront(tc.in).Tools)) })
	}
}

func TestScanEdgeCases(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file permissions")
	}
	base := realTemp(t)
	agents := filepath.Join(base, "agents")
	kitWrite(t, filepath.Join(agents, "locked.md"), "---\nname: locked\n---\n")
	require.NoError(t, os.Chmod(filepath.Join(agents, "locked.md"), 0o000))
	require.NoError(t, os.MkdirAll(filepath.Join(agents, "dir.md"), 0o755))
	require.NoError(t, os.Symlink(filepath.Join(base, "nowhere"), filepath.Join(agents, "broken.md")))
	kitWrite(t, filepath.Join(agents, "nameless.md"), "---\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: \"\"\n        - type: command\n          command: stop.sh\n---\n")
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(agents, "locked.md"), 0o644) })

	got := scanAgents(agents, "global", base, "")
	require.Len(t, got, 1, "unreadable, directory and broken-link entries are skipped")
	assert.Equal(t, "nameless", got[0].Name, "name falls back to the file name")
	assert.Equal(t, []kitHook{{Event: "Stop", Command: "stop.sh"}}, got[0].Hooks, "empty hook commands are dropped")
	assert.Empty(t, got[0].WriteScope)

	skills := filepath.Join(base, "skills")
	kitWrite(t, filepath.Join(skills, "locked", "SKILL.md"), "x")
	require.NoError(t, os.Chmod(filepath.Join(skills, "locked", "SKILL.md"), 0o000))
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(skills, "locked", "SKILL.md"), 0o644) })
	assert.Empty(t, scanSkills(skills, "global", base))
	assert.Nil(t, scanSkills(filepath.Join(base, "missing"), "global", base))

	arch := filepath.Join(base, "archive")
	require.NoError(t, os.MkdirAll(filepath.Join(arch, ".hidden"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(arch, "kept"), 0o755))
	kitWrite(t, filepath.Join(arch, "stray.md"), "x")
	assert.Equal(t, []kitArchived{{Name: "kept", Scope: "s", ScopePath: base}}, scanArchived(arch, "s", base))
	assert.Nil(t, scanArchived(filepath.Join(base, "missing"), "s", base))

	assert.Equal(t, "", readPrefix(filepath.Join(base, "missing"), 10))
}

func TestBuildKitRepoMemoryScopes(t *testing.T) {
	base := realTemp(t)
	root := filepath.Join(base, ".claude")
	kitWrite(t, filepath.Join(root, "agent-memory", "u", "MEMORY.md"), "user")
	repo := kitRepo{Name: "r", Path: filepath.Join(base, "r")}
	dot := filepath.Join(repo.Path, ".claude")
	kitWrite(t, filepath.Join(dot, "agents", "l.md"), "---\nname: l\nmemory: local\n---\n")
	kitWrite(t, filepath.Join(dot, "agents", "u.md"), "---\nname: u\nmemory: user\n---\n")
	kitWrite(t, filepath.Join(dot, "agents", "n.md"), "---\nname: n\n---\n")
	kitWrite(t, filepath.Join(dot, "agent-memory-local", "l", "MEMORY.md"), "local")

	inv := buildKit(root, []kitRepo{repo})
	byName := map[string]kitAgent{}
	for _, a := range inv.Agents {
		byName[a.Name] = a
	}
	assert.Equal(t, filepath.Join(dot, "agent-memory-local", "l"), byName["l"].MemoryDir)
	require.Len(t, byName["l"].MemoryFiles, 1)
	assert.Equal(t, filepath.Join(root, "agent-memory", "u"), byName["u"].MemoryDir, "user memory of a repo agent lives under ~/.claude")
	require.Len(t, byName["u"].MemoryFiles, 1)
	assert.Equal(t, "user", byName["u"].MemoryFiles[0].Preview)
	assert.Empty(t, byName["n"].MemoryDir)
}

// pins that a cloned repo cannot widen the allowlist or the memory previews
// with committed symlinks or a crafted agent name.
func TestKitUntrustedRepo(t *testing.T) {
	base := realTemp(t)
	root := filepath.Join(base, ".claude")
	kitWrite(t, filepath.Join(root, "agents", "a.md"), "---\nname: a\n---\n")
	secretDir := filepath.Join(base, "private")
	kitWrite(t, filepath.Join(secretDir, "id_key"), "PRIVATE KEY")

	evil := kitRepo{Name: "evil", Path: filepath.Join(base, "evil")}
	require.NoError(t, os.MkdirAll(filepath.Join(evil.Path, ".claude"), 0o755))
	require.NoError(t, os.Symlink(secretDir, filepath.Join(evil.Path, ".claude", "skills")))
	kitWrite(t, filepath.Join(evil.Path, ".claude", "agents", "x.md"), "---\nname: ../../private\nmemory: project\n---\n")
	kitWrite(t, filepath.Join(evil.Path, ".claude", "agents", "y.md"), "---\nname: y\nmemory: project\n---\n")
	require.NoError(t, os.MkdirAll(filepath.Join(evil.Path, ".claude", "agent-memory", "y"), 0o755))
	require.NoError(t, os.Symlink(filepath.Join(secretDir, "id_key"), filepath.Join(evil.Path, ".claude", "agent-memory", "y", "MEMORY.md")))
	linkedDot := kitRepo{Name: "dot", Path: filepath.Join(base, "dot")}
	require.NoError(t, os.MkdirAll(linkedDot.Path, 0o755))
	require.NoError(t, os.Symlink(filepath.Join(base, ".claude"), filepath.Join(linkedDot.Path, ".claude")))

	roots := kitAllowedRoots(root, []kitRepo{evil, linkedDot})
	assert.Equal(t, "", kitResolveAllowed(filepath.Join(evil.Path, ".claude", "skills", "id_key"), roots), "a symlinked repo root is not allowed")
	assert.NotContains(t, roots, filepath.Join(evil.Path, ".claude", "skills"))
	for _, r := range roots {
		assert.NotContains(t, r, linkedDot.Path, "a symlinked repo .claude contributes no roots")
	}

	inv := buildKit(root, []kitRepo{evil, linkedDot})
	assert.Empty(t, inv.Skills, "skills behind a symlinked folder are not scanned")
	for _, a := range inv.Agents {
		assert.Empty(t, a.MemoryFiles, "agent %q must not preview files outside its memory folder", a.Name)
		if a.Name == "../../private" {
			assert.Empty(t, a.MemoryDir)
		}
	}
	assert.Empty(t, kitRepoCandidates([]repoInfo{{Path: linkedDot.Path}}, root))
}

func TestKitSafeName(t *testing.T) {
	for n, want := range map[string]bool{"tech-lead": true, "": false, ".": false, "..": false, "a/b": false, "../x": false, `a\b`: false} {
		assert.Equal(t, want, kitSafeName(n), n)
	}
}

func TestFallbackFlowList(t *testing.T) {
	f := parseFront("description: Reviews code. Use when: asked\ntools: [Read, Edit]")
	assert.Equal(t, []string{"Read", "Edit"}, []string(f.Tools))
	assert.False(t, agentReadOnly(f.Tools, nil), "an agent with Edit in a flow list is not read-only")
}

func TestKitSameSite(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := kitSameSite(ok)
	tests := []struct {
		name, path, site, origin string
		want                     int
	}{
		{"same origin fetch", "/api/kit/file", "same-origin", "http://127.0.0.1:7480", http.StatusTeapot},
		{"no browser headers (curl)", "/api/kit", "", "", http.StatusTeapot},
		{"cross-site fetch", "/api/kit/file", "cross-site", "", http.StatusForbidden},
		{"same-site other port", "/api/kit", "same-site", "", http.StatusForbidden},
		{"foreign origin without fetch metadata", "/api/kit/audit", "", "https://evil.example", http.StatusForbidden},
		{"bad origin", "/api/kit", "", "://", http.StatusForbidden},
		{"other endpoints untouched", "/api/state", "cross-site", "https://evil.example", http.StatusTeapot},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:7480"+tc.path, http.NoBody)
			if tc.site != "" {
				r.Header.Set("Sec-Fetch-Site", tc.site)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			assert.Equal(t, tc.want, w.Code)
		})
	}
}

func TestHandleKitFileUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file permissions")
	}
	root, _, _ := kitEnv(t)
	p := filepath.Join(root, "agents", "locked.md")
	kitWrite(t, p, "x")
	require.NoError(t, os.Chmod(p, 0o000))
	t.Cleanup(func() { _ = os.Chmod(p, 0o644) })
	_, err := handleKitFile(kitCtx(http.MethodGet, "/api/kit/file?path="+url.QueryEscape(p)))
	var he *httpErr
	require.ErrorAs(t, err, &he)
	assert.Equal(t, http.StatusNotFound, he.StatusCode())
}
