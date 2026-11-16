package main

import (
	"bufio"
	"bytes"
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
	"gopkg.in/yaml.v3"
)

// The Agents & Skills page: a read-only inventory of the user's Claude Code
// subagents (~/.claude/agents, <repo>/.claude/agents) and skills
// (~/.claude/skills, <repo>/.claude/skills), plus an on-demand skill audit.
// Plugin agents and skills (~/.claude/plugins) are deliberately out of scope.

const (
	kitMaxMemFiles    = 10
	kitMemPreview     = 3000
	kitMaxFileBytes   = 512 << 10
	kitAuditTimeout   = 60 * time.Second
	kitGlobalScope    = "global"
	kitWriteScopeHook = "agent-write-scope"
)

type kitHook struct {
	Event   string `json:"event"`
	Matcher string `json:"matcher,omitempty"`
	Command string `json:"command"`
}

type kitMemFile struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"`
	Preview string `json:"preview"`
}

type kitAgent struct {
	Name            string       `json:"name"`
	Description     string       `json:"description"`
	Model           string       `json:"model,omitempty"`
	Effort          string       `json:"effort,omitempty"`
	Tools           []string     `json:"tools"`
	DisallowedTools []string     `json:"disallowedTools,omitempty"`
	Memory          string       `json:"memory,omitempty"`
	Color           string       `json:"color,omitempty"`
	Skills          []string     `json:"skills"`
	Hooks           []kitHook    `json:"hooks"`
	ReadOnly        bool         `json:"readOnly"`
	WriteScope      string       `json:"writeScope,omitempty"` // the write-scope hook command, if one limits its writes
	Scope           string       `json:"scope"`
	ScopePath       string       `json:"scopePath"`
	Path            string       `json:"path"`
	Mtime           int64        `json:"mtime"`
	MemoryDir       string       `json:"memoryDir,omitempty"`
	MemoryFiles     []kitMemFile `json:"memoryFiles"`
}

type kitSkill struct {
	Name          string   `json:"name"`
	Dir           string   `json:"dir"`
	Description   string   `json:"description"`
	ArgumentHint  string   `json:"argumentHint,omitempty"`
	ManualOnly    bool     `json:"manualOnly"`
	Context       string   `json:"context,omitempty"`
	Agent         string   `json:"agent,omitempty"`
	AllowedTools  []string `json:"allowedTools"`
	SideEffects   string   `json:"sideEffects,omitempty"`
	Lines         int      `json:"lines"`
	HasScripts    bool     `json:"hasScripts"`
	HasReferences bool     `json:"hasReferences"`
	Symlink       string   `json:"symlink,omitempty"` // resolved target when the skill dir or SKILL.md is a symlink
	ThirdParty    bool     `json:"thirdParty"`
	Scope         string   `json:"scope"`
	ScopePath     string   `json:"scopePath"`
	Path          string   `json:"path"`
	Mtime         int64    `json:"mtime"`
}

type kitArchived struct {
	Name      string `json:"name"`
	Scope     string `json:"scope"`
	ScopePath string `json:"scopePath"`
}

type kitRepo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type kitInventory struct {
	Home     string        `json:"home"`
	Agents   []kitAgent    `json:"agents"`
	Skills   []kitSkill    `json:"skills"`
	Archived []kitArchived `json:"archived"`
	Repos    []kitRepo     `json:"repos"` // repos that contributed at least one agent or skill
}

// ---------- frontmatter ----------

// strList accepts both YAML forms used for tool and skill lists: a
// comma-separated string ("Read, Grep") or a sequence.
type strList []string

func (s *strList) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.SequenceNode:
		var xs []string
		if err := n.Decode(&xs); err != nil {
			return err
		}
		*s = cleanList(xs)
	case yaml.ScalarNode:
		*s = splitList(n.Value)
	}
	return nil
}

func splitList(v string) []string {
	v = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(v), "["), "]") // flow list in the fallback parser
	return cleanList(strings.FieldsFunc(v, func(r rune) bool { return r == ',' }))
}

func cleanList(xs []string) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if x = strings.Trim(strings.TrimSpace(x), `"'`); x != "" {
			out = append(out, x)
		}
	}
	return out
}

