package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
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

// The Guardrails page shows what keeps Claude safe and honest on this Mac: the
// user's own hook scripts, permission rules, the per-repo "done" gate, the hook
// self-tests and the morning brief job. It reads the user's Claude setup and
// never rewrites it; the only writes are the per-repo gate-off marker file and
// background runs of the user's own gate / self-test scripts.

// Overridable in tests so no test ever runs the real gate or reads the real home.
var (
	gateScriptPath  = func() string { return filepath.Join(claudeDir(), "skills", "gate", "scripts", "gate.sh") }
	selftestScripts = func() []string {
		d := filepath.Join(claudeDir(), "hooks", "tests")
		return []string{filepath.Join(d, "guard_test.sh"), filepath.Join(d, "agent_hooks_test.sh")}
	}
	briefsDir        = func() string { return filepath.Join(claudeDir(), "state", "briefs") }
	morningPlistPath = func() string {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "LaunchAgents", morningBriefLabel+".plist")
	}
	launchctlList = func() (string, error) {
		out, err := execWithTimeout("launchctl", 5*time.Second, "list")
		return string(out), err
	}
	guardrailRepoList = discoverGuardrailRepos
	gateTimeout       = 30 * time.Minute
	selftestTimeout   = 120 * time.Second
)

const (
	morningBriefLabel = "dev.local.claude.morning-brief"
	gateOutputLines   = 400
	gateOffFile       = "gate-off"
)

// ---- response shapes --------------------------------------------------------

type grHook struct {
	Event      string `json:"event"`
	Matcher    string `json:"matcher"`
	Command    string `json:"command"`
	Timeout    int    `json:"timeout,omitempty"`
	Source     string `json:"source"` // global | global-local | repo | repo-local
	Repo       string `json:"repo,omitempty"`
	File       string `json:"file"`
	Script     string `json:"script,omitempty"` // resolved script path, "" for an inline command
	Exists     bool   `json:"exists"`
	Executable bool   `json:"executable"`
	Health     string `json:"health"` // ok | missing | not-executable | inline
	Purpose    string `json:"purpose,omitempty"`
	Rook       bool   `json:"rook"` // rook's own bridge entry
}

type grConflict struct {
	Event        string   `json:"event"`
	RookMatcher  string   `json:"rookMatcher"`
	UserMatchers []string `json:"userMatchers"`
	UserCommands []string `json:"userCommands"`
	Severity     string   `json:"severity"` // warn | info
	Note         string   `json:"note"`
}

