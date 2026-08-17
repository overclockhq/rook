package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// The interactive terminal: a real PTY bridged to the browser over a WebSocket.
// The client runs xterm.js and streams raw keystrokes here; we run
// `tmux attach-session` inside a PTY so the browser tab behaves exactly like
// iTerm attached to the agent — arrow keys, tab-completion, Ctrl-sequences,
// full-screen TUIs (Claude Code's UI) all work. Killing this attach client only
// detaches; the agent's tmux session keeps running.

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	// The access guard already restricts non-loopback clients (loopback-only by
	// default; token required otherwise), so any request reaching here is allowed.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 && n < 1000 {
		return n
	}
	return def
}

// handleTermWS upgrades to a WebSocket and bridges it to `tmux attach` in a PTY.
func handleTermWS(w http.ResponseWriter, r *http.Request) {
	if tmuxBin == "" {
		http.Error(w, "tmux not installed", http.StatusServiceUnavailable)
		return
	}
	target := r.URL.Query().Get("target")
	if !paneTargetRe.MatchString(target) {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	// Resolve to a session name so attach works whether target is a pane (%12) or
	// a session name, and so we control the whole session.
	sess := target
	if out, err := runTmux("display-message", "-p", "-t", target, "#{session_name}"); err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			sess = s
		}
	}
	cols := atoiDefault(r.URL.Query().Get("cols"), 120)
	rows := atoiDefault(r.URL.Query().Get("rows"), 32)

	// Enable tmux mouse mode + a deeper scrollback so the browser mouse wheel
	// scrolls the pane's history (via tmux copy-mode) instead of being translated
	// into up/down arrow keys to the shell. And make the tmux window track THIS
	// client's size (window-size latest + aggressive-resize) so the pane fills the
	// browser terminal instead of staying at the detached 220x50 default and
	// leaving a black void below the status bar. All best-effort.
	_, _ = runTmux("set-option", "-t", sess, "mouse", "on")
	_, _ = runTmux("set-option", "-t", sess, "history-limit", "20000")
	_, _ = runTmux("set-option", "-t", sess, "window-size", "latest")
	_, _ = runTmux("set-option", "-t", sess, "aggressive-resize", "on")

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // upgrade writes its own error
	}
	defer conn.Close()

	cmd := exec.Command(tmuxBin, "attach-session", "-t", sess)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\n[rook] failed to attach: "+err.Error()+"\r\n"))
		return
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill() // detaches this client; the session survives
		}
		_ = cmd.Wait()
	}()

	var once sync.Once
	done := make(chan struct{})
	closeAll := func() { once.Do(func() { close(done) }) }

	// PTY output -> browser (binary frames)
	go func() {
		buf := make([]byte, 16384)
		for {
			n, rerr := ptmx.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		closeAll()
	}()

	// browser keystrokes + resize control -> PTY
	go func() {
		for {
			mt, data, rerr := conn.ReadMessage()
			if rerr != nil {
				break
			}
			// a JSON text frame starting with '{' is a control message: {"resize":[cols,rows]}
			if mt == websocket.TextMessage && len(data) > 0 && data[0] == '{' {
				var m struct {
					Resize []int `json:"resize"`
				}
				if json.Unmarshal(data, &m) == nil && len(m.Resize) == 2 {
					_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(m.Resize[0]), Rows: uint16(m.Resize[1])})
					continue
				}
			}
			if _, werr := ptmx.Write(data); werr != nil {
				break
			}
		}
		closeAll()
	}()

	<-done
}

// termWSMiddleware intercepts the terminal WebSocket path before GoFr's router
// (which is JSON/response oriented and would mangle a raw byte stream). Everything
// else falls through to GoFr unchanged.
func termWSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws/term" {
			handleTermWS(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
