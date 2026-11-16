package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func kitWrite(t *testing.T, p, body string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
	require.NoError(t, os.WriteFile(p, []byte(body), 0o644))
}

// realTemp resolves the temp dir so macOS /var -> /private/var does not make
// resolved paths differ from the ones the test builds.
func realTemp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	return d
}

func TestSplitFrontmatter(t *testing.T) {
	tests := []struct {
		name, in, front, body string
	}{
		{"none", "# hi\n", "", "# hi\n"},
		{"basic", "---\nname: x\n---\nbody\n", "name: x", "body\n"},
		{"crlf", "---\r\nname: x\r\n---\r\nbody", "name: x", "body"},
		{"unterminated", "---\nname: x\nbody", "", "---\nname: x\nbody"},
		{"empty front", "---\n---\nbody", "", "body"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f, b := splitFrontmatter(tc.in)
			assert.Equal(t, tc.front, f)
			assert.Equal(t, tc.body, b)
		})
	}
}

func TestParseFront(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		check func(t *testing.T, f kitFront)
	}{
		{"comma tools and list skills", "name: a\ntools: Read, Grep , Bash\nskills:\n  - one\n  - two\nmodel: opus", func(t *testing.T, f kitFront) {
			assert.Equal(t, []string{"Read", "Grep", "Bash"}, []string(f.Tools))
			assert.Equal(t, []string{"one", "two"}, []string(f.Skills))
			assert.Equal(t, "opus", f.Model)
		}},
		{"sequence tools", "tools: [Read, Write]", func(t *testing.T, f kitFront) {
			assert.Equal(t, []string{"Read", "Write"}, []string(f.Tools))
		}},
		{"bool manual-only", "disable-model-invocation: true\nx-side-effects: guarded", func(t *testing.T, f kitFront) {
			assert.Equal(t, "true", f.DisableModel)
			assert.Equal(t, "guarded", f.SideEffects)
		}},
		{"hooks", "hooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n      hooks:\n        - type: command\n          command: \"x.sh\"", func(t *testing.T, f kitFront) {
			require.Len(t, f.Hooks["PreToolUse"], 1)
			assert.Equal(t, "Bash", f.Hooks["PreToolUse"][0].Matcher)
			assert.Equal(t, "x.sh", f.Hooks["PreToolUse"][0].Hooks[0].Command)
		}},
		{"invalid yaml falls back to line parsing", "name: loop\ndescription: Set up a loop: do it. Use when asked\n  and more\nallowed-tools: Bash, Read\nargument-hint: \"<n>\"", func(t *testing.T, f kitFront) {
			assert.Equal(t, "loop", f.Name)
			assert.Equal(t, "Set up a loop: do it. Use when asked and more", f.Description)
			assert.Equal(t, []string{"Bash", "Read"}, []string(f.AllowedTools))
			assert.Equal(t, "<n>", f.ArgumentHint)
		}},
		{"fallback list and folded description", "description: >\nname: a: b\nskills:\n  - s1", func(t *testing.T, f kitFront) {
			assert.Equal(t, "", f.Description)
			assert.Equal(t, []string{"s1"}, []string(f.Skills))
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { tc.check(t, parseFront(tc.in)) })
	}
}