type grFlag struct {
	List    string `json:"list"`
	Index   int    `json:"index"` // 1-based position in that list
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type grPermSet struct {
	Source string   `json:"source"` // global | global-local | repo | repo-local
	Repo   string   `json:"repo,omitempty"`
	File   string   `json:"file"`
	Local  bool     `json:"local"` // settings.local.json: counts only, never the entries
	Allow  []string `json:"allow,omitempty"`
	Ask    []string `json:"ask,omitempty"`
	Deny   []string `json:"deny,omitempty"`
	AllowN int      `json:"allowCount"`
	AskN   int      `json:"askCount"`
	DenyN  int      `json:"denyCount"`
	Flags  []grFlag `json:"flags,omitempty"`
	Error  string   `json:"error,omitempty"`
}

type gateRun struct {
	Repo       string `json:"repo"`
	Status     string `json:"status"` // running | pass | fail | nothing | error
	ExitCode   int    `json:"exitCode"`
	Output     string `json:"output"`
	TotalLines int    `json:"totalLines"`
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

type grGateRepo struct {
	Path    string   `json:"path"`
	Name    string   `json:"name"`
	Branch  string   `json:"branch"`
	Dirty   int      `json:"dirty"`
	GateOff bool     `json:"gateOff"`
	Last    *gateRun `json:"last,omitempty"`
}

type grBrief struct {
	Date    string `json:"date"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
}

type grMorning struct {
	Label       string    `json:"label"`
	Loaded      bool      `json:"loaded"`
	Running     bool      `json:"running"`
	LastExit    string    `json:"lastExit,omitempty"`
	PlistPath   string    `json:"plistPath"`
	PlistExists bool      `json:"plistExists"`
	Schedule    string    `json:"schedule,omitempty"`
	Program     string    `json:"program,omitempty"`
	Dir         string    `json:"dir"`
	Briefs      []grBrief `json:"briefs"`
}

type grStatusline struct {
	Command    string `json:"command"`
	Script     string `json:"script,omitempty"`
	Exists     bool   `json:"exists"`
	Executable bool   `json:"executable"`
	Purpose    string `json:"purpose,omitempty"`
}

type grRook struct {
	Installed  bool `json:"installed"`
	Gate       bool `json:"gate"`
	AutoVerify bool `json:"autoVerify"`
	AutoReview bool `json:"autoReview"`
}

type guardrailsResp struct {
	Hooks        []grHook      `json:"hooks"`
	Conflicts    []grConflict  `json:"conflicts"`
	Permissions  []grPermSet   `json:"permissions"`
	Gate         []grGateRepo  `json:"gate"`
	GateScript   string        `json:"gateScript"`
	GateScriptOK bool          `json:"gateScriptOk"`
	Morning      grMorning     `json:"morning"`
	Statusline   *grStatusline `json:"statusline,omitempty"`
	Rook         grRook        `json:"rook"`
	RepoCount    int           `json:"repoCount"`
	Errors       []string      `json:"errors,omitempty"`
}

// ---- repo discovery ---------------------------------------------------------

// discoverGuardrailRepos reuses the launcher's repo discovery and adds a
// one-level scan of the repoRoots listed in ~/.rook/config.json, since
// discovery alone only looks one level under common parents.
func discoverGuardrailRepos() []repoInfo {
	seen := map[string]bool{}
	var out []repoInfo
	add := func(p string) {
		p = filepath.Clean(p)
		if seen[p] || !isGitRepo(p) || strings.Contains(p, string(filepath.Separator)+".rook"+string(filepath.Separator)) {
			return
		}
		seen[p] = true
		out = append(out, repoInfo{Path: p, Name: filepath.Base(p)})
	}
	for _, r := range discoverRepos() {
		add(r.Path)
	}
	for _, root := range configRepoRoots() {
		add(root)
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				add(filepath.Join(root, e.Name()))
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	if len(out) > 300 {
		out = out[:300]
	}
	return out
}

// configRepoRoots reads repoRoots straight from the config file so this page
// does not depend on the Config struct carrying the field.
func configRepoRoots() []string {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return nil
	}
	var raw struct {
		RepoRoots []string `json:"repoRoots"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return nil
	}
	home, _ := os.UserHomeDir()
	var out []string
	for _, r := range raw.RepoRoots {
		r = strings.TrimSpace(r)
		if r == "~" {
			r = home
		} else if strings.HasPrefix(r, "~/") {
			r = filepath.Join(home, r[2:])
		}
		if r != "" && filepath.IsAbs(r) {
			out = append(out, filepath.Clean(r))
		}
	}
	return out
}

// ---- settings parsing -------------------------------------------------------

type claudeSettings struct {
	Hooks       map[string][]hookGroup `json:"hooks"`
	Permissions struct {
		Allow []string `json:"allow"`
		Ask   []string `json:"ask"`
		Deny  []string `json:"deny"`
	} `json:"permissions"`
	StatusLine *struct {
		Command string `json:"command"`
	} `json:"statusLine"`
}

type hookGroup struct {
	Matcher string `json:"matcher"`
	Hooks   []struct {
		Type    string `json:"type"`
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	} `json:"hooks"`
}

// readSettingsFile returns (settings, exists, error).
func readSettingsFile(path string) (claudeSettings, bool, error) {
	var s claudeSettings
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, false, nil
		}
		return s, true, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return s, true, nil
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return s, true, fmt.Errorf("%s is not valid JSON: %v", path, err)
	}
	return s, true, nil
}

var interpreters = map[string]bool{"bash": true, "sh": true, "zsh": true, "python": true, "python3": true, "node": true, "ruby": true, "perl": true, "env": true}

// resolveHookScript finds the script file a hook command runs. viaInterp is
// true when the script is passed to an interpreter (so it need not be +x).
func resolveHookScript(command, projectDir string) (script string, viaInterp bool) {
	home, _ := os.UserHomeDir()
	expand := func(s string) string {
		s = strings.NewReplacer(`"`, "", "'", "").Replace(s)
		s = strings.NewReplacer("${HOME}", home, "$HOME", home, "${CLAUDE_PROJECT_DIR}", projectDir, "$CLAUDE_PROJECT_DIR", projectDir).Replace(s)
		if s == "~" {
			return home
		}
		if strings.HasPrefix(s, "~/") {
			return filepath.Join(home, s[2:])
		}
		return s
	}
	for _, tok := range strings.Fields(command) {
		t := expand(tok)
		if strings.Contains(t, "=") && !strings.Contains(t, "/") {
			continue // leading VAR=value
		}
		if interpreters[filepath.Base(t)] {
			viaInterp = true
			continue
		}
		if strings.HasPrefix(t, "-") {
			continue // interpreter flag
		}
		if !strings.Contains(t, "/") {
			return "", false // an inline command like `jq ...`
		}
		return t, viaInterp
	}
	return "", false
}

// scriptPurpose returns the first line of the script's leading `#` comment
// block (the shebang is skipped).
func scriptPurpose(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 8192)
	n, _ := io.ReadFull(f, buf)
	for i, ln := range strings.Split(string(buf[:n]), "\n") {
		t := strings.TrimSpace(ln)
		if i == 0 && strings.HasPrefix(t, "#!") {
			continue
		}
		if t == "" {
			continue
		}
		if !strings.HasPrefix(t, "#") {
			return ""
		}
		if p := strings.TrimSpace(strings.TrimLeft(t, "#")); p != "" {
			return clip(p, 200)
		}
	}
	return ""
}

