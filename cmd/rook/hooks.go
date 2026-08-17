package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// The hooks bridge lets Claude Code push lifecycle events to rook (real-time
// notifications instead of polling) and lets rook gate risky tool calls before
// they run (PreToolUse deny). rook installs a tiny wrapper script into
// ~/.claude/settings.json that pipes each event's JSON to POST /api/hook and
// relays rook's JSON reply back to Claude Code.

// hookMarker identifies rook's own settings.json entries so uninstall removes
// only ours and never touches the user's other hooks.
const hookMarker = "rook-hook.sh"

// rookHookEvents are the Claude Code lifecycle events rook subscribes to.
var rookHookEvents = []string{"Notification", "PreToolUse", "Stop", "SubagentStop"}

// dangerRules are clearly-destructive command patterns the PreToolUse gate
// blocks when gating is enabled. Conservative on purpose — false denies are
// worse than a missed catch here, since the user can always run it themselves.
// dangerRules are the authoritative BLOCK ruleset, deliberately conservative
// (false denies are worse than a missed catch — the user can always run it
// themselves). Case-insensitive so a lowercase `drop table` is caught, not just
// the SQL-shouted form. The audit view keeps a broader *advisory* set; this one
// is the subset rook will actually deny.
var dangerRules = []struct {
	re     *regexp.Regexp
	reason string
}{
	{regexp.MustCompile(`(?i)\brm\s+-\S*r\S*\s+(/|~|\$HOME)(/|\s|$)`), "rm -rf on a root/home path"},
	{regexp.MustCompile(`(?i)\bgit\s+push\b.*--force\b.*\b(main|master)\b`), "force-push to main/master"},
	{regexp.MustCompile(`(?i)\bgit\s+reset\s+--hard\b.*\borigin/(main|master)\b`), "hard reset onto origin main/master"},
	{regexp.MustCompile(`(?i)\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b`), "destructive SQL (DROP/TRUNCATE)"},
	{regexp.MustCompile(`(?i):\s*>\s*/dev/sd[a-z]`), "writing to a raw disk device"},
}

// hookRecord is one received event, kept in a ring buffer for the events feed.
type hookRecord struct {
	Time    int64  `json:"time"`
	Event   string `json:"event"`
	Tool    string `json:"tool,omitempty"`
	Detail  string `json:"detail,omitempty"`
	Project string `json:"project,omitempty"`
	Gated   string `json:"gated,omitempty"` // "deny" when the gate blocked it
}

var (
	hookMu   sync.Mutex
	hookRing []hookRecord
)

func recordHook(r hookRecord) {
	hookMu.Lock()
	defer hookMu.Unlock()
	hookRing = append(hookRing, r)
	if len(hookRing) > 300 {
		hookRing = hookRing[len(hookRing)-300:]
	}
}

func rookDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rook")
}