func TestAgentReadOnly(t *testing.T) {
	tests := []struct {
		name       string
		tools, dis []string
		want       bool
	}{
		{"read tools only", []string{"Read", "Grep", "Bash"}, nil, true},
		{"has edit", []string{"Read", "Edit"}, nil, false},
		{"has notebook edit", []string{"NotebookEdit"}, nil, false},
		{"wildcard", []string{"*"}, nil, false},
		{"no tools inherits all", nil, nil, false},
		{"no tools but every writer disallowed", nil, []string{"Write", "Edit", "MultiEdit", "NotebookEdit"}, true},
		{"no tools, some writers disallowed", nil, []string{"Write"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { assert.Equal(t, tc.want, agentReadOnly(tc.tools, tc.dis)) })
	}
}

func TestReadMemFiles(t *testing.T) {
	dir := realTemp(t)
	for i := 0; i < 12; i++ {
		p := filepath.Join(dir, fmt.Sprintf("n%02d.md", i))
		kitWrite(t, p, "x")
		ts := time.Now().Add(time.Duration(i) * time.Minute)
		require.NoError(t, os.Chtimes(p, ts, ts))
	}
	old := time.Now().Add(-time.Hour)
	kitWrite(t, filepath.Join(dir, "MEMORY.md"), strings.Repeat("é", 2000)) // 4000 bytes
	require.NoError(t, os.Chtimes(filepath.Join(dir, "MEMORY.md"), old, old))
	kitWrite(t, filepath.Join(dir, ".hidden"), "x")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "sub"), 0o755))

	got := readMemFiles(dir)
	require.Len(t, got, kitMaxMemFiles)
	assert.Equal(t, "MEMORY.md", got[0].Name, "MEMORY.md is listed first even when oldest")
	assert.Equal(t, "n11.md", got[1].Name, "then newest first")
	assert.LessOrEqual(t, len(got[0].Preview), kitMemPreview)
	assert.True(t, strings.HasPrefix(got[0].Preview, "éé"))
	assert.NotContains(t, got[0].Preview, "�", "a rune split at the cap is dropped, not mangled")
	assert.Empty(t, readMemFiles(filepath.Join(dir, "missing")))
}

// kitFixture builds a fake ~/.claude plus one repo with project agents/skills.
func kitFixture(t *testing.T) (root string, repo kitRepo, base string) {
	base = realTemp(t)
	root = filepath.Join(base, "home", ".claude")
	kitWrite(t, filepath.Join(root, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code. Use when asked.\ntools: Read, Grep\nmodel: opus\neffort: high\nmemory: user\ncolor: purple\nskills:\n  - tech-lead\nhooks:\n  PreToolUse:\n    - matcher: \"Edit|Write\"\n      hooks:\n        - type: command\n          command: \"$HOME/.claude/hooks/agent-write-scope.sh memory\"\n---\nbody\n")
	kitWrite(t, filepath.Join(root, "agents", "writer.md"), "---\nname: writer\ndescription: d\n---\n")
	kitWrite(t, filepath.Join(root, "agents", "notes.txt"), "ignored")
	kitWrite(t, filepath.Join(root, "agent-memory", "reviewer", "MEMORY.md"), "- lesson one\n")
	kitWrite(t, filepath.Join(root, "skills", "gate", "SKILL.md"), "---\nname: gate\ndescription: Check things. Use before done.\ndisable-model-invocation: true\nallowed-tools: Bash\nx-side-effects: guarded\ncontext: fork\nagent: gate-runner\nargument-hint: \"[repo]\"\n---\nline\nline\n")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "skills", "gate", "scripts"), 0o755))
	kitWrite(t, filepath.Join(root, "skills", "gstack", "browse", "SKILL.md"), "---\nname: browse\ndescription: b\n---\n")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "skills", "browse"), 0o755))
	require.NoError(t, os.Symlink(filepath.Join(root, "skills", "gstack", "browse", "SKILL.md"), filepath.Join(root, "skills", "browse", "SKILL.md")))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "skills", "empty"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "skills-archive", "old"), 0o755))

	repoPath := filepath.Join(base, "work", "svc")
	repo = kitRepo{Name: "svc", Path: repoPath}
	kitWrite(t, filepath.Join(repoPath, ".claude", "agents", "seo.md"), "---\nname: seo\ntools: Read, Write\nmemory: project\n---\n")
	kitWrite(t, filepath.Join(repoPath, ".claude", "agent-memory", "seo", "MEMORY.md"), "proj")
	kitWrite(t, filepath.Join(repoPath, ".claude", "skills", "ticket", "SKILL.md"), "no frontmatter")
	require.NoError(t, os.MkdirAll(filepath.Join(repoPath, ".claude", "skills", "ticket", "references"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(repoPath, ".claude", "skills-archive", "gone"), 0o755))
	return root, repo, base
}