func fileHealth(script string, viaInterp bool) (exists, executable bool, health string) {
	if script == "" {
		return false, false, "inline"
	}
	st, err := os.Stat(script)
	if err != nil || st.IsDir() {
		return false, false, "missing"
	}
	executable = st.Mode().Perm()&0o111 != 0
	if !executable && !viaInterp {
		return true, false, "not-executable"
	}
	return true, executable, "ok"
}

func hooksFromSettings(s claudeSettings, source, repo, file string) []grHook {
	events := make([]string, 0, len(s.Hooks))
	for ev := range s.Hooks {
		events = append(events, ev)
	}
	sort.Strings(events)
	var out []grHook
	for _, ev := range events {
		for _, g := range s.Hooks[ev] {
			for _, h := range g.Hooks {
				cmd := h.Command
				if h.Type != "" && h.Type != "command" {
					cmd = "(" + h.Type + " hook)"
				}
				if credentialKind(cmd) != "" {
					cmd = "(hidden: this command looks like it contains a credential)"
				}
				script, via := resolveHookScript(h.Command, repo)
				ex, x, health := fileHealth(script, via)
				hk := grHook{
					Event: ev, Matcher: g.Matcher, Command: cmd, Timeout: h.Timeout,
					Source: source, Repo: repo, File: file, Script: script,
					Exists: ex, Executable: x, Health: health,
					Rook: strings.Contains(h.Command, hookMarker),
				}
				if ex {
					hk.Purpose = scriptPurpose(script)
				}
				out = append(out, hk)
			}
		}
	}
	return out
}

// ---- conflicts --------------------------------------------------------------

var literalAltRe = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func matcherAlts(m string) ([]string, bool) {
	parts := strings.Split(m, "|")
	for _, p := range parts {
		if !literalAltRe.MatchString(p) {
			return nil, false
		}
	}
	return parts, true
}

// matchersOverlap reports whether two hook matchers can fire on the same tool
// call or event. Empty and "*" match everything; two regexes that cannot be
// compared are treated as overlapping (a possible double, shown as such).
func matchersOverlap(a, b string) bool {
	if a == "" || a == "*" || b == "" || b == "*" {
		return true
	}
	la, okA := matcherAlts(a)
	lb, okB := matcherAlts(b)
	switch {
	case okA && okB:
		for _, x := range la {
			for _, y := range lb {
				if x == y {
					return true
				}
			}
		}
		return false
	case okA:
		return anyMatches(b, la)
	case okB:
		return anyMatches(a, lb)
	}
	return true
}

func anyMatches(pattern string, names []string) bool {
	re, err := regexp.Compile("^(?:" + pattern + ")$")
	if err != nil {
		return true
	}
	for _, n := range names {
		if re.MatchString(n) {
			return true
		}
	}
	return false
}

// findConflicts pairs rook's bridge entries with the user's own hooks on the
// same event when their matchers overlap. It only reports; nothing is changed.
func findConflicts(hooks []grHook, rk grRook) []grConflict {
	out := []grConflict{}
	for _, r := range hooks {
		if !r.Rook {
			continue
		}
		c := grConflict{Event: r.Event, RookMatcher: r.Matcher}
		seenM := map[string]bool{}
		for _, u := range hooks {
			if u.Rook || u.Event != r.Event || !matchersOverlap(r.Matcher, u.Matcher) {
				continue
			}
			if !seenM[u.Matcher] {
				seenM[u.Matcher] = true
				c.UserMatchers = append(c.UserMatchers, u.Matcher)
			}
			c.UserCommands = append(c.UserCommands, u.Command)
		}
		if len(c.UserCommands) == 0 {
			continue
		}
		c.Severity, c.Note = conflictNote(r.Event, rk)
		out = append(out, c)
	}
	return out
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func conflictNote(event string, rk grRook) (string, string) {
	switch event {
	case "PreToolUse":
		return "warn", "Two gates decide on the same tool call: your hook and rook's danger gate (rook gate is " + onOff(rk.Gate) + "). Either one can deny, and each adds latency to every matching call."
	case "Stop":
		sev := "info"
		if rk.AutoVerify || rk.AutoReview {
			sev = "warn"
		}
		return sev, "Both run when a session stops. Your Stop hook (for example the gate) and rook's bridge, which starts rook's auto-verify (" + onOff(rk.AutoVerify) + ") and auto-review (" + onOff(rk.AutoReview) + "). With auto-verify on, build and tests can run twice."
	case "Notification":
		return "info", "One event can raise two notifications: yours and rook's."
	}
	return "info", "Both hooks run on this event."
}

// ---- credentials ------------------------------------------------------------

var credentialRules = []struct {
	re   *regexp.Regexp
	kind string
}{
	{regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`), "AWS access key"},
	{regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})`), "GitHub token"},
	{regexp.MustCompile(`\bsk-(ant-)?[A-Za-z0-9_-]{20,}`), "API key"},
	{regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), "Slack token"},
	{regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY`), "private key"},
	{regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}`), "bearer token"},
	{regexp.MustCompile(`(?i)[a-z_]*(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[a-z_]*\s*[=:]\s*['"]?[^\s'"*)$]{8,}`), "inline secret"},
}

