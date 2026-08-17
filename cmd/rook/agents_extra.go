package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// These adapters (Aider, Gemini) are BETA and unverified against real data.
// They're bounded and TTL-cached so they never slow the 2s poll.

type sessCache struct {
	mu   sync.Mutex
	at   time.Time
	data []Session
}

func (c *sessCache) get(ttl time.Duration, build func() []Session) []Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < ttl && c.data != nil {
		return c.data
	}
	c.data = build()
	c.at = time.Now()
	return c.data
}

func shortHash(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}

// ---------- Aider (.aider.chat.history.md per repo) ----------

var aiderCache sessCache

// ScanAiderSessions finds .aider.chat.history.md files a few levels under $HOME
// (Aider has no central registry) and surfaces each as a session. BETA.
func ScanAiderSessions(maxTools int) []Session {
	return aiderCache.get(30*time.Second, func() []Session { return scanAider() })
}

func scanAider() []Session {
	home, _ := os.UserHomeDir()
	if home == "" {
		return nil
	}
	var files []string
	for _, pat := range []string{
		filepath.Join(home, "*", ".aider.chat.history.md"),
		filepath.Join(home, "*", "*", ".aider.chat.history.md"),
		filepath.Join(home, "*", "*", "*", ".aider.chat.history.md"),
	} {
		m, _ := filepath.Glob(pat)
		files = append(files, m...)
	}
	now := time.Now()
	cutoff := now.Add(-14 * 24 * time.Hour)
	var out []Session
	for _, fp := range files {
		fi, err := os.Stat(fp)
		if err != nil || fi.ModTime().Before(cutoff) {
			continue
		}
		cwd := filepath.Dir(fp)
		age := now.Sub(fi.ModTime())
		s := Session{
			Provider:  "aider",
			SessionID: "aider-" + shortHash(fp),
			CWD:       cwd,
			Project:   projectName(cwd),
			Title:     projectName(cwd),
			UpdatedAt: fi.ModTime().UnixMilli(),
			Alive:     age < 10*time.Minute,
			Status:    recencyStatus(age),
			Summary:   "aider chat history (" + humanBytes(fi.Size()) + ")",
		}
		out = append(out, s)
	}
	return out
}

// ---------- Gemini CLI (~/.gemini/tmp/<hash>/logs.json) ----------

var geminiCache sessCache

// ScanGeminiSessions reads Gemini CLI session logs. BETA — the logs.json schema
// isn't fully public, so parsing is defensive.
func ScanGeminiSessions(maxTools int) []Session {
	return geminiCache.get(30*time.Second, func() []Session { return scanGemini() })
}

func scanGemini() []Session {
	home, _ := os.UserHomeDir()
	base := filepath.Join(home, ".gemini", "tmp")
	if _, err := os.Stat(base); err != nil {
		return nil
	}
	files, _ := filepath.Glob(filepath.Join(base, "*", "logs.json"))
	chats, _ := filepath.Glob(filepath.Join(base, "*", "chats", "*.json"))
	files = append(files, chats...)

	now := time.Now()
	cutoff := now.Add(-14 * 24 * time.Hour)
	var out []Session
	for _, fp := range files {
		fi, err := os.Stat(fp)
		if err != nil || fi.ModTime().Before(cutoff) {
			continue
		}
		age := now.Sub(fi.ModTime())
		s := Session{
			Provider:  "gemini",
			SessionID: "gemini-" + shortHash(fp),
			UpdatedAt: fi.ModTime().UnixMilli(),
			Alive:     age < 10*time.Minute,
			Status:    recencyStatus(age),
		}
		msgs := geminiMsgCount(fp)
		if s.CWD == "" {
			s.CWD = filepath.Base(filepath.Dir(fp)) // project hash (cwd not recoverable)
		}
		s.Project = "gemini"
		s.Title = "gemini session"
		if msgs > 0 {
			s.Summary = plural(msgs, "message", "messages")
		} else {
			s.Summary = "gemini session"
		}
		out = append(out, s)
	}
	return out
}

// geminiMsgCount counts entries in a logs/chat json defensively.
func geminiMsgCount(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var arr []any
	if json.Unmarshal(raw, &arr) == nil {
		return len(arr)
	}
	var obj struct {
		Messages []any `json:"messages"`
		History  []any `json:"history"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if len(obj.Messages) > 0 {
			return len(obj.Messages)
		}
		return len(obj.History)
	}
	// fall back to counting lines (jsonl)
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) != "" {
			n++
		}
	}
	return n
}

// ---------- shared helpers ----------

func recencyStatus(age time.Duration) string {
	if age < 90*time.Second {
		return "busy"
	}
	return "idle"
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return itoa(int(n>>20)) + "MB"
	case n >= 1<<10:
		return itoa(int(n>>10)) + "KB"
	default:
		return itoa(int(n)) + "B"
	}
}
