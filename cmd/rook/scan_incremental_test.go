package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	lineToolUse    = `{"type":"assistant","timestamp":"2026-07-03T10:00:00Z","message":{"model":"m1","content":[{"type":"tool_use","id":"tu_1","name":"Edit","input":{"file_path":"/r/a.go"}}],"usage":{"input_tokens":10,"output_tokens":5}}}`
	lineToolResult = `{"type":"user","timestamp":"2026-07-03T10:00:03Z","toolUseResult":"x","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":true}]}}`
	lineText       = `{"type":"assistant","timestamp":"2026-07-03T10:00:05Z","message":{"model":"m2","content":[{"type":"text","text":"done"},{"type":"tool_use","id":"tu_2","name":"Write","input":{"file_path":"/r/b.go"}}],"usage":{"input_tokens":7,"output_tokens":3}}}`
)

func appendFile(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	require.NoError(t, err)
	_, err = f.WriteString(s)
	require.NoError(t, err)
	require.NoError(t, f.Close())
	// Make the change visible even on filesystems with coarse mtimes.
	later := time.Now().Add(time.Duration(len(s)) * time.Millisecond)
	require.NoError(t, os.Chtimes(path, later, later))
}

func freshCache(t *testing.T) {
	t.Helper()
	cacheMu.Lock()
	prev := cache
	cache = map[string]*transcriptCache{}
	cacheMu.Unlock()
	t.Cleanup(func() { cacheMu.Lock(); cache = prev; cacheMu.Unlock() })
}

// Parsing a growing file in steps must give exactly what one full read gives.
func TestParseTranscript_IncrementalMatchesFullRead(t *testing.T) {
	freshCache(t)
	f := filepath.Join(t.TempDir(), "s.jsonl")
	appendFile(t, f, lineToolUse+"\n")

	first := parseTranscript(f)
	require.Len(t, first.tools, 1)
	assert.Zero(t, first.tools[0].DurMs, "result not seen yet")

	// The result arrives in a later write: it must back-fill the earlier tool.
	appendFile(t, f, lineToolResult+"\n")
	second := parseTranscript(f)
	assert.Equal(t, int64(3000), second.tools[0].DurMs)
	assert.True(t, second.tools[0].IsError)

	// A half-written line is not consumed until its newline lands.
	half := len(lineText) / 2
	appendFile(t, f, lineText[:half])
	partial := parseTranscript(f)
	assert.Len(t, partial.tools, 1, "partial line ignored")
	appendFile(t, f, lineText[half:]+"\n")
	final := parseTranscript(f)

	assert.Equal(t, readTranscript(f), final, "incremental parse equals a full re-read")
	assert.Equal(t, "m2", final.model)
	assert.Equal(t, int64(25), final.tokensTotal)
	assert.ElementsMatch(t, []string{"/r/a.go", "/r/b.go"}, final.changedFiles)
	assert.Equal(t, "done", final.lastText)
}

// Earlier snapshots are not changed by later parsing (callers keep them).
func TestParseTranscript_SnapshotIsStable(t *testing.T) {
	freshCache(t)
	f := filepath.Join(t.TempDir(), "s.jsonl")
	appendFile(t, f, lineToolUse+"\n")
	first := parseTranscript(f)

	appendFile(t, f, lineToolResult+"\n"+lineText+"\n")
	_ = parseTranscript(f)

	assert.Len(t, first.tools, 1)
	assert.Zero(t, first.tools[0].DurMs, "back-fill must not reach an old snapshot")
	assert.Len(t, first.usage, 1)
}

// Unchanged files are served from cache; a replaced or shrunk file is re-read.
func TestParseTranscript_CacheAndRewrite(t *testing.T) {
	freshCache(t)
	dir := t.TempDir()
	f := filepath.Join(dir, "s.jsonl")
	appendFile(t, f, lineToolUse+"\n"+lineText+"\n")
	a := parseTranscript(f)
	assert.Same(t, a, parseTranscript(f), "unchanged file: same cached snapshot")

	// Rewritten in place with shorter content.
	require.NoError(t, os.WriteFile(f, []byte(lineToolUse+"\n"), 0o644))
	shrunk := parseTranscript(f)
	assert.Len(t, shrunk.tools, 1)
	assert.Equal(t, "m1", shrunk.model)

	// Replaced by a different file at the same path.
	g := filepath.Join(dir, "new.jsonl")
	require.NoError(t, os.WriteFile(g, []byte(lineText+"\n"), 0o644))
	require.NoError(t, os.Rename(g, f))
	replaced := parseTranscript(f)
	require.Len(t, replaced.tools, 1)
	assert.Equal(t, "Write", replaced.tools[0].Name)

	assert.Nil(t, parseTranscript(filepath.Join(dir, "missing.jsonl")))
}

func TestConsumeFrom_UnreadableFile(t *testing.T) {
	st := newTranscriptState()
	assert.Equal(t, int64(42), st.consumeFrom(filepath.Join(t.TempDir(), "missing"), 42), "offset kept")
}

// Already-read bytes are never read again: scribble over the first line in
// place, append a new one, and the first tool must survive.
func TestParseTranscript_ReadsOnlyAppendedBytes(t *testing.T) {
	freshCache(t)
	f := filepath.Join(t.TempDir(), "s.jsonl")
	appendFile(t, f, lineToolUse+"\n")
	require.Len(t, parseTranscript(f).tools, 1)

	h, err := os.OpenFile(f, os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = h.WriteAt([]byte("XXXXXXXXXX"), 0)
	require.NoError(t, err)
	require.NoError(t, h.Close())
	appendFile(t, f, lineText+"\n")

	got := parseTranscript(f)
	assert.Len(t, got.tools, 2, "a full re-read would drop the scribbled first tool")
}