var longTokenRe = regexp.MustCompile(`[A-Za-z0-9+/=_-]{24,}`)

// credentialKind returns a non-empty kind when s looks like it embeds a
// credential: a known key format, an inline secret assignment, or a long
// random-looking run (checked per path segment / assigned value, so file
// paths, UUIDs and identifiers made of short words do not trip it).
func credentialKind(s string) string {
	for _, r := range credentialRules {
		if r.re.MatchString(s) {
			return r.kind
		}
	}
	for _, tok := range longTokenRe.FindAllString(s, -1) {
		for _, seg := range strings.FieldsFunc(tok, func(r rune) bool { return r == '/' || r == '=' }) {
			if looksRandom(seg) {
				return "high-entropy string"
			}
		}
	}
	return ""
}

// looksRandom reports whether seg reads like a generated secret rather than a
// name: long, mixed case with several digits, high entropy, and not a chain
// of short words (kebab/snake identifiers, UUIDs, Claude project dir names).
func looksRandom(seg string) bool {
	if len(seg) < 24 || strings.Contains(seg, "__") {
		return false
	}
	var lo, up, dg int
	for _, r := range seg {
		switch {
		case r >= 'a' && r <= 'z':
			lo++
		case r >= 'A' && r <= 'Z':
			up++
		case r >= '0' && r <= '9':
			dg++
		}
	}
	if lo < 2 || up < 2 || dg < 2 {
		return false
	}
	chunks := strings.FieldsFunc(seg, func(r rune) bool { return r == '-' || r == '_' })
	if len(chunks) >= 3 {
		short := true
		for _, c := range chunks {
			if len(c) > 12 {
				short = false
				break
			}
		}
		if short {
			return false
		}
	}
	return entropy(seg) >= 3.8
}

func entropy(s string) float64 {
	freq := map[rune]float64{}
	for _, r := range s {
		freq[r]++
	}
	n := float64(len(s))
	var h float64
	for _, c := range freq {
		p := c / n
		h -= p * math.Log2(p)
	}
	return h
}

func permSetFrom(s claudeSettings, source, repo, file string, local bool) grPermSet {
	p := grPermSet{Source: source, Repo: repo, File: file, Local: local,
		AllowN: len(s.Permissions.Allow), AskN: len(s.Permissions.Ask), DenyN: len(s.Permissions.Deny)}
	for _, l := range []struct {
		name string
		list []string
	}{{"allow", s.Permissions.Allow}, {"ask", s.Permissions.Ask}, {"deny", s.Permissions.Deny}} {
		for i, e := range l.list {
			if k := credentialKind(e); k != "" {
				p.Flags = append(p.Flags, grFlag{List: l.name, Index: i + 1, Kind: k,
					Message: fmt.Sprintf("%s entry %d looks like a credential (%s)", l.name, i+1, k)})
			}
		}
	}
	if !local {
		p.Allow, p.Ask, p.Deny = s.Permissions.Allow, s.Permissions.Ask, s.Permissions.Deny
	}
	return p
}

// ---- gate runs --------------------------------------------------------------

var (
	gateMu   sync.Mutex
	gateRuns = map[string]*gateRun{}
)

// tailLines keeps the last max lines written to it (safe for concurrent use).
type tailLines struct {
	mu      sync.Mutex
	max     int
	lines   []string
	partial string
	total   int
}

