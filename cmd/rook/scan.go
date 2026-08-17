package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// claudeDir returns ~/.claude (honoring CLAUDE_CONFIG_DIR if set).
func claudeDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// ---------- wire types ----------

// Session is one live/known agent session, as shown in the dashboard.
type Session struct {
	Provider    string     `json:"provider"` // claude | codex | aider | gemini | …
	PID         int        `json:"pid"`
	SessionID   string     `json:"sessionId"`
	Title       string     `json:"title"`
	CWD         string     `json:"cwd"`
	Project     string     `json:"project"`
	Repo        string     `json:"repo"` // owner/repo from the cwd's git remote (works for worktrees) — powers PR/issue context detection
	Status      string     `json:"status"` // busy|idle|waiting|shell|dead
	Alive       bool       `json:"alive"`
	Kind        string     `json:"kind"`
	Version     string     `json:"version"`
	Model       string     `json:"model"`
	LastPrompt  string     `json:"lastPrompt"`
	Asking      string     `json:"asking"`      // last assistant text — what a waiting session wants
	Activity    string     `json:"activity"`    // human one-liner: what it's doing right now
	ChangedFiles []string  `json:"changedFiles"` // files edited/written, most-recent first
	StartedAt   int64      `json:"startedAt"`   // ms epoch
	UpdatedAt   int64      `json:"updatedAt"`   // ms epoch
	TokensTotal int64      `json:"tokensTotal"` // total input+output for this session
	ContextTokens int64    `json:"contextTokens"` // context-window fill at the latest turn (input+cache) — how "full" the agent is
	ReflectionAttempts int `json:"reflectionAttempts"` // Reflexion retries recorded in this worktree's episodic buffer
	ToolResults int      `json:"toolResults"` // total tool_result blocks (denominator for tool-error rate)
	ToolErrors  int      `json:"toolErrors"`  // tool_result blocks flagged is_error
	QualityScore   int             `json:"qualityScore"`   // 0–100 work-quality signal (looping, retries, stalls) — not a correctness judgment
	QualityLabel   string          `json:"qualityLabel"`   // excellent | good | fair | at risk
	QualityReasons []string        `json:"qualityReasons,omitempty"` // what moved the score
	QualityFactors []qualityFactor `json:"qualityFactors,omitempty"` // per-factor breakdown for the detail view
	Tokens5h    int64      `json:"tokens5h"`    // total tokens used in the last 5 hours
	Tokens7d    int64      `json:"tokens7d"`    // total tokens used in the last 7 days
	CostUSD     float64    `json:"costUsd"`     // estimated lifetime cost of this session
	Summary     string     `json:"summary"`     // human recap of what the session did
	Skills      []string   `json:"skills"`      // project-local skills for this cwd
	TmuxPane    string     `json:"tmuxPane"`    // tmux pane target if launched in tmux
	Controllable bool      `json:"controllable"` // can we send keystrokes to it
	SpawnedByRook bool     `json:"spawnedByRook"` // rook launched this agent (vs started by hand in a terminal)
	ToolCalls   []ToolCall `json:"toolCalls"`   // most recent first
	Health      *Health    `json:"health,omitempty"` // watchdog assessment (nil if healthy)
}

// ToolCall is a single tool invocation summarized for humans.
type ToolCall struct {
	Name      string `json:"name"`
	Summary   string `json:"summary"`
	Timestamp int64  `json:"timestamp"`     // ms epoch of the tool_use
	ID        string `json:"id,omitempty"`  // tool_use id, for correlating its result + dedup
	DurMs     int64  `json:"durMs,omitempty"`   // wall time until its tool_result arrived
	IsError   bool   `json:"isError,omitempty"` // its result was flagged is_error
}

// TokenWindow is rolling usage over a fixed lookback (e.g. 5h, 7d).
type TokenWindow struct {
	Label      string `json:"label"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cacheRead"`
	CacheWrite int64  `json:"cacheWrite"`
	Total      int64   `json:"total"`
	Messages   int64   `json:"messages"`
	CostUSD    float64 `json:"costUsd"`
	OldestMs   int64   `json:"oldestMs"` // start of the window
	FirstMs    int64   `json:"firstMs"`  // earliest actual usage inside the window
	WindowMs   int64   `json:"windowMs"` // window length in ms
}

