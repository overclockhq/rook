package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// Loops page: every unattended Claude loop (<repo>/.loop/<name>/, created by the
// /loop-spec skill) found on this Mac, with start/stop of its runner script in a
// detached tmux session.

const (
	loopProgressTail = 40
	loopLogTail      = 200
	loopRecentPasses = 50
	loopTailBytes    = 256 << 10
)

var loopNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// loopTask is one entry of tasks.json. needs_user may be a bool or a note.
type loopTask struct {
	ID        string `json:"id"`
	Desc      string `json:"desc"`
	Passes    bool   `json:"passes"`
	Attempts  int    `json:"attempts"`
	NeedsUser string `json:"needsUser,omitempty"`
}

// loopPass is one line of metrics.jsonl / ~/.claude/state/loops.jsonl, as
// written by loop-run.sh. Keys keep the file's snake_case.
type loopPass struct {
	At                string  `json:"at"`
	Loop              string  `json:"loop"`
	Repo              string  `json:"repo"`
	Branch            string  `json:"branch"`
	Pass              int     `json:"pass"`
	Task              string  `json:"task"`
	PassingBefore     int     `json:"passing_before"`
	PassingAfter      int     `json:"passing_after"`
	Total             int     `json:"total"`
	ExitCode          int     `json:"exit_code"`
	Seconds           int     `json:"seconds"`
	Turns             int     `json:"turns"`
	CostUSD           float64 `json:"cost_usd"`
	IsError           bool    `json:"is_error"`
	Stop              string  `json:"stop"`
	PermissionDenials int     `json:"permission_denials"`
}

// loopMetrics mirrors loop-stats.sh's summary for one loop.
type loopMetrics struct {
	Passes       int     `json:"passes"`
	TasksPassed  int     `json:"tasksPassed"`
	Wasted       int     `json:"wasted"`
	FirstTry     int     `json:"firstTry"`
	Tried        int     `json:"tried"`
	FirstTryRate float64 `json:"firstTryRate"` // 0..1; 0 when nothing tried
	Errors       int     `json:"errors"`
	Denials      int     `json:"denials"`
	Minutes      float64 `json:"minutes"`
	CostUSD      float64 `json:"costUsd"` // notional: plan usage, not billed
	LastPassAt   string  `json:"lastPassAt,omitempty"`
}

type loopInfo struct {
	Repo            string      `json:"repo"`
	RepoName        string      `json:"repoName"`
	Branch          string      `json:"branch"`
	Name            string      `json:"name"`
	Goal            string      `json:"goal"`
	Tasks           []loopTask  `json:"tasks"`
	Passing         int         `json:"passing"`
	Total           int         `json:"total"`
	NeedsUser       int         `json:"needsUser"`
	Budget          *loopBudget `json:"budget,omitempty"`
	ProgressTail    string      `json:"progressTail"`
	Metrics         loopMetrics `json:"metrics"`
	Running         bool        `json:"running"`
	Runner          string      `json:"runner,omitempty"` // "rook" (our tmux session) | "external"
	Session         string      `json:"session"`          // tmux session name rook uses for this loop
	Exited          bool        `json:"exited,omitempty"` // rook's runner finished; its pane is kept
	ExitCode        int         `json:"exitCode,omitempty"`
	RunnerOutput    string      `json:"runnerOutput,omitempty"` // last lines of an exited runner's pane
	LastActivity    int64       `json:"lastActivity"`           // unix ms, newest file mtime in the loop dir
	Status          string      `json:"status"`                 // running | done | needs-you | idle
	ProtectedBranch bool        `json:"protectedBranch"`
	Error           string      `json:"error,omitempty"`
}

type loopsResp struct {
	Loops           []loopInfo `json:"loops"`
	Recent          []loopPass `json:"recent"`
	TmuxAvailable   bool       `json:"tmuxAvailable"`
	RunnerInstalled bool       `json:"runnerInstalled"`
}

// ---- file parsing (pure) ----------------------------------------------------

// parseLoopGoal returns the first paragraph under the "## Goal" heading.
func parseLoopGoal(spec string) string {
	var para []string
	in := false
	for _, ln := range strings.Split(spec, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#") {
			if in && len(para) > 0 {
				break
			}
			h := strings.ToLower(strings.TrimSpace(strings.TrimLeft(t, "#")))
			in = strings.HasPrefix(t, "##") && !strings.HasPrefix(t, "###") && (h == "goal" || strings.HasPrefix(h, "goal "))
			continue
		}
		if !in {
			continue
		}
		if t == "" {
			if len(para) > 0 {
				break
			}
			continue
		}
		para = append(para, t)
	}
	return strings.Join(para, " ")
}

