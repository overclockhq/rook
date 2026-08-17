package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNotifStore_RecordAndListNewestFirst(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	recordNotif(Notification{Kind: "waiting", Title: "a"})
	recordNotif(Notification{Kind: "finished", Title: "b"})

	got := listNotifs(0)
	assert.Len(t, got, 2)
	// listNotifs returns newest first
	assert.Equal(t, "b", got[0].Title)
	assert.Equal(t, "a", got[1].Title)
	// record assigns an id + timestamp when absent
	assert.NotEmpty(t, got[0].ID)
	assert.NotZero(t, got[0].TS)
}

func TestNotifStore_CapAndLimit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	for range notifCap + 50 {
		recordNotif(Notification{Kind: "waiting", Title: "n"})
	}
	// disk is capped at notifCap (oldest evicted)
	assert.Len(t, listNotifs(0), notifCap)
	// limit truncates the returned slice
	assert.Len(t, listNotifs(10), 10)
}

func TestNotifStore_Clear(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	recordNotif(Notification{Kind: "waiting", Title: "a"})
	clearNotifs()
	assert.Empty(t, listNotifs(0))
}

func TestNotifStore_PersistsFieldsAcrossReads(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	recordNotif(Notification{Kind: "alert", Title: "x", SessionID: "s1", Project: "proj", Channels: []string{"native", "ntfy"}})
	// no in-memory cache — a fresh read hits disk and round-trips every field
	got := listNotifs(0)
	assert.Len(t, got, 1)
	assert.Equal(t, "s1", got[0].SessionID)
	assert.Equal(t, "proj", got[0].Project)
	assert.Equal(t, []string{"native", "ntfy"}, got[0].Channels)
}