type kitHookGroup struct {
	Matcher string `yaml:"matcher"`
	Hooks   []struct {
		Type    string `yaml:"type"`
		Command string `yaml:"command"`
	} `yaml:"hooks"`
}

type kitFront struct {
	Name            string                    `yaml:"name"`
	Description     string                    `yaml:"description"`
	Model           string                    `yaml:"model"`
	Effort          string                    `yaml:"effort"`
	Tools           strList                   `yaml:"tools"`
	DisallowedTools strList                   `yaml:"disallowedTools"`
	Memory          string                    `yaml:"memory"`
	Color           string                    `yaml:"color"`
	Skills          strList                   `yaml:"skills"`
	Hooks           map[string][]kitHookGroup `yaml:"hooks"`
	ArgumentHint    string                    `yaml:"argument-hint"`
	DisableModel    string                    `yaml:"disable-model-invocation"`
	Context         string                    `yaml:"context"`
	Agent           string                    `yaml:"agent"`
	AllowedTools    strList                   `yaml:"allowed-tools"`
	SideEffects     string                    `yaml:"x-side-effects"`
}

// splitFrontmatter returns the YAML between the leading "---" fences and the
// body after them. A file without frontmatter is all body.
func splitFrontmatter(text string) (front, body string) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return "", text
	}
	rest := text[4:]
	if strings.HasPrefix(rest, "---\n") {
		return "", rest[4:]
	}
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", text
	}
	front = rest[:end]
	body = rest[end+4:]
	if nl := strings.IndexByte(body, '\n'); nl >= 0 {
		body = body[nl+1:]
	} else {
		body = ""
	}
	return front, body
}

var kitKeyRe = regexp.MustCompile(`^([A-Za-z_-]+):\s*(.*)$`)

// parseFront decodes frontmatter as YAML. Many hand-written skill descriptions
// are not valid YAML (an unquoted ": " inside a plain scalar), so on a decode
// error it falls back to the same line-based reading Claude Code tolerates:
// "key: value" with indented continuation lines and "- item" lists.
func parseFront(front string) kitFront {
	var f kitFront
	if front == "" {
		return f
	}
	if err := yaml.Unmarshal([]byte(front), &f); err == nil {
		return f
	}
	f = kitFront{}
	vals := map[string]string{}
	lists := map[string][]string{}
	key := ""
	for _, line := range strings.Split(front, "\n") {
		if m := kitKeyRe.FindStringSubmatch(line); m != nil {
			key = m[1]
			vals[key] = strings.Trim(strings.TrimSpace(m[2]), `"'`)
			continue
		}
		t := strings.TrimSpace(line)
		if key == "" || t == "" || (line[0] != ' ' && line[0] != '\t') {
			continue
		}
		if strings.HasPrefix(t, "- ") {
			lists[key] = append(lists[key], strings.Trim(strings.TrimSpace(t[2:]), `"'`))
			continue
		}
		vals[key] = strings.TrimSpace(vals[key] + " " + t)
	}
	list := func(k string) strList {
		if l, ok := lists[k]; ok {
			return cleanList(l)
		}
		return splitList(vals[k])
	}
	desc := vals["description"]
	if desc == ">" || desc == "|" || desc == ">-" || desc == "|-" {
		desc = ""
	}
	f.Name, f.Description, f.Model, f.Effort = vals["name"], desc, vals["model"], vals["effort"]
	f.Memory, f.Color, f.ArgumentHint = vals["memory"], vals["color"], vals["argument-hint"]
	f.DisableModel, f.Context, f.Agent, f.SideEffects = vals["disable-model-invocation"], vals["context"], vals["agent"], vals["x-side-effects"]
	f.Tools, f.DisallowedTools, f.Skills, f.AllowedTools = list("tools"), list("disallowedTools"), list("skills"), list("allowed-tools")
	return f
}

// ---------- agents ----------

var kitWriteTools = map[string]bool{"Write": true, "Edit": true, "MultiEdit": true, "NotebookEdit": true}