// parseLoopTasks decodes tasks.json, normalising needs_user to a note string.
func parseLoopTasks(b []byte) ([]loopTask, error) {
	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("tasks.json: %v", err)
	}
	out := make([]loopTask, 0, len(raw))
	for _, m := range raw {
		var t loopTask
		_ = json.Unmarshal(m["id"], &t.ID)
		if t.ID == "" { // tolerate numeric ids
			var n json.Number
			if json.Unmarshal(m["id"], &n) == nil {
				t.ID = n.String()
			}
		}
		_ = json.Unmarshal(m["desc"], &t.Desc)
		_ = json.Unmarshal(m["passes"], &t.Passes)
		_ = json.Unmarshal(m["attempts"], &t.Attempts)
		t.NeedsUser = needsUserNote(m["needs_user"])
		out = append(out, t)
	}
	return out, nil
}

func needsUserNote(v json.RawMessage) string {
	if len(v) == 0 {
		return ""
	}
	var b bool
	if json.Unmarshal(v, &b) == nil {
		if b {
			return "yes"
		}
		return ""
	}
	var s string
	if json.Unmarshal(v, &s) == nil {
		return strings.TrimSpace(s)
	}
	if string(v) == "null" {
		return ""
	}
	return strings.TrimSpace(string(v))
}

// parseLoopPasses decodes JSON lines, skipping blank or corrupt ones. Returns
// the number of corrupt lines so callers can report them.
func parseLoopPasses(r io.Reader) ([]loopPass, int) {
	var out []loopPass
	bad := 0
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		ln := bytes.TrimSpace(sc.Bytes())
		if len(ln) == 0 {
			continue
		}
		var p loopPass
		if err := json.Unmarshal(ln, &p); err != nil {
			bad++
			continue
		}
		out = append(out, p)
	}
	return out, bad
}

// computeLoopMetrics follows loop-stats.sh: first-try = tasks whose first
// logged pass made progress, over tasks tried.
func computeLoopMetrics(ps []loopPass) loopMetrics {
	var m loopMetrics
	if len(ps) == 0 {
		return m
	}
	m.Passes = len(ps)
	m.TasksPassed = ps[len(ps)-1].PassingAfter - ps[0].PassingBefore
	firstOf := map[string]loopPass{}
	var order []string
	secs := 0
	for _, p := range ps {
		if p.PassingAfter == p.PassingBefore {
			m.Wasted++
		}
		if p.IsError || p.ExitCode != 0 {
			m.Errors++
		}
		m.Denials += p.PermissionDenials
		m.CostUSD += p.CostUSD
		secs += p.Seconds
		if p.Task != "" {
			if _, ok := firstOf[p.Task]; !ok {
				firstOf[p.Task] = p
				order = append(order, p.Task)
			}
		}
	}
	m.Tried = len(order)
	for _, t := range order {
		if p := firstOf[t]; p.PassingAfter > p.PassingBefore {
			m.FirstTry++
		}
	}
	if m.Tried > 0 {
		m.FirstTryRate = float64(m.FirstTry) / float64(m.Tried)
	}
	m.Minutes = float64(secs) / 60
	m.CostUSD = float64(int(m.CostUSD*100+0.5)) / 100
	m.LastPassAt = ps[len(ps)-1].At
	return m
}

// tailFile returns the last n lines of a file, reading at most loopTailBytes.
func tailFile(path string, n int) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return "", err
	}
	off := max(size-loopTailBytes, 0)
	b := make([]byte, size-off)
	if _, err := f.ReadAt(b, off); err != nil && err != io.EOF {
		return "", err
	}
	return lastLines(string(b), n, off > 0), nil
}

// lastLines keeps the final n lines; when the text was cut mid-file, the first
// (partial) line is dropped.
func lastLines(s string, n int, cut bool) string {
	s = strings.TrimRight(s, "\n")
	lines := strings.Split(s, "\n")
	if cut && len(lines) > 1 {
		lines = lines[1:]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// ---- discovery ----------------------------------------------------------------

// rookRepoRoots reads repoRoots from ~/.rook/config.json directly, so the field
// stays readable even when the Config struct doesn't model it.
func rookRepoRoots() []string {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return nil
	}
	var c struct {
		RepoRoots []string `json:"repoRoots"`
	}
	if json.Unmarshal(b, &c) != nil {
		return nil
	}
	return c.RepoRoots
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

func globalLoopMetricsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "state", "loops.jsonl")
}