func (t *tailLines) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.partial + string(p)
	parts := strings.Split(s, "\n")
	t.partial = parts[len(parts)-1]
	for _, ln := range parts[:len(parts)-1] {
		t.lines = append(t.lines, ln)
		t.total++
	}
	if len(t.lines) > t.max {
		t.lines = append([]string(nil), t.lines[len(t.lines)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailLines) String() (string, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	ls := t.lines
	total := t.total
	if t.partial != "" {
		ls = append(append([]string(nil), ls...), t.partial)
		total++
		if len(ls) > t.max {
			ls = ls[len(ls)-t.max:]
		}
	}
	return strings.Join(ls, "\n"), total
}

// runScript runs `bash script` in dir with a timeout, killing the whole process
// group on timeout so child go test / lint processes do not linger.
func runScript(script, dir string, timeout time.Duration, w io.Writer) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", script)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = w, w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return -1, fmt.Errorf("timed out after %s", timeout)
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func gateStatusFor(code int, err error) string {
	if err != nil {
		return "error"
	}
	switch code {
	case 0:
		return "pass"
	case 1:
		return "fail"
	case 2:
		return "nothing"
	}
	return "error"
}

// startGate starts the gate in repo in the background. It refuses a second run
// while one is in flight for the same repo.
func startGate(repo string) (*gateRun, error) {
	gateMu.Lock()
	if r := gateRuns[repo]; r != nil && r.Status == "running" {
		cp := *r
		gateMu.Unlock()
		return &cp, errf(http.StatusConflict, "the gate is already running in %s", filepath.Base(repo))
	}
	run := &gateRun{Repo: repo, Status: "running", StartedAt: time.Now().UnixMilli()}
	gateRuns[repo] = run
	gateMu.Unlock()

	tail := &tailLines{max: gateOutputLines}
	gateTails.Store(repo, tail)
	script := gateScriptPath()
	go func() {
		code, err := runScript(script, repo, gateTimeout, tail)
		out, total := tail.String()
		gateMu.Lock()
		defer gateMu.Unlock()
		run.ExitCode, run.Output, run.TotalLines = code, out, total
		run.Status = gateStatusFor(code, err)
		if err != nil {
			run.Error = err.Error()
		}
		run.FinishedAt = time.Now().UnixMilli()
		run.DurationMs = run.FinishedAt - run.StartedAt
		gateTails.Delete(repo)
	}()
	cp := *run
	return &cp, nil
}

// gateTails holds the live output writer of a running gate, so polls can show
// progress before it finishes.
var gateTails sync.Map

func gateSnapshot(repo string) *gateRun {
	gateMu.Lock()
	r := gateRuns[repo]
	if r == nil {
		gateMu.Unlock()
		return nil
	}
	cp := *r
	gateMu.Unlock()
	if cp.Status == "running" {
		if t, ok := gateTails.Load(repo); ok {
			cp.Output, cp.TotalLines = t.(*tailLines).String()
		}
		cp.DurationMs = time.Now().UnixMilli() - cp.StartedAt
	}
	return &cp
}

// ---- self-test --------------------------------------------------------------

type selftestScript struct {
	Script     string   `json:"script"`
	Name       string   `json:"name"`
	Missing    bool     `json:"missing,omitempty"`
	Pass       int      `json:"pass"`
	Fail       int      `json:"fail"`
	ExitCode   int      `json:"exitCode"`
	Failing    []string `json:"failing,omitempty"`
	Summary    string   `json:"summary,omitempty"`
	DurationMs int64    `json:"durationMs"`
	Error      string   `json:"error,omitempty"`
}

type selftestState struct {
	Status     string           `json:"status"` // none | running | pass | fail
	StartedAt  int64            `json:"startedAt,omitempty"`
	FinishedAt int64            `json:"finishedAt,omitempty"`
	Results    []selftestScript `json:"results"`
}

var (
	selftestMu  sync.Mutex
	selftestCur = selftestState{Status: "none"}
)

var summaryRe = regexp.MustCompile(`(\d+) passed, (\d+) failed`)

// parseSelftest counts `ok` / `FAIL` lines, preferring a trailing
// "N passed, M failed" summary when the script prints one.
func parseSelftest(out string) (pass, fail int, failing []string, summary string) {
	for _, ln := range strings.Split(out, "\n") {
		t := strings.TrimSpace(ln)
		switch {
		case strings.HasPrefix(t, "FAIL"):
			fail++
			if len(failing) < 100 {
				failing = append(failing, clip(t, 300))
			}
		case t == "ok" || strings.HasPrefix(t, "ok "):
			pass++
		}
		if m := summaryRe.FindStringSubmatch(t); m != nil {
			summary = t
			pass, _ = strconv.Atoi(m[1])
			fail, _ = strconv.Atoi(m[2])
		}
	}
	return pass, fail, failing, summary
}

func runSelftest(scripts []string) []selftestScript {
	var res []selftestScript
	for _, s := range scripts {
		r := selftestScript{Script: s, Name: filepath.Base(s)}
		if st, err := os.Stat(s); err != nil || st.IsDir() {
			r.Missing = true
			res = append(res, r)
			continue
		}
		start := time.Now()
		tail := &tailLines{max: 2000}
		code, err := runScript(s, os.TempDir(), selftestTimeout, tail)
		out, _ := tail.String()
		r.ExitCode = code
		r.Pass, r.Fail, r.Failing, r.Summary = parseSelftest(out)
		if err != nil {
			r.Error = err.Error()
		} else if code != 0 && r.Fail == 0 {
			r.Error = fmt.Sprintf("exited %d: %s", code, clip(strings.TrimSpace(out), 300))
		}
		r.DurationMs = time.Since(start).Milliseconds()
		res = append(res, r)
	}
	return res
}

func selftestVerdict(res []selftestScript) string {
	ran := false
	for _, r := range res {
		if r.Missing {
			continue
		}
		ran = true
		if r.Fail > 0 || r.ExitCode != 0 || r.Error != "" {
			return "fail"
		}
	}
	if !ran {
		return "missing"
	}
	return "pass"
}

// ---- morning brief ----------------------------------------------------------

var briefDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func validBriefDate(d string) bool {
	if !briefDateRe.MatchString(d) {
		return false
	}
	_, err := time.Parse("2006-01-02", d)
	return err == nil
}

func listBriefs(dir string) []grBrief {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []grBrief{}
	}
	out := []grBrief{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".md") || !validBriefDate(strings.TrimSuffix(name, ".md")) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, grBrief{Date: strings.TrimSuffix(name, ".md"), Size: info.Size(), ModTime: info.ModTime().UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date > out[j].Date })
	return out
}