// handleHook ingests one Claude Code hook event. For PreToolUse it may return a
// gate decision; other events return an empty object (no-op for Claude Code).
func handleHook(ctx *gofr.Context) (any, error) {
	var raw map[string]any
	if err := ctx.Bind(&raw); err != nil {
		return nil, errf(http.StatusBadRequest, "bad hook payload")
	}
	event := str(raw["hook_event_name"])
	tool := str(raw["tool_name"])
	cwd := str(raw["cwd"])
	rec := hookRecord{Time: time.Now().UnixMilli(), Event: event, Tool: tool, Project: projectName(cwd)}

	switch event {
	case "Notification":
		msg := str(raw["message"])
		rec.Detail = msg
		banner("Claude Code", projectName(cwd), msg, "")
		if c := loadConfig(); c.Ntfy != "" {
			pushNtfy("Claude Code · "+projectName(cwd), msg, "")
		}
		pushChat("Claude Code · "+projectName(cwd), msg) // Slack/Discord if configured
		recordNotif(Notification{Kind: "hook", Title: "Claude Code · " + projectName(cwd), Body: msg, Project: projectName(cwd), Channels: notifChannels(true, true)})
	case "Stop", "SubagentStop":
		rec.Detail = "session finished"
		if event == "Stop" {
			onSessionFinished(cwd) // fire auto-review / auto-verify if enabled
		}
	case "PreToolUse":
		if in := toolInputString(raw["tool_input"]); in != "" {
			rec.Detail = clip(in, 120)
		}
		if loadConfig().HooksGate {
			if reason := dangerReason(tool, raw["tool_input"]); reason != "" {
				rec.Gated = "deny"
				recordHook(rec)
				// Narrate the block — a silent deny leaves the user wondering why
				// the agent stalled. Surface it on every configured channel.
				proj := projectName(cwd)
				banner("🛑 rook blocked a command", proj, reason+": "+clip(rec.Detail, 160), "Sosumi")
				pushNtfy("rook blocked "+proj, reason+": "+clip(rec.Detail, 200), "high")
				pushChat("rook blocked "+proj, reason+": "+clip(rec.Detail, 200))
				recordNotif(Notification{Kind: "blocked", Title: "rook blocked " + proj, Body: reason + ": " + clip(rec.Detail, 200), Project: proj, Channels: notifChannels(true, true)})
				return rawJSON(map[string]any{
					"hookSpecificOutput": map[string]any{
						"hookEventName":            "PreToolUse",
						"permissionDecision":       "deny",
						"permissionDecisionReason": "rook gate: " + reason + " (enable/disable in rook Settings)",
					},
				})
			}
		}
	}
	recordHook(rec)
	return rawJSON(map[string]any{})
}

// dangerReason returns a non-empty reason when a tool call matches a destructive
// pattern. Only inspects shell-ish tools where a command string is present.
func dangerReason(tool string, input any) string {
	cmd := toolInputString(input)
	if cmd == "" {
		return ""
	}
	for _, r := range dangerRules {
		if r.re.MatchString(cmd) {
			return r.reason
		}
	}
	return ""
}

