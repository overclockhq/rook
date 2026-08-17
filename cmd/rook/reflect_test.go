package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReflectionBuffer(t *testing.T) {
	entries := []struct {
		label   string
		failure string
	}{
		{"1", "FAIL: TestFoo — nil pointer dereference in store.go:42"},
		{"2", "build failed: undefined: GetAllActiveByOrg in service.go:88"},
	}

	t.Run("fresh dir returns empty/zero", func(t *testing.T) {
		fresh := t.TempDir()
		if got := reflectionAttempts(fresh); got != 0 {
			t.Fatalf("fresh reflectionAttempts = %d, want 0", got)
		}
		if got := reflectionContext(fresh); got != "" {
			t.Fatalf("fresh reflectionContext = %q, want empty", got)
		}
	})

	t.Run("accumulates and injects", func(t *testing.T) {
		wt := t.TempDir()
		for _, e := range entries {
			if err := writeReflection(wt, e.label, e.failure); err != nil {
				t.Fatalf("writeReflection(%s): %v", e.label, err)
			}
		}

		if got := reflectionAttempts(wt); got != 2 {
			t.Fatalf("reflectionAttempts = %d, want 2", got)
		}

		ctxBlock := reflectionContext(wt)
		if ctxBlock == "" {
			t.Fatal("reflectionContext is empty after 2 writes")
		}
		for _, e := range entries {
			if !strings.Contains(ctxBlock, e.failure) {
				t.Errorf("reflectionContext missing failure snippet %q", e.failure)
			}
		}
		// each attempt label must appear as a distinct heading
		for _, e := range entries {
			if !strings.Contains(ctxBlock, reflectEntryMarker+e.label) {
				t.Errorf("reflectionContext missing heading for attempt %s", e.label)
			}
		}
	})
}

func TestReflectionAttemptsRO(t *testing.T) {
	dir := t.TempDir()
	// RO on a fresh worktree returns 0 and must NOT create the buffer dir
	if got := reflectionAttemptsRO(dir); got != 0 {
		t.Fatalf("RO fresh = %d, want 0", got)
	}
	if _, err := os.Stat(filepath.Join(dir, reflectDirName)); !os.IsNotExist(err) {
		t.Fatalf("reflectionAttemptsRO created %s — it must be read-only", reflectDirName)
	}
	// after two reflections, RO counts them (without ever creating the dir itself)
	if err := writeReflection(dir, "1", "boom"); err != nil {
		t.Fatal(err)
	}
	if err := writeReflection(dir, "2", "boom again"); err != nil {
		t.Fatal(err)
	}
	if got := reflectionAttemptsRO(dir); got != 2 {
		t.Fatalf("RO after 2 writes = %d, want 2", got)
	}
	// empty worktree path is safe
	if got := reflectionAttemptsRO(""); got != 0 {
		t.Fatalf("RO empty = %d, want 0", got)
	}
}