// DevServer is a process listening on a TCP port.
type DevServer struct {
	PID     int    `json:"pid"`
	Command string `json:"command"`
	Runtime string `json:"runtime"`
	Port    int    `json:"port"`
	Addr    string `json:"addr"`
	CWD     string `json:"cwd"`
	Project string `json:"project"`
}

// NamedItem is a labelled entry (skill, plugin, mcp server) with optional detail.
type NamedItem struct {
	Name   string `json:"name"`
	Detail string `json:"detail"`
	State  string `json:"state"` // enabled|disabled|needs-auth|""
}

// Environment is the workspace inventory: skills, plugins, MCP servers.
type Environment struct {
	Skills  []NamedItem `json:"skills"`
	Plugins []NamedItem `json:"plugins"`
	MCP     []NamedItem `json:"mcp"`
}

// DayStat is one day of aggregate activity, derived live from transcripts.
type DayStat struct {
	Date      string `json:"date"`
	Messages  int    `json:"messages"`
	Tokens    int64  `json:"tokens"`
	ToolCalls int    `json:"toolCalls"`
}

// State is the full snapshot served to the frontend.
type State struct {
	AppVersion    string     `json:"appVersion"` // build version; client force-reloads on mismatch
	TmuxAvailable bool       `json:"tmuxAvailable"` // whether control features (allow/deny/terminal/spawn) work
	Now        int64         `json:"now"`
	Sessions   []Session     `json:"sessions"`
	Windows    []TokenWindow `json:"windows"`
	Trends     []DayStat     `json:"trends"`
	DevServers []DevServer   `json:"devServers"`
	Env        Environment   `json:"env"`
}

// ---------- transcript parsing (mtime-cached) ----------

// usageEvent is one assistant message's token accounting.
type usageEvent struct {
	tsMs       int64
	input      int64
	output     int64
	cacheRead  int64
	cacheWrite int64
}

// parsedTranscript is the cached result of reading one .jsonl file.
type parsedTranscript struct {
	title        string
	lastPrompt   string
	lastText     string // most recent assistant text block
	model        string
	usage        []usageEvent
	tools        []ToolCall
	toolResults  int      // total tool_result blocks seen
	toolErrors   int      // tool_result blocks flagged is_error
	changedFiles []string // files edited/written, most-recent last
	pendingTool  ToolCall // newest tool_use awaiting a result
	pendingFull  string   // untruncated detail of the pending tool (e.g. full command)
	hasPending   bool
	tokensTotal  int64
	contextTokens int64 // input+cacheRead+cacheWrite of the most recent turn = current window fill
}

type cacheEntry struct {
	mtime  int64
	size   int64
	parsed *parsedTranscript
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cacheEntry{}
)

// parseTranscript reads a single transcript, caching by (mtime,size).
func parseTranscript(path string) *parsedTranscript {
	fi, err := os.Stat(path)
	if err != nil {
		return nil
	}
	mt := fi.ModTime().UnixNano()
	sz := fi.Size()

	cacheMu.Lock()
	if e, ok := cache[path]; ok && e.mtime == mt && e.size == sz {
		cacheMu.Unlock()
		return e.parsed
	}
	cacheMu.Unlock()

	p := readTranscript(path)

	cacheMu.Lock()
	cache[path] = cacheEntry{mtime: mt, size: sz, parsed: p}
	cacheMu.Unlock()
	return p
}