func TestBuildKit(t *testing.T) {
	root, repo, base := kitFixture(t)
	bare := kitRepo{Name: "bare", Path: filepath.Join(base, "work", "bare")}
	require.NoError(t, os.MkdirAll(bare.Path, 0o755))

	inv := buildKit(root, []kitRepo{repo, bare})

	agents := map[string]kitAgent{}
	for _, a := range inv.Agents {
		agents[a.Name] = a
	}
	require.Len(t, agents, 3)
	rv := agents["reviewer"]
	assert.Equal(t, kitGlobalScope, rv.Scope)
	assert.Equal(t, "opus", rv.Model)
	assert.Equal(t, "high", rv.Effort)
	assert.Equal(t, []string{"Read", "Grep"}, rv.Tools)
	assert.Equal(t, []string{"tech-lead"}, rv.Skills)
	assert.True(t, rv.ReadOnly)
	assert.Contains(t, rv.WriteScope, "agent-write-scope.sh memory")
	require.Len(t, rv.Hooks, 1)
	assert.Equal(t, kitHook{Event: "PreToolUse", Matcher: "Edit|Write", Command: "$HOME/.claude/hooks/agent-write-scope.sh memory"}, rv.Hooks[0])
	require.Len(t, rv.MemoryFiles, 1)
	assert.Equal(t, "- lesson one\n", rv.MemoryFiles[0].Preview)
	assert.False(t, agents["writer"].ReadOnly, "an agent without a tools list inherits Write/Edit")
	assert.Empty(t, agents["writer"].MemoryFiles)
	seo := agents["seo"]
	assert.Equal(t, "svc", seo.Scope)
	assert.False(t, seo.ReadOnly)
	assert.Equal(t, filepath.Join(repo.Path, ".claude", "agent-memory", "seo"), seo.MemoryDir)
	require.Len(t, seo.MemoryFiles, 1)

	skills := map[string]kitSkill{}
	for _, s := range inv.Skills {
		skills[s.Scope+"/"+s.Name] = s
	}
	require.Len(t, skills, 3, "dirs without SKILL.md (empty, gstack) are skipped")
	g := skills["global/gate"]
	assert.True(t, g.ManualOnly)
	assert.Equal(t, "fork", g.Context)
	assert.Equal(t, "gate-runner", g.Agent)
	assert.Equal(t, "guarded", g.SideEffects)
	assert.Equal(t, "[repo]", g.ArgumentHint)
	assert.Equal(t, []string{"Bash"}, g.AllowedTools)
	assert.Equal(t, 12, g.Lines)
	assert.True(t, g.HasScripts)
	assert.False(t, g.HasReferences)
	assert.False(t, g.ThirdParty)
	assert.Empty(t, g.Symlink)
	b := skills["global/browse"]
	assert.True(t, b.ThirdParty)
	assert.Equal(t, filepath.Join(root, "skills", "gstack", "browse", "SKILL.md"), b.Symlink)
	tk := skills["svc/ticket"]
	assert.Equal(t, "ticket", tk.Name, "name falls back to the folder")
	assert.True(t, tk.HasReferences)
	assert.Equal(t, 1, tk.Lines)

	assert.ElementsMatch(t, []kitArchived{
		{Name: "old", Scope: kitGlobalScope, ScopePath: root},
		{Name: "gone", Scope: "svc", ScopePath: repo.Path},
	}, inv.Archived)
	assert.Equal(t, []kitRepo{repo}, inv.Repos, "a repo with no agents or skills is not listed")
}

