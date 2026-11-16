package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// runBridge runs the generated hook script against a fake rook and reports
// which events reached it.
func TestHookBridgeReviewRuns(t *testing.T) {
	var mu sync.Mutex
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, string(b))
		mu.Unlock()
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	require.NoError(t, err)
	port, _ := strconv.Atoi(portStr)
	script := filepath.Join(t.TempDir(), "rook-hook.sh")
	require.NoError(t, os.WriteFile(script, []byte(buildHookScript(port)), 0o755))

	tests := []struct {
		name    string
		review  bool
		event   string
		reaches bool
	}{
		{"normal session Stop reaches rook", false, "Stop", true},
		{"review run Stop is dropped", true, "Stop", false},
		{"review run SubagentStop is dropped", true, "SubagentStop", false},
		{"review run Notification is dropped", true, "Notification", false},
		{"review run PreToolUse still reaches the danger gate", true, "PreToolUse", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mu.Lock()
			got = nil
			mu.Unlock()
			cmd := exec.Command("sh", script)
			cmd.Env = os.Environ()
			if tc.review {
				cmd.Env = append(cmd.Env, "ROOK_REVIEW_RUN=1")
			}
			cmd.Stdin = strings.NewReader(`{"hook_event_name":"` + tc.event + `","cwd":"/x"}`)
			require.NoError(t, cmd.Run())
			mu.Lock()
			defer mu.Unlock()
			assert.Equal(t, tc.reaches, len(got) == 1, "events received: %v", got)
		})
	}
}

func TestRefreshHookScript(t *testing.T) {
	tests := []struct {
		name      string
		existing  string // "" = not installed
		rewritten bool
	}{
		{"not installed: nothing written", "", false},
		{"old script for this port is updated", "#!/bin/sh\ncurl http://127.0.0.1:7480/api/hook\n", true},
		{"script for another rook's port is left alone", "#!/bin/sh\ncurl http://127.0.0.1:7999/api/hook\n", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			p := filepath.Join(home, ".rook", "hooks", "rook-hook.sh")
			if tc.existing != "" {
				require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
				require.NoError(t, os.WriteFile(p, []byte(tc.existing), 0o755))
			}

			require.NoError(t, refreshHookScript())

			b, err := os.ReadFile(p)
			switch {
			case tc.existing == "":
				assert.True(t, os.IsNotExist(err))
			case tc.rewritten:
				assert.Equal(t, buildHookScript(portFromListenFlag()), string(b))
			default:
				assert.Equal(t, tc.existing, string(b))
			}
		})
	}
}