func loopRunnerScript() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "skills", "loop-spec", "scripts", "loop-run.sh")
}

// loopCandidateRepos lists directories that may hold a .loop/: rook's repo
// discovery, each configured repoRoot plus its direct children, and every repo
// a past pass was logged from.
func loopCandidateRepos(discovered, roots []string, recent []loopPass) []string {
	seen := map[string]bool{}
	var out []string
	add := func(d string) {
		if d == "" {
			return
		}
		d = filepath.Clean(d)
		if seen[d] {
			return
		}
		seen[d] = true
		out = append(out, d)
	}
	for _, d := range discovered {
		add(d)
	}
	for _, r := range roots {
		r = expandHome(strings.TrimSpace(r))
		if r == "" {
			continue
		}
		add(r)
		entries, err := os.ReadDir(r)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				add(filepath.Join(r, e.Name()))
			}
		}
	}
	for _, p := range recent {
		add(p.Repo)
	}
	return out
}

type loopRef struct{ Repo, Name string }

// findLoopDirs returns every <repo>/.loop/<name>/ directory, deduplicated by
// resolved path and sorted by repo then name.
func findLoopDirs(repos []string) []loopRef {
	seen := map[string]bool{}
	var out []loopRef
	for _, r := range repos {
		entries, err := os.ReadDir(filepath.Join(r, ".loop"))
		if err != nil {
			continue
		}
		key := r
		if real, err := filepath.EvalSymlinks(r); err == nil {
			key = real
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		for _, e := range entries {
			if e.IsDir() && loopNameRe.MatchString(e.Name()) && !strings.HasPrefix(e.Name(), ".") {
				out = append(out, loopRef{Repo: r, Name: e.Name()})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Repo != out[j].Repo {
			return out[i].Repo < out[j].Repo
		}
		return out[i].Name < out[j].Name
	})
	return out
}

var (
	loopRepoCache   []string
	loopRepoCacheAt time.Time
	loopRepoCacheMu sync.Mutex
)

// discoveredRepoPaths caches rook's repo discovery briefly: the page polls,
// and discovery walks several directories plus the live sessions.
func discoveredRepoPaths() []string {
	loopRepoCacheMu.Lock()
	defer loopRepoCacheMu.Unlock()
	if loopRepoCache != nil && time.Since(loopRepoCacheAt) < 30*time.Second {
		return loopRepoCache
	}
	var out []string
	for _, r := range discoverRepos() {
		out = append(out, r.Path)
	}
	loopRepoCache, loopRepoCacheAt = out, time.Now()
	return out
}

// ---- runner state ----------------------------------------------------------------

var loopSanRe = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// loopSessionName is the tmux session rook runs a loop's runner in. tmux
// rejects '.' and ':' in names, so both parts are sanitised.
// loopSessionName is readable (repo folder + loop name) and unique: a short hash
// of the full repo path and raw name keeps ~/a/api and ~/b/api, or loops "v1.2"
// and "v1-2", from sharing one tmux session.
func loopSessionName(repo, name string) string {
	r := strings.Trim(loopSanRe.ReplaceAllString(filepath.Base(repo), "-"), "-")
	n := strings.Trim(loopSanRe.ReplaceAllString(name, "-"), "-")
	sum := sha256.Sum256([]byte(filepath.Clean(repo) + "\x00" + name))
	return "rook-loop-" + r + "-" + n + "-" + hex.EncodeToString(sum[:3])
}

// loopStartMu serialises start requests so two quick clicks can't both pass the
// "not running" check and then kill each other's runner.
var loopStartMu sync.Mutex

// runnerPane is the state of one rook-loop-* tmux session's pane.
type runnerPane struct {
	Dead   bool
	Status int
}

// loopTmuxPanes maps rook-loop-* session names to their pane state.
var loopTmuxPanes = func() map[string]runnerPane {
	m := map[string]runnerPane{}
	if tmuxBin == "" {
		return m
	}
	out, err := runTmux("list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_dead_status}")
	if err != nil {
		return m
	}
	for _, ln := range strings.Split(string(out), "\n") {
		f := strings.Split(strings.TrimSpace(ln), "\t")
		if len(f) < 2 || !strings.HasPrefix(f[0], "rook-loop-") {
			continue
		}
		st := 0
		if len(f) > 2 {
			st, _ = strconv.Atoi(f[2])
		}
		m[f[0]] = runnerPane{Dead: f[1] == "1", Status: st}
	}
	return m
}

// externalLoopRunners finds loop-run.sh processes started outside rook (e.g. in
// a terminal), keyed "<repo toplevel>\x00<name>".
var externalLoopRunners = func() map[string]bool {
	m := map[string]bool{}
	out, err := execWithTimeout("ps", 5*time.Second, "-axo", "pid=,command=")
	if err != nil {
		return m
	}
	for _, ln := range strings.Split(string(out), "\n") {
		pid, name, ok := parseRunnerProc(ln)
		if !ok {
			continue
		}
		cwd := procCwd(pid)
		if cwd == "" {
			continue
		}
		if top := gitToplevel(cwd); top != "" {
			m[top+"\x00"+name] = true
		}
	}
	return m
}

// parseRunnerProc picks the pid and loop name out of a `ps` line running
// loop-run.sh.
func parseRunnerProc(ln string) (int, string, bool) {
	f := strings.Fields(ln)
	if len(f) < 3 {
		return 0, "", false
	}
	pid, err := strconv.Atoi(f[0])
	if err != nil {
		return 0, "", false
	}
	for i := 1; i < len(f)-1; i++ {
		if filepath.Base(f[i]) == "loop-run.sh" && loopNameRe.MatchString(f[i+1]) {
			return pid, f[i+1], true
		}
	}
	return 0, "", false
}

// procCwd is a process's working directory ("" when lsof can't tell).
func procCwd(pid int) string {
	out, _ := execWithTimeout("lsof", 5*time.Second, "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn")
	return parseLsofCwd(string(out))
}

// parseLsofCwd reads the path from `lsof -Fn` output (the line starting "n/").
func parseLsofCwd(out string) string {
	for _, ln := range strings.Split(out, "\n") {
		if strings.HasPrefix(ln, "n/") {
			return strings.TrimSpace(ln[1:])
		}
	}
	return ""
}

// loopBranch is the repo's current branch ("" when detached or unreadable).
var loopBranch = func(repo string) string {
	out, err := execWithTimeout("git", 5*time.Second, "-C", repo, "branch", "--show-current")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func protectedLoopBranch(b string) bool {
	switch b {
	case "", "main", "master", "development", "develop":
		return true
	}
	return false
}

// ---- assembling one loop ------------------------------------------------------------

// readLoop reads one loop's files. Missing or corrupt files are noted in Error;
// whatever could be read is still returned.
func readLoop(ref loopRef) loopInfo {
	dir := filepath.Join(ref.Repo, ".loop", ref.Name)
	li := loopInfo{Repo: ref.Repo, RepoName: filepath.Base(ref.Repo), Name: ref.Name, Session: loopSessionName(ref.Repo, ref.Name), Tasks: []loopTask{}}
	var errs []string
	li.Branch = loopBranch(ref.Repo)
	li.ProtectedBranch = protectedLoopBranch(li.Branch)

	if b, err := os.ReadFile(filepath.Join(dir, "spec.md")); err == nil {
		li.Goal = parseLoopGoal(string(b))
	} else {
		errs = append(errs, "spec.md missing")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "tasks.json")); err != nil {
		errs = append(errs, "tasks.json missing")
	} else if ts, err := parseLoopTasks(b); err != nil {
		errs = append(errs, err.Error())
	} else {
		li.Tasks = ts
	}
	for _, t := range li.Tasks {
		if t.Passes {
			li.Passing++
		} else if t.NeedsUser != "" {
			li.NeedsUser++
		}
	}
	li.Total = len(li.Tasks)
	if b, err := os.ReadFile(filepath.Join(dir, "budget.json")); err == nil {
		var lb loopBudget
		if err := json.Unmarshal(b, &lb); err == nil {
			li.Budget = &lb
		} else {
			errs = append(errs, "budget.json is not valid: max_iters, max_minutes and max_attempts must be numbers")
		}
	}
	if s, err := tailFile(filepath.Join(dir, "progress.md"), loopProgressTail); err == nil {
		li.ProgressTail = s
	}
	if f, err := os.Open(filepath.Join(dir, "metrics.jsonl")); err == nil {
		ps, bad := parseLoopPasses(f)
		_ = f.Close()
		li.Metrics = computeLoopMetrics(ps)
		if bad > 0 {
			errs = append(errs, fmt.Sprintf("metrics.jsonl: %d corrupt line(s) skipped", bad))
		}
	}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if fi, err := e.Info(); err == nil && fi.ModTime().UnixMilli() > li.LastActivity {
				li.LastActivity = fi.ModTime().UnixMilli()
			}
		}
	}
	li.Error = strings.Join(errs, "; ")
	return li
}

