package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// Notification is one alert rook generated. Every notification the app fires
// (native banner, ntfy push, Slack/Discord) is also recorded here so the UI can
// show a searchable history — the banners themselves are ephemeral.
type Notification struct {
	ID        string   `json:"id"`
	TS        int64    `json:"ts"`                  // unix millis
	Kind      string   `json:"kind"`                // waiting|alert|finished|hook|blocked|verify
	Title     string   `json:"title"`               // headline (may include an emoji + project)
	Body      string   `json:"body,omitempty"`      // the detail line
	Project   string   `json:"project,omitempty"`   // repo / project the agent is in
	SessionID string   `json:"sessionId,omitempty"` // for click-through to the agent
	Channels  []string `json:"channels,omitempty"`  // native|ntfy|slack|discord it went out on
}

// notifCap bounds the on-disk history so it can't grow without limit. Oldest
// entries are evicted first.
const notifCap = 500

// Decision: store notifications on disk with no in-memory cache.
// Volume is low (a handful per work session), so a read-modify-write of a
// small JSON file per event is cheap, and going straight to disk keeps the
// store trivially correct under concurrent writers and easy to test (the path
// follows $HOME, so a test just swaps HOME — no cache to reset between cases).
var (
	notifMu  sync.Mutex
	notifSeq int64 // disambiguates two notifications recorded in the same millisecond
)

func notifStorePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rook", "notifications.json")
}

func readNotifs() []Notification {
	var ns []Notification
	if b, err := os.ReadFile(notifStorePath()); err == nil {
		_ = json.Unmarshal(b, &ns)
	}
	return ns
}

func writeNotifs(ns []Notification) {
	if b, err := json.MarshalIndent(ns, "", "  "); err == nil {
		_ = os.MkdirAll(filepath.Dir(notifStorePath()), 0o755)
		_ = os.WriteFile(notifStorePath(), b, 0o644)
	}
}

// recordNotif appends a generated notification to the persistent history (stored
// oldest-first on disk; listNotifs returns newest-first). Best-effort: a storage
// failure must never break the actual notification, so errors are swallowed.
func recordNotif(n Notification) {
	if n.TS == 0 {
		n.TS = time.Now().UnixMilli()
	}
	notifMu.Lock()
	defer notifMu.Unlock()
	notifSeq++
	if n.ID == "" {
		n.ID = strconv.FormatInt(n.TS, 10) + "-" + strconv.FormatInt(notifSeq, 10)
	}
	ns := append(readNotifs(), n)
	if len(ns) > notifCap {
		ns = ns[len(ns)-notifCap:]
	}
	writeNotifs(ns)
}

// listNotifs returns the most recent notifications, newest first. limit <= 0
// returns all of them.
func listNotifs(limit int) []Notification {
	notifMu.Lock()
	defer notifMu.Unlock()
	ns := readNotifs()
	out := make([]Notification, 0, len(ns))
	for i := len(ns) - 1; i >= 0; i-- {
		out = append(out, ns[i])
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func clearNotifs() {
	notifMu.Lock()
	defer notifMu.Unlock()
	writeNotifs([]Notification{})
}

// notifChannels reports which channels a notification reaches given current
// config. native is always present; ntfy/slack/discord appear only when the
// firing site pushes to them AND that channel is configured — so the history
// reflects where each alert actually went.
func notifChannels(ntfy, chat bool) []string {
	ch := []string{"native"}
	c := loadConfig()
	if ntfy && c.Ntfy != "" {
		ch = append(ch, "ntfy")
	}
	if chat {
		if c.SlackWebhook != "" {
			ch = append(ch, "slack")
		}
		if c.DiscordWebhook != "" {
			ch = append(ch, "discord")
		}
	}
	return ch
}

// ---- API ----

func handleNotifications(ctx *gofr.Context) (any, error) {
	limit := 200
	if v, err := strconv.Atoi(ctx.Param("limit")); err == nil && v > 0 {
		limit = v
	}
	return listNotifs(limit), nil
}

func handleNotificationsClear(ctx *gofr.Context) (any, error) {
	clearNotifs()
	return map[string]any{"ok": true}, nil
}