// launchdStatus finds label in `launchctl list` output (PID, Status, Label).
func launchdStatus(list, label string) (loaded, running bool, lastExit string) {
	for _, ln := range strings.Split(list, "\n") {
		f := strings.Fields(ln)
		if len(f) >= 3 && f[len(f)-1] == label {
			return true, f[0] != "-", f[1]
		}
	}
	return false, false, ""
}

// plistNode is a minimal XML property-list value.
type plistNode struct {
	kind string // dict | array | string | integer | bool | other
	str  string
	dict map[string]*plistNode
	arr  []*plistNode
}

func parsePlist(r io.Reader) (*plistNode, error) {
	d := xml.NewDecoder(r)
	d.Strict = false
	for {
		tok, err := d.Token()
		if err != nil {
			return nil, err
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local != "plist" {
			return plistValue(d, se)
		}
	}
}

func plistValue(d *xml.Decoder, se xml.StartElement) (*plistNode, error) {
	switch se.Name.Local {
	case "dict":
		n := &plistNode{kind: "dict", dict: map[string]*plistNode{}}
		key := ""
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return n, nil
			case xml.StartElement:
				if t.Name.Local == "key" {
					var k string
					if err := d.DecodeElement(&k, &t); err != nil {
						return nil, err
					}
					key = strings.TrimSpace(k)
					continue
				}
				v, err := plistValue(d, t)
				if err != nil {
					return nil, err
				}
				n.dict[key] = v
			}
		}
	case "array":
		n := &plistNode{kind: "array"}
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return n, nil
			case xml.StartElement:
				v, err := plistValue(d, t)
				if err != nil {
					return nil, err
				}
				n.arr = append(n.arr, v)
			}
		}
	case "true", "false":
		if err := d.Skip(); err != nil {
			return nil, err
		}
		return &plistNode{kind: "bool", str: se.Name.Local}, nil
	default:
		var s string
		if err := d.DecodeElement(&s, &se); err != nil {
			return nil, err
		}
		k := se.Name.Local
		if k != "string" && k != "integer" {
			k = "other"
		}
		return &plistNode{kind: k, str: strings.TrimSpace(s)}, nil
	}
}

var weekdayNames = []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}

func plistInt(n *plistNode, key string) (int, bool) {
	if n == nil || n.dict == nil || n.dict[key] == nil {
		return 0, false
	}
	v, err := strconv.Atoi(n.dict[key].str)
	return v, err == nil
}

// describeSchedule turns StartCalendarInterval / StartInterval into words,
// e.g. "Weekdays at 11:30".
func describeSchedule(root *plistNode) string {
	if root == nil || root.dict == nil {
		return ""
	}
	if n, ok := plistInt(root, "StartInterval"); ok {
		return fmt.Sprintf("Every %d min", n/60)
	}
	sci := root.dict["StartCalendarInterval"]
	if sci == nil {
		if root.dict["RunAtLoad"] != nil && root.dict["RunAtLoad"].str == "true" {
			return "At login"
		}
		return ""
	}
	entries := sci.arr
	if sci.kind == "dict" {
		entries = []*plistNode{sci}
	}
	byTime := map[string][]int{}
	var order []string
	for _, e := range entries {
		h, hok := plistInt(e, "Hour")
		m, _ := plistInt(e, "Minute")
		t := "every hour"
		if hok {
			t = fmt.Sprintf("%02d:%02d", h, m)
		}
		if _, seen := byTime[t]; !seen {
			order = append(order, t)
		}
		wd, ok := plistInt(e, "Weekday")
		if !ok {
			wd = -1
		}
		byTime[t] = append(byTime[t], wd)
	}
	var parts []string
	for _, t := range order {
		parts = append(parts, describeDays(byTime[t])+" at "+t)
	}
	return strings.Join(parts, "; ")
}

