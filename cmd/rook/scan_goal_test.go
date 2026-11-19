package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	goalSet     = `{"type":"attachment","timestamp":"2026-11-16T09:50:11Z","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"all tours pass"}}`
	goalCheckIn = `{"type":"user","timestamp":"2026-11-16T11:04:22Z","message":{"role":"user","content":"Goal check-in: «all tours pass» is still active, and evaluation has been deferred for 59 min because background work is still running:\n- b1 · shell · npm test\nCheck on their progress."}}`
	goalMet     = `{"type":"attachment","timestamp":"2026-11-16T12:00:00Z","attachment":{"type":"goal_status","met":true,"condition":"all tours pass"}}`
	goalOther   = `{"type":"attachment","timestamp":"2026-11-16T13:00:00Z","attachment":{"type":"goal_status","met":false,"condition":"bundle growth is 0 kB"}}`
	userPlain   = `{"type":"user","timestamp":"2026-11-16T10:00:00Z","message":{"role":"user","content":"Goal check-in looks like this but there is no goal yet"}}`
)

func transcriptOf(t *testing.T, lines ...string) *parsedTranscript {
	t.Helper()
	f := filepath.Join(t.TempDir(), "s.jsonl")
	appendFile(t, f, strings.Join(lines, "\n")+"\n")
	return readTranscript(f)
}

func TestTrackGoal(t *testing.T) {
	t.Run("no goal", func(t *testing.T) {
		assert.Nil(t, transcriptOf(t, userPlain, lineText).goal)
	})
	t.Run("set then checked in", func(t *testing.T) {
		g := transcriptOf(t, goalSet, goalCheckIn).goal
		require.NotNil(t, g)
		assert.Equal(t, "all tours pass", g.Condition)
		assert.Equal(t, parseTS("2026-11-16T09:50:11Z"), g.SetAt)
		assert.False(t, g.Met)
		assert.Equal(t, 1, g.CheckIns)
		assert.Equal(t, parseTS("2026-11-16T11:04:22Z"), g.LastCheckIn)
		assert.Equal(t, "evaluation has been deferred for 59 min because background work is still running", g.LastNote)
	})
	t.Run("met", func(t *testing.T) {
		g := transcriptOf(t, goalSet, goalCheckIn, goalMet).goal
		require.NotNil(t, g)
		assert.True(t, g.Met)
		assert.Equal(t, parseTS("2026-11-16T12:00:00Z"), g.MetAt)
		assert.Equal(t, 1, g.CheckIns, "same goal keeps its history")
	})
	t.Run("a new goal replaces the old one", func(t *testing.T) {
		g := transcriptOf(t, goalSet, goalCheckIn, goalMet, goalOther).goal
		require.NotNil(t, g)
		assert.Equal(t, "bundle growth is 0 kB", g.Condition)
		assert.False(t, g.Met)
		assert.Zero(t, g.CheckIns)
	})
	t.Run("cleared and met by message", func(t *testing.T) {
		cleared := `{"type":"user","timestamp":"2026-11-16T12:30:00Z","message":{"role":"user","content":"Goal cleared."}}`
		assert.True(t, transcriptOf(t, goalSet, cleared).goal.Cleared)
		met := `{"type":"user","timestamp":"2026-11-16T12:30:00Z","message":{"role":"user","content":"Goal met: all tours pass"}}`
		assert.True(t, transcriptOf(t, goalSet, met).goal.Met)
	})
	t.Run("user message with blocks is ignored", func(t *testing.T) {
		blocks := `{"type":"user","timestamp":"2026-11-16T12:30:00Z","message":{"role":"user","content":[{"type":"text","text":"Goal cleared"}]}}`
		assert.False(t, transcriptOf(t, goalSet, blocks).goal.Cleared)
	})
	t.Run("snapshot owns its goal", func(t *testing.T) {
		freshCache(t)
		f := filepath.Join(t.TempDir(), "s.jsonl")
		appendFile(t, f, goalSet+"\n")
		first := parseTranscript(f)
		appendFile(t, f, goalCheckIn+"\n")
		require.Equal(t, 1, parseTranscript(f).goal.CheckIns)
		assert.Zero(t, first.goal.CheckIns, "earlier snapshot unchanged")
	})
}