// agentReadOnly: an agent with no tools list inherits every tool, so it can
// write; otherwise it is read-only when none of its tools edit files.
func agentReadOnly(tools, disallowed []string) bool {
	if len(tools) == 0 {
		blocked := map[string]bool{}
		for _, d := range disallowed {
			blocked[d] = true
		}
		for t := range kitWriteTools {
			if !blocked[t] {
				return false
			}
		}
		return true
	}
	for _, t := range tools {
		if kitWriteTools[t] || t == "*" {
			return false
		}
	}
	return true
}

func scanAgents(dir, scope, scopePath, memRoot string) []kitAgent {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []kitAgent
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		st, err := os.Stat(p)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		front, _ := splitFrontmatter(string(b))
		f := parseFront(front)
		a := kitAgent{
			Name: f.Name, Description: f.Description, Model: f.Model, Effort: f.Effort,
			Tools: nonNil(f.Tools), DisallowedTools: f.DisallowedTools, Memory: f.Memory, Color: f.Color,
			Skills: nonNil(f.Skills), Hooks: []kitHook{}, Scope: scope, ScopePath: scopePath,
			Path: p, Mtime: st.ModTime().UnixMilli(), MemoryFiles: []kitMemFile{},
		}
		if a.Name == "" {
			a.Name = strings.TrimSuffix(e.Name(), ".md")
		}
		events := make([]string, 0, len(f.Hooks))
		for ev := range f.Hooks {
			events = append(events, ev)
		}
		sort.Strings(events)
		for _, ev := range events {
			for _, g := range f.Hooks[ev] {
				for _, h := range g.Hooks {
					if h.Command == "" {
						continue
					}
					a.Hooks = append(a.Hooks, kitHook{Event: ev, Matcher: g.Matcher, Command: h.Command})
					if strings.Contains(h.Command, kitWriteScopeHook) && a.WriteScope == "" {
						a.WriteScope = h.Command
					}
				}
			}
		}
		a.ReadOnly = agentReadOnly(f.Tools, f.DisallowedTools)
		if a.Memory != "" && memRoot != "" && kitSafeName(a.Name) {
			a.MemoryDir = filepath.Join(memRoot, a.Name)
			a.MemoryFiles = readMemFiles(a.MemoryDir)
		}
		out = append(out, a)
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// readMemFiles lists up to kitMaxMemFiles regular files in an agent's memory
// folder, MEMORY.md first then newest, each with a bounded preview.
func readMemFiles(dir string) []kitMemFile {
	out := []kitMemFile{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		st, err := os.Lstat(p) // a symlinked memory file could point anywhere; never preview it
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		out = append(out, kitMemFile{Name: e.Name(), Path: p, Size: st.Size(), Mtime: st.ModTime().UnixMilli()})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Name == "MEMORY.md") != (out[j].Name == "MEMORY.md") {
			return out[i].Name == "MEMORY.md"
		}
		return out[i].Mtime > out[j].Mtime
	})
	if len(out) > kitMaxMemFiles {
		out = out[:kitMaxMemFiles]
	}
	for i := range out {
		out[i].Preview = readPrefix(out[i].Path, kitMemPreview)
	}
	return out
}

// readPrefix reads at most n bytes and trims a trailing partial UTF-8 rune.
func readPrefix(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, n)
	k, _ := f.Read(buf)
	return strings.ToValidUTF8(string(buf[:k]), "")
}

// ---------- skills ----------