func describeDays(wds []int) string {
	set := map[int]bool{}
	for _, w := range wds {
		if w < 0 {
			return "Daily"
		}
		set[w%7] = true
	}
	if len(set) == 7 {
		return "Daily"
	}
	if len(set) == 5 && !set[0] && !set[6] {
		return "Weekdays"
	}
	var names []string
	for i := 0; i < 7; i++ {
		if set[i] {
			names = append(names, weekdayNames[i])
		}
	}
	return strings.Join(names, ", ")
}

func morningInfo() grMorning {
	m := grMorning{Label: morningBriefLabel, PlistPath: morningPlistPath(), Dir: briefsDir()}
	m.Briefs = listBriefs(m.Dir)
	if list, err := launchctlList(); err == nil {
		m.Loaded, m.Running, m.LastExit = launchdStatus(list, morningBriefLabel)
	}
	if f, err := os.Open(m.PlistPath); err == nil {
		m.PlistExists = true
		if root, err := parsePlist(f); err == nil {
			m.Schedule = describeSchedule(root)
			if pa := root.dict["ProgramArguments"]; pa != nil && len(pa.arr) > 0 {
				m.Program = pa.arr[len(pa.arr)-1].str
			}
		}
		_ = f.Close()
	}
	return m
}

// ---- git helpers ------------------------------------------------------------

func repoBranchDirty(dir string) (string, int) {
	branch := ""
	if b, err := execWithTimeout("git", 8*time.Second, "-C", dir, "symbolic-ref", "--short", "-q", "HEAD"); err == nil {
		branch = strings.TrimSpace(string(b))
	} else if b, err := execWithTimeout("git", 8*time.Second, "-C", dir, "rev-parse", "--short", "HEAD"); err == nil {
		branch = "detached@" + strings.TrimSpace(string(b))
	}
	out, err := execWithTimeout("git", 8*time.Second, "-C", dir, "status", "--porcelain")
	if err != nil {
		return branch, -1
	}
	n := 0
	for _, ln := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(ln) != "" {
			n++
		}
	}
	return branch, n
}

func isGoRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "go.mod"))
	return err == nil
}

// ---- assemble ---------------------------------------------------------------

func buildGuardrails() guardrailsResp {
	cfg := loadConfig()
	resp := guardrailsResp{
		Hooks: []grHook{}, Conflicts: []grConflict{}, Permissions: []grPermSet{}, Gate: []grGateRepo{},
		Rook: grRook{Installed: hooksInstalled(), Gate: cfg.HooksGate, AutoVerify: cfg.AutoVerify, AutoReview: cfg.AutoReview},
	}
	resp.GateScript = gateScriptPath()
	if st, err := os.Stat(resp.GateScript); err == nil && !st.IsDir() {
		resp.GateScriptOK = true
	}

	addFile := func(path, source, repo string, local bool) {
		s, exists, err := readSettingsFile(path)
		if err != nil {
			resp.Errors = append(resp.Errors, err.Error())
			resp.Permissions = append(resp.Permissions, grPermSet{Source: source, Repo: repo, File: path, Local: local, Error: "could not parse"})
			return
		}
		if !exists {
			return
		}
		resp.Hooks = append(resp.Hooks, hooksFromSettings(s, source, repo, path)...)
		resp.Permissions = append(resp.Permissions, permSetFrom(s, source, repo, path, local))
		if source == "global" && s.StatusLine != nil && s.StatusLine.Command != "" {
			sl := &grStatusline{Command: s.StatusLine.Command}
			script, via := resolveHookScript(s.StatusLine.Command, "")
			sl.Script = script
			sl.Exists, sl.Executable, _ = fileHealth(script, via)
			if sl.Exists {
				sl.Purpose = scriptPurpose(script)
			}
			resp.Statusline = sl
		}
	}
	cd := claudeDir()
	addFile(filepath.Join(cd, "settings.json"), "global", "", false)
	addFile(filepath.Join(cd, "settings.local.json"), "global-local", "", true)

	repos := guardrailRepoList()
	resp.RepoCount = len(repos)
	var goRepos []repoInfo
	for _, r := range repos {
		addFile(filepath.Join(r.Path, ".claude", "settings.json"), "repo", r.Path, false)
		addFile(filepath.Join(r.Path, ".claude", "settings.local.json"), "repo-local", r.Path, true)
		if isGoRepo(r.Path) {
			goRepos = append(goRepos, r)
		}
	}
	resp.Conflicts = findConflicts(resp.Hooks, resp.Rook)

	rows := make([]grGateRepo, len(goRepos))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, r := range goRepos {
		wg.Add(1)
		go func(i int, r repoInfo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			br, dirty := repoBranchDirty(r.Path)
			_, offErr := os.Stat(filepath.Join(r.Path, ".claude", gateOffFile))
			row := grGateRepo{Path: r.Path, Name: r.Name, Branch: br, Dirty: dirty, GateOff: offErr == nil, Last: gateSnapshot(r.Path)}
			if row.Last != nil {
				row.Last.Output = "" // the list stays light; the detail poll returns output
			}
			rows[i] = row
		}(i, r)
	}
	wg.Wait()
	resp.Gate = rows
	resp.Morning = morningInfo()
	return resp
}