// transcriptLine models the subset of fields we read from each JSONL line.
type transcriptLine struct {
	Type          string          `json:"type"`
	AITitle       string          `json:"aiTitle"`
	LastPrompt    json.RawMessage `json:"lastPrompt"`
	Timestamp     string          `json:"timestamp"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
	Message       *struct {
		Model   string `json:"model"`
		Content json.RawMessage `json:"content"`
		Usage   *struct {
			InputTokens            int64 `json:"input_tokens"`
			OutputTokens           int64 `json:"output_tokens"`
			CacheReadInputTokens   int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func readTranscript(path string) *parsedTranscript {
	f, err := os.Open(path)
	if err != nil {
		return &parsedTranscript{}
	}
	defer f.Close()

	p := &parsedTranscript{}
	toolIdx := map[string]int{} // tool_use id -> index in p.tools, to back-fill dur/error
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // allow long lines
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var tl transcriptLine
		if err := json.Unmarshal(line, &tl); err != nil {
			continue
		}
		if tl.AITitle != "" {
			p.title = tl.AITitle
		}
		if len(tl.LastPrompt) > 0 {
			if s := lastPromptText(tl.LastPrompt); s != "" {
				p.lastPrompt = s
			}
		}
		// a tool result means the previously-issued tool completed (not pending)
		if len(tl.ToolUseResult) > 0 {
			p.hasPending = false
		}
		// count tool_result blocks + errors (these live on user-role lines) so the
		// quality score can use the tool-call error rate.
		if tl.Message != nil {
			tr, te := countToolResults(tl.Message.Content)
			p.toolResults += tr
			p.toolErrors += te
			// correlate each result back to its tool_use for real duration + error
			rts := parseTS(tl.Timestamp)
			for _, r := range parseToolResults(tl.Message.Content) {
				if idx, ok := toolIdx[r.ToolUseID]; ok {
					if rts > 0 && p.tools[idx].Timestamp > 0 && rts >= p.tools[idx].Timestamp {
						p.tools[idx].DurMs = rts - p.tools[idx].Timestamp
					}
					p.tools[idx].IsError = r.IsError
				}
			}
		}
		if tl.Type != "assistant" || tl.Message == nil {
			continue
		}
		ts := parseTS(tl.Timestamp)
		if tl.Message.Model != "" {
			p.model = tl.Message.Model
		}
		if u := tl.Message.Usage; u != nil {
			ev := usageEvent{
				tsMs:       ts,
				input:      u.InputTokens,
				output:     u.OutputTokens,
				cacheRead:  u.CacheReadInputTokens,
				cacheWrite: u.CacheCreationInputTokens,
			}
			p.usage = append(p.usage, ev)
			p.tokensTotal += u.InputTokens + u.OutputTokens
			// each assistant turn reports the whole context it read; the last one
			// wins → current window fill.
			p.contextTokens = u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
		}
		// extract tool_use blocks + latest assistant text + changed files
		tcs, txt, changed, lastFull := extractContent(tl.Message.Content, ts)
		base := len(p.tools)
		p.tools = append(p.tools, tcs...)
		for i, tc := range tcs {
			if tc.ID != "" {
				toolIdx[tc.ID] = base + i
			}
		}
		if len(tcs) > 0 {
			// newest tool_use is pending until a toolUseResult line clears it
			p.pendingTool = tcs[len(tcs)-1]
			p.pendingFull = lastFull
			p.hasPending = true
		}
		if txt != "" {
			p.lastText = txt
		}
		p.changedFiles = append(p.changedFiles, changed...)
	}
	p.changedFiles = dedupeKeepLast(p.changedFiles)
	return p
}

// dedupeKeepLast removes earlier duplicates, keeping the last occurrence order.
func dedupeKeepLast(in []string) []string {
	seen := map[string]bool{}
	// walk from the end so the most recent change wins its position
	var rev []string
	for i := len(in) - 1; i >= 0; i-- {
		if !seen[in[i]] {
			seen[in[i]] = true
			rev = append(rev, in[i])
		}
	}
	return rev // most-recent first
}

// contentBlock is one item in an assistant message's content array.
type contentBlock struct {
	Type  string          `json:"type"`
	Name  string          `json:"name"`
	Text  string          `json:"text"`
	Input json.RawMessage `json:"input"`
	ID    string          `json:"id"` // tool_use id
}

// toolResultRef is a tool_result linked back to the tool_use it answers.
type toolResultRef struct {
	ToolUseID string
	IsError   bool
}

// parseToolResults extracts tool_result blocks with the id they answer, so a
// result's timestamp + error can be correlated to its originating tool_use.
func parseToolResults(raw json.RawMessage) []toolResultRef {
	if len(raw) == 0 {
		return nil
	}
	var blocks []struct {
		Type      string `json:"type"`
		ToolUseID string `json:"tool_use_id"`
		IsError   bool   `json:"is_error"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return nil
	}
	var out []toolResultRef
	for _, b := range blocks {
		if b.Type == "tool_result" {
			out = append(out, toolResultRef{ToolUseID: b.ToolUseID, IsError: b.IsError})
		}
	}
	return out
}