// applyRunnerState fills the running fields and the overall status.
func applyRunnerState(li *loopInfo, panes map[string]runnerPane, external map[string]bool) {
	if p, ok := panes[li.Session]; ok {
		if p.Dead {
			li.Exited, li.ExitCode = true, p.Status
		} else {
			li.Running, li.Runner = true, "rook"
		}
	}
	if !li.Running {
		key := li.Repo
		if real, err := filepath.EvalSymlinks(li.Repo); err == nil {
			key = real
		}
		if external[key+"\x00"+li.Name] || external[li.Repo+"\x00"+li.Name] {
			li.Running, li.Runner = true, "external"
		}
	}
	switch {
	case li.Running:
		li.Status = "running"
	case li.Total > 0 && li.Passing == li.Total:
		li.Status = "done"
	case li.NeedsUser > 0 || (li.Exited && li.ExitCode == 3):
		li.Status = "needs-you"
	default:
		li.Status = "idle"
	}
}

// paneTail keeps the last n non-blank lines of a pane capture; a mostly empty
// pane is padded with blank rows below the runner's final message.
func paneTail(s string, n int) string {
	var keep []string
	for _, ln := range strings.Split(s, "\n") {
		if strings.TrimSpace(ln) != "" {
			keep = append(keep, strings.TrimRight(ln, " "))
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	return strings.Join(keep, "\n")
}

func readRecentLoopPasses(path string, n int) []loopPass {
	s, err := tailFile(path, n*2)
	if err != nil {
		return []loopPass{}
	}
	ps, _ := parseLoopPasses(strings.NewReader(s))
	if len(ps) > n {
		ps = ps[len(ps)-n:]
	}
	// newest first
	for i, j := 0, len(ps)-1; i < j; i, j = i+1, j-1 {
		ps[i], ps[j] = ps[j], ps[i]
	}
	if ps == nil {
		ps = []loopPass{}
	}
	return ps
}

// scanLoops assembles every loop on this Mac.
func scanLoops() loopsResp {
	recent := readRecentLoopPasses(globalLoopMetricsPath(), loopRecentPasses)
	refs := findLoopDirs(loopCandidateRepos(discoveredRepoPaths(), rookRepoRoots(), recent))
	panes := loopTmuxPanes()
	var external map[string]bool
	if len(refs) > 0 {
		external = externalLoopRunners()
	}
	loops := make([]loopInfo, 0, len(refs))
	for _, ref := range refs {
		li := readLoop(ref)
		applyRunnerState(&li, panes, external)
		if li.Exited {
			if out, err := runTmux("capture-pane", "-p", "-t", li.Session); err == nil {
				li.RunnerOutput = paneTail(string(out), 12)
			}
		}
		loops = append(loops, li)
	}
	_, statErr := os.Stat(loopRunnerScript())
	return loopsResp{Loops: loops, Recent: recent, TmuxAvailable: tmuxBin != "", RunnerInstalled: statErr == nil}
}

// findKnownLoop resolves a client-supplied repo+name to a discovered loop, so
// start/stop only ever act on a real .loop/<name>/ rook already lists.
func findKnownLoop(repo, name string) (loopRef, bool) {
	if !loopNameRe.MatchString(name) || repo == "" {
		return loopRef{}, false
	}
	repo = filepath.Clean(repo)
	recent := readRecentLoopPasses(globalLoopMetricsPath(), loopRecentPasses)
	for _, ref := range findLoopDirs(loopCandidateRepos(discoveredRepoPaths(), rookRepoRoots(), recent)) {
		if ref.Repo == repo && ref.Name == name {
			return ref, true
		}
	}
	return loopRef{}, false
}

// ---- handlers ------------------------------------------------------------------------

func handleLoops(ctx *gofr.Context) (any, error) {
	return rawJSON(scanLoops())
}

type loopReq struct {
	Repo string `json:"repo"`
	Name string `json:"name"`
}

// checkLoopStart refuses a start when the loop has no tasks.json, the branch is
// protected, or a runner is already alive.
func checkLoopStart(ref loopRef, panes map[string]runnerPane, external map[string]bool) (int, error) {
	if _, err := os.Stat(filepath.Join(ref.Repo, ".loop", ref.Name, "tasks.json")); err != nil {
		return http.StatusBadRequest, fmt.Errorf("no tasks.json in .loop/%s", ref.Name)
	}
	if br := loopBranch(ref.Repo); protectedLoopBranch(br) {
		if br == "" {
			br = "a detached HEAD"
		}
		return http.StatusConflict, fmt.Errorf("refusing to loop on %s — switch %s to a feature/ or fix/ branch first", br, filepath.Base(ref.Repo))
	}
	li := loopInfo{Repo: ref.Repo, Name: ref.Name, Session: loopSessionName(ref.Repo, ref.Name)}
	applyRunnerState(&li, panes, external)
	if li.Running {
		return http.StatusConflict, fmt.Errorf("a runner for %s is already running (%s)", ref.Name, li.Runner)
	}
	return 0, nil
}

// loopLaunchCmd is the shell command tmux runs; both parts are single-quoted.
func loopLaunchCmd(script, name string) string {
	return "bash " + shellQuote(script) + " " + shellQuote(name)
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func handleLoopStart(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux not installed — needed to run a loop in the background")
	}
	var req loopReq
	if err := ctx.Bind(&req); err != nil {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	ref, ok := findKnownLoop(req.Repo, req.Name)
	if !ok {
		return nil, errf(http.StatusNotFound, "no loop %q in %s", req.Name, req.Repo)
	}
	loopStartMu.Lock()
	defer loopStartMu.Unlock()
	script := loopRunnerScript()
	if _, err := os.Stat(script); err != nil {
		return nil, errf(http.StatusPreconditionFailed, "runner script not found at %s — install the loop-spec skill", script)
	}
	if code, err := checkLoopStart(ref, loopTmuxPanes(), externalLoopRunners()); err != nil {
		return nil, errf(code, "%v", err)
	}
	sess := loopSessionName(ref.Repo, ref.Name)
	// A finished runner keeps its pane (remain-on-exit) so its last message is
	// visible; clear it before starting again.
	_, _ = runTmux("kill-session", "-t", "="+sess)
	if out, err := runTmux("new-session", "-d", "-s", sess, "-x", "200", "-y", "50", "-c", ref.Repo,
		loopLaunchCmd(script, ref.Name), ";", "set-option", "-w", "-t", sess, "remain-on-exit", "on"); err != nil {
		return nil, errf(http.StatusConflict, "start failed: %s", tmuxErr(err, out))
	}
	return rawJSON(map[string]any{"ok": true, "session": sess})
}

func handleLoopStop(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux not installed")
	}
	var req loopReq
	if err := ctx.Bind(&req); err != nil || !loopNameRe.MatchString(req.Name) || req.Repo == "" {
		return nil, errf(http.StatusBadRequest, "bad request")
	}
	sess := loopSessionName(filepath.Clean(req.Repo), req.Name)
	if _, ok := loopTmuxPanes()[sess]; !ok {
		return nil, errf(http.StatusNotFound, "no rook runner for %s (a runner started outside rook must be stopped where it runs)", req.Name)
	}
	if out, err := runTmux("kill-session", "-t", "="+sess); err != nil {
		return nil, errf(http.StatusInternalServerError, "stop failed: %s", tmuxErr(err, out))
	}
	return rawJSON(map[string]any{"ok": true, "session": sess})
}

func handleLoopLog(ctx *gofr.Context) (any, error) {
	ref, ok := findKnownLoop(ctx.Param("repo"), ctx.Param("name"))
	if !ok {
		return nil, errf(http.StatusNotFound, "no such loop")
	}
	s, err := tailFile(filepath.Join(ref.Repo, ".loop", ref.Name, "runner.log"), loopLogTail)
	if err != nil {
		if os.IsNotExist(err) {
			return rawJSON(map[string]any{"log": "", "exists": false})
		}
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"log": s, "exists": true})
}

// loopBudget is the runner's budget.json. Typed fields, not raw JSON: the file
// comes from the repo and is shown in the UI.
type loopBudget struct {
	MaxIters    *int `json:"max_iters,omitempty"`
	MaxMinutes  *int `json:"max_minutes,omitempty"`
	MaxAttempts *int `json:"max_attempts,omitempty"`
}