// ---- handlers -----------------------------------------------------------------

// bindJSON binds a JSON body and rejects anything else, so a cross-site HTML
// form (urlencoded or text/plain, which skip CORS preflight) cannot trigger a
// write: only a JSON request, which a foreign origin cannot send without a
// preflight rook never approves, gets through.
func bindJSON(ctx *gofr.Context, v any) error {
	var raw json.RawMessage
	if err := ctx.Bind(&raw); err != nil || len(raw) == 0 {
		return errf(http.StatusBadRequest, "expected a JSON body")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return errf(http.StatusBadRequest, "bad JSON: %v", err)
	}
	return nil
}

// knownGoRepo returns the cleaned path when repo is one of the discovered Go
// repos, so writes can never target an arbitrary directory.
func knownGoRepo(repo string) (string, error) {
	if repo == "" || !filepath.IsAbs(repo) {
		return "", errf(http.StatusBadRequest, "repo must be an absolute path")
	}
	clean := filepath.Clean(repo)
	for _, r := range guardrailRepoList() {
		if r.Path == clean {
			if !isGoRepo(clean) {
				return "", errf(http.StatusBadRequest, "%s is not a Go repo", r.Name)
			}
			return clean, nil
		}
	}
	return "", errf(http.StatusNotFound, "not a discovered repo")
}

func handleGuardrails(ctx *gofr.Context) (any, error) {
	return rawJSON(buildGuardrails())
}

type gateReq struct {
	Repo string `json:"repo"`
	Off  bool   `json:"off"`
}

func handleGateRun(ctx *gofr.Context) (any, error) {
	var req gateReq
	if err := bindJSON(ctx, &req); err != nil {
		return nil, err
	}
	repo, err := knownGoRepo(req.Repo)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(gateScriptPath()); err != nil || st.IsDir() {
		return nil, errf(http.StatusFailedDependency, "gate script not found at %s", gateScriptPath())
	}
	run, err := startGate(repo)
	if err != nil {
		return nil, err
	}
	return rawJSON(run)
}

func handleGateStatus(ctx *gofr.Context) (any, error) {
	repo := filepath.Clean(ctx.Param("repo"))
	if r := gateSnapshot(repo); r != nil {
		return rawJSON(r)
	}
	return rawJSON(gateRun{Repo: repo, Status: "none"})
}

func handleGateToggle(ctx *gofr.Context) (any, error) {
	var req gateReq
	if err := bindJSON(ctx, &req); err != nil {
		return nil, err
	}
	repo, err := knownGoRepo(req.Repo)
	if err != nil {
		return nil, err
	}
	if err := setGateOff(repo, req.Off); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	_, statErr := os.Stat(filepath.Join(repo, ".claude", gateOffFile))
	return rawJSON(map[string]any{"repo": repo, "gateOff": statErr == nil})
}

// setGateOff creates or removes <repo>/.claude/gate-off. It touches nothing else.
func setGateOff(repo string, off bool) error {
	p := filepath.Join(repo, ".claude", gateOffFile)
	if st, err := os.Lstat(p); err == nil && !st.Mode().IsRegular() {
		return fmt.Errorf("%s exists and is not a regular file", p)
	}
	if !off {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte("gate turned off from rook's Guardrails page\n"), 0o644)
}

func handleSelftestRun(ctx *gofr.Context) (any, error) {
	selftestMu.Lock()
	if selftestCur.Status == "running" {
		cur := selftestCur
		selftestMu.Unlock()
		return rawJSON(cur)
	}
	selftestCur = selftestState{Status: "running", StartedAt: time.Now().UnixMilli(), Results: []selftestScript{}}
	cur := selftestCur
	selftestMu.Unlock()
	scripts := selftestScripts()
	go func() {
		res := runSelftest(scripts)
		selftestMu.Lock()
		defer selftestMu.Unlock()
		selftestCur.Results = res
		selftestCur.Status = selftestVerdict(res)
		selftestCur.FinishedAt = time.Now().UnixMilli()
	}()
	return rawJSON(cur)
}

func handleSelftestStatus(ctx *gofr.Context) (any, error) {
	selftestMu.Lock()
	defer selftestMu.Unlock()
	return rawJSON(selftestCur)
}

func handleBrief(ctx *gofr.Context) (any, error) {
	date := ctx.Param("date")
	if !validBriefDate(date) {
		return nil, errf(http.StatusBadRequest, "date must be YYYY-MM-DD")
	}
	p := filepath.Join(briefsDir(), date+".md")
	f, err := os.Open(p)
	if err != nil {
		return nil, errf(http.StatusNotFound, "no brief for %s", date)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"date": date, "markdown": string(b)})
}