func TestBuildKitEmpty(t *testing.T) {
	inv := buildKit(filepath.Join(realTemp(t), "nope"), nil)
	assert.NotNil(t, inv.Agents)
	assert.NotNil(t, inv.Skills)
	assert.NotNil(t, inv.Archived)
	assert.Empty(t, inv.Agents)
}

func TestKitRepoCandidates(t *testing.T) {
	base := realTemp(t)
	root := filepath.Join(base, ".claude")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "skills"), 0o755))
	ws := filepath.Join(base, "ws")
	require.NoError(t, os.MkdirAll(filepath.Join(ws, ".claude", "skills"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(ws, "a", ".claude", "agents"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(ws, "b"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(base, "top"), 0o755))

	got := kitRepoCandidates([]repoInfo{
		{Path: filepath.Join(ws, "a")}, {Path: filepath.Join(ws, "b")}, {Path: filepath.Join(base, "top")},
	}, root)
	assert.Equal(t, []kitRepo{{Name: "ws", Path: ws}, {Name: "a", Path: filepath.Join(ws, "a")}}, got,
		"workspace parent included once; repos without .claude and the global .claude's parent excluded")
}

func TestKitResolveAllowed(t *testing.T) {
	root, repo, base := kitFixture(t)
	roots := kitAllowedRoots(root, []kitRepo{repo})
	secret := filepath.Join(base, "home", "secret.txt")
	kitWrite(t, secret, "token")
	require.NoError(t, os.Symlink(secret, filepath.Join(root, "skills", "gate", "leak.md")))
	kitWrite(t, filepath.Join(root, "settings.json"), "{}")
	gstackReal := filepath.Join(root, "skills", "gstack", "browse", "SKILL.md")

	tests := []struct {
		name, path, want string
	}{
		{"global agent", filepath.Join(root, "agents", "reviewer.md"), filepath.Join(root, "agents", "reviewer.md")},
		{"agent memory", filepath.Join(root, "agent-memory", "reviewer", "MEMORY.md"), filepath.Join(root, "agent-memory", "reviewer", "MEMORY.md")},
		{"symlinked skill inside skills", filepath.Join(root, "skills", "browse", "SKILL.md"), gstackReal},
		{"project skill", filepath.Join(repo.Path, ".claude", "skills", "ticket", "SKILL.md"), filepath.Join(repo.Path, ".claude", "skills", "ticket", "SKILL.md")},
		{"project agent memory", filepath.Join(repo.Path, ".claude", "agent-memory", "seo", "MEMORY.md"), filepath.Join(repo.Path, ".claude", "agent-memory", "seo", "MEMORY.md")},
		{"dot-dot traversal", filepath.Join(root, "skills", "..", "settings.json"), ""},
		{"raw traversal string", root + "/agents/../../secret.txt", ""},
		{"symlink escaping the root", filepath.Join(root, "skills", "gate", "leak.md"), ""},
		{"outside file", secret, ""},
		{"relative path", "agents/reviewer.md", ""},
		{"empty", "", ""},
		{"directory", filepath.Join(root, "agents"), ""},
		{"root itself as file prefix trick", filepath.Join(root, "agents-evil.md"), ""},
		{"archived skill file not allowed", filepath.Join(root, "skills-archive", "old", "SKILL.md"), ""},
		{"missing", filepath.Join(root, "agents", "nope.md"), ""},
	}
	kitWrite(t, filepath.Join(root, "agents-evil.md"), "x")
	kitWrite(t, filepath.Join(root, "skills-archive", "old", "SKILL.md"), "archived")
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { assert.Equal(t, tc.want, kitResolveAllowed(tc.path, roots)) })
	}
}

const sampleAudit = `skill-audit: 3 skills (2 Claude can invoke, 1 manual only) in /h/.claude/skills, /r/.claude/skills
FAIL user/ship                         has side effects (commit/push/cloud/DB writes) but Claude can run it on its own; add disable-model-invocation: true
WARN project/ticket-start              description too short to choose by
WARN user/browse (3rd)                 512 lines (standard: under 500; move detail into reference files) [third-party: can't fix locally; hooks still apply]
WARN design                            description overlaps with impeccable (41%); triggers may collide
WARN user/a-very-long-skill-name-that-overflows-pad hardcoded user path; read it from config instead
noise line
RESULT: FAIL (1 fail, 4 warn)
`

