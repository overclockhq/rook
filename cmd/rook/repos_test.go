package main

import (
	"os"
	"path/filepath"
	"testing"
)

// mkRepo creates a directory that looks like a git checkout to the scanner.
func mkRepo(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// People do not keep every checkout one level under ~/Desktop/github. When a
// folder is named in Settings, the scan has to reach the repos actually in it,
// otherwise the launcher keeps asking for a working directory by hand.
func TestRepoDirsUnder(t *testing.T) {
	root := t.TempDir()
	shallow := mkRepo(t, filepath.Join(root, "one"))
	nested := mkRepo(t, filepath.Join(root, "org", "team", "deep"))
	mkRepo(t, filepath.Join(root, "org", "team", "deep", "vendor", "inner"))
	mkRepo(t, filepath.Join(root, ".hidden", "skipme"))

	has := func(got []string, want string) bool {
		for _, g := range got {
			if g == want {
				return true
			}
		}
		return false
	}

	t.Run("one level deep finds only direct children", func(t *testing.T) {
		got := repoDirsUnder(root, 1)
		if !has(got, shallow) {
			t.Errorf("want %s in %v", shallow, got)
		}
		if has(got, nested) {
			t.Errorf("depth 1 should not reach %s", nested)
		}
	})

	t.Run("a deeper budget reaches nested checkouts", func(t *testing.T) {
		got := repoDirsUnder(root, 3)
		if !has(got, nested) {
			t.Errorf("want %s in %v", nested, got)
		}
	})

	// Once a directory is a repo, everything under it belongs to that repo —
	// descending further only turns submodules and vendored copies into noise.
	t.Run("the scan stops at a repo", func(t *testing.T) {
		got := repoDirsUnder(root, 5)
		if has(got, filepath.Join(nested, "vendor", "inner")) {
			t.Errorf("should not descend into a repo: %v", got)
		}
	})

	t.Run("dot directories are skipped", func(t *testing.T) {
		for _, g := range repoDirsUnder(root, 5) {
			if filepath.Base(filepath.Dir(g)) == ".hidden" {
				t.Errorf("scanned a hidden directory: %s", g)
			}
		}
	})

	t.Run("the root itself counts when it is a repo", func(t *testing.T) {
		r2 := mkRepo(t, t.TempDir())
		if got := repoDirsUnder(r2, 1); !has(got, r2) {
			t.Errorf("want the root itself, got %v", got)
		}
	})
}

// The whole point of the setting is that it survives a restart, so a configured
// folder must actually be part of the scan.
func TestConfiguredRootsAreScanned(t *testing.T) {
	root := t.TempDir()
	want := mkRepo(t, filepath.Join(root, "a", "b", "proj"))

	roots := repoScanRoots([]string{root, "", "  " + root + "  "})
	found := false
	for _, p := range roots {
		for _, d := range repoDirsUnder(p, configuredRootDepth) {
			if d == want {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("a configured folder should surface %s; roots were %v", want, roots)
	}
}