func scanSkills(root, scope, scopePath string) []kitSkill {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []kitSkill
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		p := filepath.Join(dir, "SKILL.md")
		st, err := os.Stat(p) // follows symlinks
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		real, _ := filepath.EvalSymlinks(p)
		s := kitSkill{Dir: e.Name(), Scope: scope, ScopePath: scopePath, Path: p, Mtime: st.ModTime().UnixMilli(), AllowedTools: []string{}}
		if real != "" && real != p && (isLink(dir) || isLink(p)) {
			s.Symlink = real
		}
		s.ThirdParty = strings.Contains(strings.ToLower(real), "gstack") || strings.Contains(strings.ToLower(p), "gstack")
		front, _ := splitFrontmatter(string(b))
		f := parseFront(front)
		s.Name, s.Description, s.ArgumentHint = f.Name, f.Description, f.ArgumentHint
		if s.Name == "" {
			s.Name = e.Name()
		}
		s.ManualOnly = strings.EqualFold(strings.TrimSpace(f.DisableModel), "true")
		s.Context, s.Agent, s.SideEffects = f.Context, f.Agent, f.SideEffects
		s.AllowedTools = nonNil(f.AllowedTools)
		s.Lines = bytes.Count(b, []byte("\n"))
		if len(b) > 0 && b[len(b)-1] != '\n' {
			s.Lines++
		}
		s.HasScripts = isDir(filepath.Join(dir, "scripts"))
		s.HasReferences = isDir(filepath.Join(dir, "references"))
		out = append(out, s)
	}
	return out
}

func isLink(p string) bool {
	st, err := os.Lstat(p)
	return err == nil && st.Mode()&os.ModeSymlink != 0
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func scanArchived(root, scope, scopePath string) []kitArchived {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []kitArchived
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || !isDir(filepath.Join(root, e.Name())) {
			continue
		}
		out = append(out, kitArchived{Name: e.Name(), Scope: scope, ScopePath: scopePath})
	}
	return out
}

// ---------- inventory ----------