func TestParseSkillAudit(t *testing.T) {
	r := parseSkillAudit(sampleAudit)
	assert.Equal(t, "FAIL", r.Result)
	assert.Equal(t, "RESULT: FAIL (1 fail, 4 warn)", r.Summary)
	assert.True(t, strings.HasPrefix(r.Header, "skill-audit: 3 skills"))
	require.Len(t, r.Findings, 5)
	assert.Equal(t, kitFinding{Skill: "ship", Scope: "user", Level: "fail", Message: "has side effects (commit/push/cloud/DB writes) but Claude can run it on its own; add disable-model-invocation: true"}, r.Findings[0])
	assert.Equal(t, kitFinding{Skill: "ticket-start", Scope: "project", Level: "warn", Message: "description too short to choose by"}, r.Findings[1])
	assert.Equal(t, "browse", r.Findings[2].Skill)
	assert.True(t, r.Findings[2].ThirdParty)
	assert.Equal(t, kitFinding{Skill: "design", Level: "warn", Message: "description overlaps with impeccable (41%); triggers may collide"}, r.Findings[3])
	assert.Equal(t, "a-very-long-skill-name-that-overflows-pad", r.Findings[4].Skill)

	pass := parseSkillAudit("skill-audit: 0 skills\nRESULT: PASS (0 fail, 0 warn)\n")
	assert.Equal(t, "PASS", pass.Result)
	assert.Empty(t, pass.Findings)
	assert.NotNil(t, pass.Findings)
}

func TestRunSkillAudit(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	tests := []struct {
		name    string
		script  string // "" = no script installed
		timeout time.Duration
		check   func(t *testing.T, r kitAuditResult, repoSkills string)
	}{
		{"missing script", "", time.Second, func(t *testing.T, r kitAuditResult, _ string) {
			assert.Contains(t, r.Error, "not found")
		}},
		{"fail exit still parsed and gets every skills root", "import sys\nprint('skill-audit: roots ' + ' '.join(sys.argv[1:]))\nprint('FAIL user/x  bad')\nprint('RESULT: FAIL (1 fail, 0 warn)')\nsys.exit(1)\n", 10 * time.Second, func(t *testing.T, r kitAuditResult, repoSkills string) {
			assert.Empty(t, r.Error)
			assert.Equal(t, "FAIL", r.Result)
			require.Len(t, r.Findings, 1)
			assert.Contains(t, r.Header, repoSkills)
			assert.NotZero(t, r.RanAt)
		}},
		{"crash reports stderr", "import sys\nsys.stderr.write('boom')\nsys.exit(2)\n", 10 * time.Second, func(t *testing.T, r kitAuditResult, _ string) {
			assert.Equal(t, "boom", r.Error)
		}},
		{"timeout", "import time\ntime.sleep(5)\n", 300 * time.Millisecond, func(t *testing.T, r kitAuditResult, _ string) {
			assert.Contains(t, r.Error, "timed out")
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			base := realTemp(t)
			root := filepath.Join(base, ".claude")
			require.NoError(t, os.MkdirAll(filepath.Join(root, "skills"), 0o755))
			repo := kitRepo{Name: "r", Path: filepath.Join(base, "r")}
			repoSkills := filepath.Join(repo.Path, ".claude", "skills")
			require.NoError(t, os.MkdirAll(repoSkills, 0o755))
			if tc.script != "" {
				kitWrite(t, kitAuditScript(root), tc.script)
			}
			tc.check(t, runSkillAudit(root, []kitRepo{repo, {Name: "none", Path: filepath.Join(base, "none")}}, tc.timeout), repoSkills)
		})
	}
}