// toolInputString pulls the command/content string out of a tool_input object.
func toolInputString(input any) string {
	m, ok := input.(map[string]any)
	if !ok {
		return ""
	}
	for _, k := range []string{"command", "content", "new_string", "file_path"} {
		if v := str(m[k]); v != "" {
			return v
		}
	}
	return ""
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// ---- events feed ----

func handleHookEvents(ctx *gofr.Context) (any, error) {
	hookMu.Lock()
	defer hookMu.Unlock()
	out := make([]hookRecord, len(hookRing))
	copy(out, hookRing)
	// newest first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return rawJSON(out)
}

// ---- install / uninstall / status ----

type hooksStatus struct {
	Installed    bool   `json:"installed"`
	Gate         bool   `json:"gate"`
	SettingsPath string `json:"settingsPath"`
	ScriptPath   string `json:"scriptPath"`
	Events       int    `json:"events"`
}

func hookScriptPath() string { return filepath.Join(rookDir(), "hooks", "rook-hook.sh") }
func settingsPath() string   { return filepath.Join(claudeDir(), "settings.json") }

func handleHooksStatus(ctx *gofr.Context) (any, error) {
	hookMu.Lock()
	n := len(hookRing)
	hookMu.Unlock()
	return rawJSON(hooksStatus{
		Installed:    hooksInstalled(),
		Gate:         loadConfig().HooksGate,
		SettingsPath: settingsPath(),
		ScriptPath:   hookScriptPath(),
		Events:       n,
	})
}

// hooksInstalled reports whether rook's hook entries are present in settings.json.
func hooksInstalled() bool {
	b, err := os.ReadFile(settingsPath())
	if err != nil {
		return false
	}
	return strings.Contains(string(b), hookMarker)
}

func handleHooksInstall(ctx *gofr.Context) (any, error) {
	if err := writeHookScript(); err != nil {
		return nil, errf(http.StatusInternalServerError, "write hook script: %v", err)
	}
	if err := mergeHooksIntoSettings(true); err != nil {
		return nil, errf(http.StatusInternalServerError, "update settings.json: %v", err)
	}
	return handleHooksStatus(ctx)
}

func handleHooksUninstall(ctx *gofr.Context) (any, error) {
	if err := mergeHooksIntoSettings(false); err != nil {
		return nil, errf(http.StatusInternalServerError, "update settings.json: %v", err)
	}
	return handleHooksStatus(ctx)
}

// backstopPattern is the fail-safe denylist the hook script greps LOCALLY when
// rook is unreachable, so the gate is never silently off. Deliberately broader
// than dangerRules (it runs blind, without rook) but fires only on clearly
// catastrophic commands. POSIX ERE so it works with both BSD and GNU grep -E.
const backstopPattern = `rm[[:space:]]+-[[:alnum:]]*[rf][[:alnum:]]*[[:space:]]+(/|~|\$HOME)|git[[:space:]]+push.*--force|mkfs|dd[[:space:]].*of=/dev/|>[[:space:]]*/dev/sd|(DROP|TRUNCATE)[[:space:]]+(TABLE|DATABASE)`

// hookScriptTmpl is the wrapper installed into settings.json. __PORT__ and
// __PATTERN__ are substituted at install time (string replace, so no fmt
// %-escaping in the shell body can get it wrong).
const hookScriptTmpl = `#!/bin/sh
# rook hooks bridge — installed by rook. Pipes each Claude Code hook event to
# rook and relays rook's JSON reply (used for PreToolUse gating). If rook is
# unreachable, a local backstop still blocks catastrophic commands so the gate
# is never silently OFF: the old script exited 0 with no output on failure,
# which Claude Code reads as "allow" (fail-open).
payload=$(cat)
resp=$(printf '%s' "$payload" | curl -s -m 5 -X POST "http://127.0.0.1:__PORT__/api/hook" \
  -H "Content-Type: application/json" --data-binary @- 2>/dev/null)
if [ -n "$resp" ]; then
  printf '%s' "$resp"
  exit 0
fi
# rook unreachable: fail SAFE on PreToolUse — deny only clearly-catastrophic
# commands, let everything else through so agents aren't frozen when rook is down.
case "$payload" in
  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name": "PreToolUse"'*)
    if printf '%s' "$payload" | grep -Eiq '__PATTERN__'; then
      printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"rook gate offline — blocked a destructive-looking command for safety. Start rook, or disable the gate in Settings."}}'
    fi
    ;;
esac
exit 0
`

// buildHookScript substitutes the port + backstop pattern into the wrapper.
func buildHookScript(port int) string {
	return strings.NewReplacer(
		"__PORT__", fmt.Sprint(port),
		"__PATTERN__", backstopPattern,
	).Replace(hookScriptTmpl)
}

// writeHookScript writes the wrapper that pipes a hook event to rook and relays
// rook's reply, with a local fail-safe backstop for when rook is unreachable.
func writeHookScript() error {
	dir := filepath.Dir(hookScriptPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(hookScriptPath(), []byte(buildHookScript(portFromListenFlag())), 0o755)
}

// mergeHooksIntoSettings adds (add=true) or removes rook's hook entries in
// ~/.claude/settings.json, preserving every other key and the user's own hooks.
func mergeHooksIntoSettings(add bool) error {
	path := settingsPath()
	settings := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		if err := json.Unmarshal(b, &settings); err != nil {
			return fmt.Errorf("settings.json is not valid JSON: %w", err)
		}
	}
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	cmd := hookScriptPath()
	for _, ev := range rookHookEvents {
		groups, _ := hooks[ev].([]any)
		// drop any existing rook entries for this event
		kept := groups[:0:0]
		for _, g := range groups {
			if !groupHasMarker(g) {
				kept = append(kept, g)
			}
		}
		if add {
			entry := map[string]any{
				"hooks": []any{map[string]any{"type": "command", "command": cmd}},
			}
			if ev == "PreToolUse" {
				entry["matcher"] = "*"
			}
			kept = append(kept, entry)
		}
		if len(kept) == 0 {
			delete(hooks, ev)
		} else {
			hooks[ev] = kept
		}
	}
	if len(hooks) == 0 {
		delete(settings, "hooks")
	} else {
		settings["hooks"] = hooks
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

// groupHasMarker reports whether a settings hook-group is one of rook's.
func groupHasMarker(g any) bool {
	b, _ := json.Marshal(g)
	return strings.Contains(string(b), hookMarker)
}