// kitRepoCandidates turns discovered git repos into the directories whose
// .claude folder is scanned. The parent of each repo is included too, so a
// workspace folder that holds several repos and its own .claude (not itself a
// git repo) still shows its project agents and skills. The global .claude's
// parent (home) is excluded so global entries never appear twice.
func kitRepoCandidates(repos []repoInfo, claudeRoot string) []kitRepo {
	homeOfClaude := filepath.Dir(claudeRoot)
	seen := map[string]bool{homeOfClaude: true}
	var out []kitRepo
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		if isDir(kitRepoSub(p, "agents")) || isDir(kitRepoSub(p, "skills")) || isDir(kitRepoSub(p, "skills-archive")) {
			out = append(out, kitRepo{Name: filepath.Base(p), Path: p})
		}
	}
	for _, r := range repos {
		add(r.Path)
		add(filepath.Dir(r.Path))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func buildKit(claudeRoot string, repos []kitRepo) kitInventory {
	inv := kitInventory{Home: claudeRoot, Agents: []kitAgent{}, Skills: []kitSkill{}, Archived: []kitArchived{}, Repos: []kitRepo{}}
	inv.Agents = append(inv.Agents, scanAgents(filepath.Join(claudeRoot, "agents"), kitGlobalScope, claudeRoot, filepath.Join(claudeRoot, "agent-memory"))...)
	inv.Skills = append(inv.Skills, scanSkills(filepath.Join(claudeRoot, "skills"), kitGlobalScope, claudeRoot)...)
	inv.Archived = append(inv.Archived, scanArchived(filepath.Join(claudeRoot, "skills-archive"), kitGlobalScope, claudeRoot)...)
	for _, r := range repos {
		ag := scanAgents(kitRepoSub(r.Path, "agents"), r.Name, r.Path, "")
		// project-scoped agent memory lives in the repo; user-scoped stays global.
		// The agent name comes from repo-controlled frontmatter, so it must be a
		// plain folder name and the repo memory folder must not be a symlink.
		for i := range ag {
			if ag[i].Memory == "" || !kitSafeName(ag[i].Name) {
				continue
			}
			switch ag[i].Memory {
			case "project":
				ag[i].MemoryDir = kitRepoSub(r.Path, "agent-memory", ag[i].Name)
			case "local":
				ag[i].MemoryDir = kitRepoSub(r.Path, "agent-memory-local", ag[i].Name)
			default:
				ag[i].MemoryDir = filepath.Join(claudeRoot, "agent-memory", ag[i].Name)
			}
			if ag[i].MemoryDir != "" {
				ag[i].MemoryFiles = readMemFiles(ag[i].MemoryDir)
			}
		}
		sk := scanSkills(kitRepoSub(r.Path, "skills"), r.Name, r.Path)
		ar := scanArchived(kitRepoSub(r.Path, "skills-archive"), r.Name, r.Path)
		if len(ag)+len(sk)+len(ar) > 0 {
			inv.Repos = append(inv.Repos, r)
		}
		inv.Agents = append(inv.Agents, ag...)
		inv.Skills = append(inv.Skills, sk...)
		inv.Archived = append(inv.Archived, ar...)
	}
	return inv
}

// kitAllowedRoots are the only directories /api/kit/file may read from.
func kitAllowedRoots(claudeRoot string, repos []kitRepo) []string {
	roots := []string{
		filepath.Join(claudeRoot, "agents"),
		filepath.Join(claudeRoot, "skills"),
		filepath.Join(claudeRoot, "agent-memory"),
	}
	for _, r := range repos {
		for _, sub := range []string{"agents", "skills", "agent-memory", "agent-memory-local"} {
			if d := kitRepoSub(r.Path, sub); d != "" {
				roots = append(roots, d)
			}
		}
	}
	return roots
}

// kitRepoSub returns <repo>/.claude/<parts...>, or "" when .claude or any part
// below it is a symlink. A cloned repo is untrusted: a committed link such as
// .claude/skills -> / would otherwise widen the file allowlist to the whole disk.
func kitRepoSub(repo string, parts ...string) string {
	p := filepath.Join(repo, ".claude")
	if isLink(p) {
		return ""
	}
	for _, part := range parts {
		p = filepath.Join(p, part)
		if isLink(p) {
			return ""
		}
	}
	return p
}

// kitSafeName reports whether n is a single plain path element, so it can be
// joined under a memory folder without escaping it.
func kitSafeName(n string) bool {
	return n != "" && n != "." && n != ".." && !strings.ContainsAny(n, `/\`) && filepath.Base(n) == n
}

// kitResolveAllowed returns the symlink-resolved path when p is a regular file
// inside one of roots (each root also symlink-resolved); "" otherwise.
func kitResolveAllowed(p string, roots []string) string {
	if p == "" || !filepath.IsAbs(p) {
		return ""
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(p))
	if err != nil {
		return ""
	}
	st, err := os.Stat(real)
	if err != nil || !st.Mode().IsRegular() {
		return ""
	}
	for _, root := range roots {
		rr, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(rr, real)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			continue
		}
		return real
	}
	return ""
}

var (
	kitReposMu   sync.Mutex
	kitLastRepos []kitRepo
	kitReposSet  bool
)

func kitRepos(refresh bool) []kitRepo {
	kitReposMu.Lock()
	defer kitReposMu.Unlock()
	if refresh || !kitReposSet {
		kitLastRepos = kitRepoCandidates(discoverRepos(), claudeDir())
		kitReposSet = true
	}
	return kitLastRepos
}

func handleKit(ctx *gofr.Context) (any, error) {
	return rawJSON(buildKit(claudeDir(), kitRepos(true)))
}

func handleKitFile(ctx *gofr.Context) (any, error) {
	p := ctx.Param("path")
	real := kitResolveAllowed(p, kitAllowedRoots(claudeDir(), kitRepos(false)))
	if real == "" {
		return nil, errf(http.StatusForbidden, "path is not an agent, skill or agent-memory file")
	}
	b, err := os.ReadFile(real)
	if err != nil {
		return nil, errf(http.StatusNotFound, "cannot read file")
	}
	if len(b) > kitMaxFileBytes {
		return nil, errf(http.StatusRequestEntityTooLarge, "file too large to display")
	}
	return rawJSON(map[string]any{"path": p, "resolved": real, "size": len(b), "content": strings.ToValidUTF8(string(b), "\uFFFD")})
}

// ---------- skill audit ----------

type kitFinding struct {
	Skill      string `json:"skill"`
	Scope      string `json:"scope"` // "user", "project", or "" for cross-skill findings
	ThirdParty bool   `json:"thirdParty"`
	Level      string `json:"level"` // fail | warn
	Message    string `json:"message"`
}

type kitAuditResult struct {
	Running  bool         `json:"running"`
	RanAt    int64        `json:"ranAt"`
	Seconds  float64      `json:"seconds"`
	Header   string       `json:"header"`
	Summary  string       `json:"summary"`
	Result   string       `json:"result"` // PASS | FAIL | ""
	Findings []kitFinding `json:"findings"`
	Error    string       `json:"error,omitempty"`
}

var (
	kitAuditMu   sync.Mutex
	kitAuditLast = kitAuditResult{Findings: []kitFinding{}}
)

var (
	kitFindingRe = regexp.MustCompile(`^(FAIL|WARN)\s+((?:user|project)/\S+?(?: \(3rd\))?|\S+)\s{1,}(.*)$`)
	kitResultRe  = regexp.MustCompile(`^RESULT:\s*(PASS|FAIL)\b`)
)

// parseSkillAudit reads skill_audit.py's text report: a "skill-audit:" header,
// one "LEVEL who message" row per finding, and a "RESULT:" summary line.
func parseSkillAudit(out string) kitAuditResult {
	r := kitAuditResult{Findings: []kitFinding{}}
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t")
		switch {
		case strings.HasPrefix(line, "skill-audit:"):
			r.Header = line
		case kitResultRe.MatchString(line):
			r.Summary = line
			r.Result = kitResultRe.FindStringSubmatch(line)[1]
		default:
			m := kitFindingRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			who := m[2]
			f := kitFinding{Level: strings.ToLower(m[1]), Message: strings.TrimSpace(m[3])}
			if strings.HasSuffix(who, " (3rd)") {
				f.ThirdParty = true
				who = strings.TrimSuffix(who, " (3rd)")
			}
			if i := strings.IndexByte(who, '/'); i > 0 {
				f.Scope, f.Skill = who[:i], who[i+1:]
			} else {
				f.Skill = who
			}
			r.Findings = append(r.Findings, f)
		}
	}
	return r
}

func kitAuditScript(claudeRoot string) string {
	return filepath.Join(claudeRoot, "skills", "skill-audit", "scripts", "skill_audit.py")
}

// runSkillAudit runs the audit script over the global skills dir plus every
// project skills dir that exists. Exit status 1 just means a FAIL finding.
func runSkillAudit(claudeRoot string, repos []kitRepo, timeout time.Duration) kitAuditResult {
	start := time.Now()
	script := kitAuditScript(claudeRoot)
	if _, err := os.Stat(script); err != nil {
		return kitAuditResult{Findings: []kitFinding{}, RanAt: start.UnixMilli(), Error: "skill-audit script not found at " + script}
	}
	args := []string{script, filepath.Join(claudeRoot, "skills")}
	for _, r := range repos {
		if d := filepath.Join(r.Path, ".claude", "skills"); isDir(d) {
			args = append(args, d)
		}
	}
	c, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(c, "python3", args...)
	cmd.Dir = claudeRoot
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	res := parseSkillAudit(stdout.String())
	res.RanAt = start.UnixMilli()
	res.Seconds = time.Since(start).Seconds()
	switch {
	case c.Err() == context.DeadlineExceeded:
		res.Error = "skill audit timed out after " + timeout.String()
	case err != nil && res.Summary == "":
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		res.Error = msg
	}
	return res
}

func kitAuditSnapshot() kitAuditResult {
	kitAuditMu.Lock()
	defer kitAuditMu.Unlock()
	return kitAuditLast
}

// handleKitAuditRun starts the audit in the background (one at a time) and
// returns the current state; the page polls GET /api/kit/audit for the result.
func handleKitAuditRun(ctx *gofr.Context) (any, error) {
	kitAuditMu.Lock()
	if kitAuditLast.Running {
		snap := kitAuditLast
		kitAuditMu.Unlock()
		return rawJSON(snap)
	}
	kitAuditLast.Running = true
	snap := kitAuditLast
	kitAuditMu.Unlock()
	root, repos := claudeDir(), kitRepos(false)
	go func() {
		res := runSkillAudit(root, repos, kitAuditTimeout)
		kitAuditMu.Lock()
		kitAuditLast = res
		kitAuditMu.Unlock()
	}()
	return rawJSON(snap)
}

func handleKitAuditGet(ctx *gofr.Context) (any, error) {
	return rawJSON(kitAuditSnapshot())
}