// countToolResults counts tool_result blocks in a message's content and how many
// were flagged is_error — the raw material for the tool-call error rate.
func countToolResults(raw json.RawMessage) (total, errs int) {
	if len(raw) == 0 {
		return 0, 0
	}
	var blocks []struct {
		Type    string `json:"type"`
		IsError bool   `json:"is_error"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return 0, 0
	}
	for _, b := range blocks {
		if b.Type == "tool_result" {
			total++
			if b.IsError {
				errs++
			}
		}
	}
	return total, errs
}

// extractContent returns the tool calls, the trailing text block, any files
// changed, and the untruncated detail of the last tool_use (for permission
// messages that need the full command).
func extractContent(raw json.RawMessage, ts int64) ([]ToolCall, string, []string, string) {
	if len(raw) == 0 {
		return nil, "", nil, ""
	}
	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, "", nil, ""
	}
	var out []ToolCall
	var text, lastFull string
	var changed []string
	for _, b := range blocks {
		switch b.Type {
		case "tool_use":
			out = append(out, ToolCall{
				Name:      b.Name,
				Summary:   summarizeTool(b.Name, b.Input),
				Timestamp: ts,
				ID:        b.ID,
			})
			lastFull = toolFull(b.Name, b.Input)
			if f := changedFile(b.Name, b.Input); f != "" {
				changed = append(changed, f)
			}
		case "text":
			if t := strings.TrimSpace(b.Text); t != "" {
				text = t
			}
		}
	}
	return out, text, changed, lastFull
}

// toolFull returns the untruncated, human-meaningful detail of a tool call —
// the whole Bash command, the full file path — for permission prompts.
func toolFull(name string, input json.RawMessage) string {
	var m map[string]any
	_ = json.Unmarshal(input, &m)
	get := func(k string) string {
		if v, ok := m[k].(string); ok {
			return v
		}
		return ""
	}
	switch name {
	case "Bash":
		return strings.TrimSpace(get("command"))
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return get("file_path")
	}
	return summarizeTool(name, input)
}

// changedFile returns the file path a write-class tool touched, else "".
func changedFile(name string, input json.RawMessage) string {
	switch name {
	case "Edit", "Write", "NotebookEdit", "MultiEdit":
		var m struct {
			FilePath string `json:"file_path"`
		}
		_ = json.Unmarshal(input, &m)
		return m.FilePath
	}
	return ""
}

// summarizeTool turns a tool name + input into a short human phrase.
func summarizeTool(name string, input json.RawMessage) string {
	var m map[string]any
	_ = json.Unmarshal(input, &m)
	get := func(k string) string {
		if v, ok := m[k].(string); ok {
			return v
		}
		return ""
	}
	pick := func(keys ...string) string {
		for _, k := range keys {
			if v := get(k); v != "" {
				return v
			}
		}
		return ""
	}
	base := func(p string) string {
		if p == "" {
			return ""
		}
		return filepath.Base(p)
	}

	switch name {
	case "Bash":
		return oneLine(get("command"))
	case "Read", "NotebookEdit":
		return base(get("file_path"))
	case "Edit":
		return "edit " + base(get("file_path"))
	case "Write":
		return "write " + base(get("file_path"))
	case "Grep":
		return "grep " + oneLine(pick("pattern"))
	case "Glob":
		return oneLine(get("pattern"))
	case "WebFetch":
		return get("url")
	case "WebSearch":
		return oneLine(get("query"))
	case "Task", "Agent":
		return oneLine(pick("description", "prompt"))
	case "Skill":
		return get("skill")
	case "TaskCreate", "TaskUpdate":
		return oneLine(pick("subject", "status"))
	case "ToolSearch":
		return oneLine(get("query"))
	}
	// generic: first stringy field
	if s := oneLine(pick("description", "prompt", "query", "command", "path", "file_path")); s != "" {
		return s
	}
	return ""
}

// describeWaiting phrases what a waiting session wants — usually permission to
// run its pending tool call, otherwise the question it asked.
func describeWaiting(p *parsedTranscript) string {
	// only phrase a permission ask when a tool is genuinely pending approval
	if p.hasPending && p.pendingTool.Name != "" {
		t := p.pendingTool
		switch t.Name {
		case "AskUserQuestion":
			if p.lastText != "" {
				return p.lastText
			}
			return "Waiting for your answer to a question"
		case "Bash":
			if p.pendingFull != "" {
				return "Allow Bash to run:\n" + p.pendingFull
			}
			if t.Summary != "" {
				return "Allow Bash to run: " + t.Summary
			}
			return "Allow a shell command"
		case "Edit", "Write", "MultiEdit", "NotebookEdit":
			if p.pendingFull != "" {
				return "Allow file edit: " + p.pendingFull
			}
			return "Allow file edit: " + t.Summary
		case "WebFetch", "WebSearch":
			return "Allow " + t.Name + ": " + t.Summary
		default:
			if t.Summary != "" {
				return "Allow " + t.Name + ": " + t.Summary
			}
			return "Allow " + t.Name
		}
	}
	// otherwise it's waiting for the next instruction — show its last message
	if p.lastText != "" {
		return p.lastText
	}
	return "Waiting for your input"
}

// summarizeSession recaps what a session did: tool volume, commands, edits.
func summarizeSession(p *parsedTranscript) string {
	counts := map[string]int{}
	for _, t := range p.tools {
		counts[t.Name]++
	}
	parts := []string{}
	if n := len(p.tools); n > 0 {
		parts = append(parts, plural(n, "tool call", "tool calls"))
	}
	if n := len(p.changedFiles); n > 0 {
		parts = append(parts, plural(n, "file changed", "files changed"))
	}
	if n := counts["Bash"]; n > 0 {
		parts = append(parts, plural(n, "command", "commands"))
	}
	if n := counts["WebFetch"] + counts["WebSearch"]; n > 0 {
		parts = append(parts, plural(n, "web lookup", "web lookups"))
	}
	if len(parts) == 0 {
		return "No tool activity yet."
	}
	return strings.Join(parts, " · ")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return itoa(n) + " " + many
}

func itoa(n int) string {
	// small helper to avoid importing strconv here
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// deriveActivity produces a human one-liner for what a session is doing now.
func deriveActivity(status string, p *parsedTranscript) string {
	switch status {
	case "busy", "shell":
		return narrateBusy(p)
	case "waiting":
		return "Waiting for your input"
	case "idle", "dead":
		if p.lastText != "" {
			return oneLine(p.lastText)
		}
		if n := len(p.tools); n > 0 {
			return "Last: " + p.tools[n-1].Name + " " + p.tools[n-1].Summary
		}
	}
	return ""
}

// toolFamily groups tools so a run of them narrates as one activity.
func toolFamily(name string) string {
	switch name {
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return "edit"
	case "Read":
		return "read"
	case "Grep", "Glob", "LS":
		return "search"
	case "Bash":
		return "shell"
	case "WebFetch", "WebSearch":
		return "web"
	case "Task":
		return "task"
	}
	return ""
}

// narrateBusy summarizes what an agent is doing from the trailing run of same-
// family tool calls, with a dwell time — "Editing scan.go — 3 edits · 4m" reads
// like a glance over the shoulder, not "Running Edit".
func narrateBusy(p *parsedTranscript) string {
	n := len(p.tools)
	if n == 0 {
		return "Thinking…"
	}
	last := p.tools[n-1]
	fam := toolFamily(last.Name)
	run, firstTs := 1, last.Timestamp
	for i := n - 2; i >= 0; i-- {
		if toolFamily(p.tools[i].Name) != fam || fam == "" {
			break
		}
		run++
		if p.tools[i].Timestamp > 0 {
			firstTs = p.tools[i].Timestamp
		}
	}
	dwell := ""
	if run > 1 && firstTs > 0 && last.Timestamp > firstTs {
		dwell = " · " + humanDur(last.Timestamp-firstTs)
	}
	switch fam {
	case "edit":
		if run > 1 {
			return "Editing — " + itoa(run) + " edits" + dwell
		}
		return "Editing " + last.Summary
	case "read":
		if run > 1 {
			return "Reading " + itoa(run) + " files" + dwell
		}
		return "Reading " + last.Summary
	case "search":
		return "Searching the codebase"
	case "shell":
		if last.Summary != "" {
			return "Running " + last.Summary
		}
		return "Running a shell command"
	case "web":
		return "Researching on the web"
	case "task":
		return "Running a sub-agent"
	}
	if last.Summary != "" {
		return "Running " + last.Name + ": " + last.Summary
	}
	return "Running " + last.Name
}

func oneLine(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) > 120 {
		s = s[:117] + "..."
	}
	return s
}

func lastPromptText(raw json.RawMessage) string {
	// lastPrompt may be a plain string or an object/array.
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return oneLine(s)
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		if v, ok := obj["text"].(string); ok {
			return oneLine(v)
		}
		if v, ok := obj["prompt"].(string); ok {
			return oneLine(v)
		}
	}
	return ""
}

// staleBusyMs: a session claiming "busy"/"shell" but silent this long is not
// actually working — no real agent turn stays silent for 30 minutes, so it's a
// hung/stale session or a reused PID after the real agent exited.
const staleBusyMs = 30 * 60 * 1000

// effectiveStatus downgrades a stale "busy"/"shell" to "idle" so a long-dead
// session doesn't keep reading as Busy / Working.
func effectiveStatus(status string, updatedAt, now int64) string {
	if (status == "busy" || status == "shell") && updatedAt > 0 && now-updatedAt > staleBusyMs {
		return "idle"
	}
	return status
}

func parseTS(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// ---------- session scanning ----------

type sessionFile struct {
	PID             int    `json:"pid"`
	SessionID       string `json:"sessionId"`
	CWD             string `json:"cwd"`
	StartedAt       int64  `json:"startedAt"`
	Version         string `json:"version"`
	Kind            string `json:"kind"`
	Entrypoint      string `json:"entrypoint"`
	Status          string `json:"status"`
	UpdatedAt       int64  `json:"updatedAt"`
	StatusUpdatedAt int64  `json:"statusUpdatedAt"`
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func projectName(cwd string) string {
	if cwd == "" {
		return ""
	}
	return filepath.Base(cwd)
}

// findTranscript locates the JSONL transcript for a session id under projects/.
func findTranscript(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	matches, _ := filepath.Glob(filepath.Join(claudeDir(), "projects", "*", sessionID+".jsonl"))
	if len(matches) > 0 {
		return matches[0]
	}
	return ""
}

// ScanSessions reads every sessions/<pid>.json and enriches from transcripts.
func ScanSessions(maxTools int) []Session {
	dir := filepath.Join(claudeDir(), "sessions")
	entries, _ := os.ReadDir(dir)
	panes := tmuxPanePIDs()
	paneSessions := tmuxPaneSessions()
	spawned := spawnedNames()
	wtDir := worktreesDir()
	var out []Session
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var sf sessionFile
		if json.Unmarshal(raw, &sf) != nil {
			continue
		}
		alive := pidAlive(sf.PID)
		s := Session{
			Provider:   "claude",
			PID:        sf.PID,
			SessionID:  sf.SessionID,
			CWD:        sf.CWD,
			Project:    projectName(sf.CWD),
			Status:     sf.Status,
			Alive:      alive,
			Kind:       sf.Kind,
			Version:    sf.Version,
			StartedAt:  sf.StartedAt,
			UpdatedAt:  sf.UpdatedAt,
		}
		if !alive {
			s.Status = "dead"
		}
		if alive {
			// A session file can say "busy" long after its agent actually exited —
			// the PID gets reused, so pidAlive is true, but there's been no update
			// in days. Don't badge that as Busy / Working.
			s.Status = effectiveStatus(s.Status, sf.UpdatedAt, time.Now().UnixMilli())
			s.TmuxPane = findPaneForPID(sf.PID, panes)
			s.Controllable = s.TmuxPane != ""
		}
		s.SpawnedByRook = sessionSpawnedByRook(sf.CWD, s.TmuxPane, spawned, paneSessions, wtDir)
		s.Skills = projectSkills(sf.CWD)
		s.Repo = repoForDir(sf.CWD)
		s.ReflectionAttempts = reflectionAttemptsRO(sf.CWD)
		if tp := findTranscript(sf.SessionID); tp != "" {
			if p := parseTranscript(tp); p != nil {
				s.Title = p.title
				s.LastPrompt = p.lastPrompt
				s.Model = p.model
				s.TokensTotal = p.tokensTotal
				s.ContextTokens = p.contextTokens
				s.ToolResults = p.toolResults
				s.ToolErrors = p.toolErrors
				s.ChangedFiles = p.changedFiles
				if s.Status == "waiting" {
					s.Asking = describeWaiting(p)
				}
				s.Activity = deriveActivity(s.Status, p)
				rates := pricePerToken(p.model)
				nowMs := time.Now().UnixMilli()
				w5 := nowMs - 5*3600*1000
				w7 := nowMs - 7*24*3600*1000
				for _, ev := range p.usage {
					s.CostUSD += rates.cost(ev)
					tok := ev.input + ev.output + ev.cacheRead + ev.cacheWrite
					if ev.tsMs >= w5 {
						s.Tokens5h += tok
					}
					if ev.tsMs >= w7 {
						s.Tokens7d += tok
					}
				}
				s.Summary = summarizeSession(p)
				// most recent tools first — copy so we never mutate the cached slice
				tools := make([]ToolCall, len(p.tools))
				for i, tc := range p.tools {
					tools[len(p.tools)-1-i] = tc
				}
				if maxTools > 0 && len(tools) > maxTools {
					tools = tools[:maxTools]
				}
				s.ToolCalls = tools
			}
		}
		if s.Title == "" {
			s.Title = s.Project
		}
		out = append(out, s)
	}
	sortSessions(out)
	return out
}

// sortSessions orders sessions alive-first, then by most recent activity.
func sortSessions(out []Session) {
	sort.Slice(out, func(i, j int) bool {
		if out[i].Alive != out[j].Alive {
			return out[i].Alive
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
}

// ScanAllSessions merges every agent adapter's sessions into one list.
func ScanAllSessions(maxTools int) []Session {
	out := ScanSessions(maxTools)
	out = append(out, ScanCodexSessions(maxTools)...)
	out = append(out, ScanAiderSessions(maxTools)...)
	out = append(out, ScanGeminiSessions(maxTools)...)
	sortSessions(out)
	return out
}

// ---------- token windows ----------

// TokenWindows aggregates usage across all transcripts over rolling windows.
func TokenWindows(now time.Time) []TokenWindow {
	defs := []struct {
		label string
		dur   time.Duration
	}{
		{"5 hours", 5 * time.Hour},
		{"7 days", 7 * 24 * time.Hour},
	}
	wins := make([]TokenWindow, len(defs))
	for i, d := range defs {
		wins[i] = TokenWindow{
			Label:    d.label,
			OldestMs: now.Add(-d.dur).UnixMilli(),
			WindowMs: d.dur.Milliseconds(),
		}
	}

	// Only consider files touched within the largest window.
	cutoff := now.Add(-defs[len(defs)-1].dur)
	files, _ := filepath.Glob(filepath.Join(claudeDir(), "projects", "*", "*.jsonl"))
	for _, fp := range files {
		fi, err := os.Stat(fp)
		if err != nil || fi.ModTime().Before(cutoff) {
			continue
		}
		p := parseTranscript(fp)
		if p == nil {
			continue
		}
		rates := pricePerToken(p.model)
		for _, ev := range p.usage {
			c := rates.cost(ev)
			for i := range wins {
				if ev.tsMs >= wins[i].OldestMs {
					wins[i].Input += ev.input
					wins[i].Output += ev.output
					wins[i].CacheRead += ev.cacheRead
					wins[i].CacheWrite += ev.cacheWrite
					wins[i].CostUSD += c
					wins[i].Messages++
					if wins[i].FirstMs == 0 || ev.tsMs < wins[i].FirstMs {
						wins[i].FirstMs = ev.tsMs
					}
				}
			}
		}
	}
	for i := range wins {
		wins[i].Total = wins[i].Input + wins[i].Output + wins[i].CacheRead + wins[i].CacheWrite
	}
	return wins
}

// ---------- trends (daily activity) ----------

// ScanTrends buckets the last `days` of activity from transcripts (fresh, not
// the stale stats cache), oldest-first, with empty days filled in as zero.
func ScanTrends(days int) []DayStat {
	now := time.Now()
	cutoff := now.AddDate(0, 0, -(days - 1)).Truncate(24 * time.Hour)
	cutoffMs := cutoff.UnixMilli()

	buckets := map[string]*DayStat{}
	dayKey := func(ms int64) string {
		return time.UnixMilli(ms).Format("2006-01-02")
	}

	files, _ := filepath.Glob(filepath.Join(claudeDir(), "projects", "*", "*.jsonl"))
	for _, fp := range files {
		fi, err := os.Stat(fp)
		if err != nil || fi.ModTime().Before(cutoff) {
			continue
		}
		p := parseTranscript(fp)
		if p == nil {
			continue
		}
		for _, ev := range p.usage {
			if ev.tsMs < cutoffMs {
				continue
			}
			k := dayKey(ev.tsMs)
			b := buckets[k]
			if b == nil {
				b = &DayStat{Date: k}
				buckets[k] = b
			}
			b.Messages++
			b.Tokens += ev.input + ev.output + ev.cacheRead + ev.cacheWrite
		}
		for _, tc := range p.tools {
			if tc.Timestamp >= cutoffMs {
				k := dayKey(tc.Timestamp)
				b := buckets[k]
				if b == nil {
					b = &DayStat{Date: k}
					buckets[k] = b
				}
				b.ToolCalls++
			}
		}
	}

	// fill every day in range so the chart has continuous bars
	out := make([]DayStat, 0, days)
	for i := 0; i < days; i++ {
		d := cutoff.AddDate(0, 0, i)
		k := d.Format("2006-01-02")
		if b := buckets[k]; b != nil {
			out = append(out, *b)
		} else {
			out = append(out, DayStat{Date: k})
		}
	}
	return out
}

// ---------- environment (skills / plugins / mcp) ----------

func listDirNames(dir string) []string {
	entries, _ := os.ReadDir(dir)
	var out []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// projectSkills lists skill names under <cwd>/.claude/skills.
func projectSkills(cwd string) []string {
	if cwd == "" {
		return nil
	}
	return listDirNames(filepath.Join(cwd, ".claude", "skills"))
}

// ScanEnvironment inventories global skills, installed plugins, and MCP servers.
func ScanEnvironment() Environment {
	env := Environment{}

	for _, name := range listDirNames(filepath.Join(claudeDir(), "skills")) {
		env.Skills = append(env.Skills, NamedItem{Name: name})
	}

	env.Plugins = scanPlugins()
	env.MCP = scanMCP()
	return env
}

func scanPlugins() []NamedItem {
	raw, err := os.ReadFile(filepath.Join(claudeDir(), "plugins", "installed_plugins.json"))
	if err != nil {
		return nil
	}
	var doc struct {
		Plugins map[string][]struct {
			Version string `json:"version"`
			Scope   string `json:"scope"`
		} `json:"plugins"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	enabled := enabledPlugins()
	var out []NamedItem
	for name, insts := range doc.Plugins {
		ver := ""
		if len(insts) > 0 {
			ver = insts[0].Version
		}
		state := "disabled"
		if enabled[name] {
			state = "enabled"
		}
		out = append(out, NamedItem{Name: name, Detail: ver, State: state})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func enabledPlugins() map[string]bool {
	raw, err := os.ReadFile(filepath.Join(claudeDir(), "settings.json"))
	if err != nil {
		return nil
	}
	var s struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	_ = json.Unmarshal(raw, &s)
	return s.EnabledPlugins
}

func scanMCP() []NamedItem {
	seen := map[string]*NamedItem{}
	add := func(name, state string) {
		if name == "" {
			return
		}
		if it, ok := seen[name]; ok {
			if state != "" {
				it.State = state
			}
			return
		}
		seen[name] = &NamedItem{Name: name, State: state}
	}

	home, _ := os.UserHomeDir()
	if raw, err := os.ReadFile(filepath.Join(home, ".claude.json")); err == nil {
		var doc struct {
			MCPServers map[string]any `json:"mcpServers"`
			Projects   map[string]struct {
				MCPServers map[string]any `json:"mcpServers"`
			} `json:"projects"`
		}
		if json.Unmarshal(raw, &doc) == nil {
			for n := range doc.MCPServers {
				add(n, "enabled")
			}
			for _, p := range doc.Projects {
				for n := range p.MCPServers {
					add(n, "enabled")
				}
			}
		}
	}
	// servers flagged as needing auth
	if raw, err := os.ReadFile(filepath.Join(claudeDir(), "mcp-needs-auth-cache.json")); err == nil {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			for n := range m {
				add(n, "needs-auth")
			}
		}
	}

	out := make([]NamedItem, 0, len(seen))
	for _, it := range seen {
		out = append(out, *it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
