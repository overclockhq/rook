package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSaveConfig(t *testing.T) {
	tests := []struct {
		name     string
		existing string // "" = no file yet
		save     Config
		want     map[string]any
	}{
		{
			name:     "keeps keys this build does not know",
			existing: `{"ntfy":"old","futureSetting":["x"],"handEdited":{"a":1}}`,
			save:     Config{Ntfy: "new"},
			want: map[string]any{
				"ntfy": "new", "futureSetting": []any{"x"}, "handEdited": map[string]any{"a": float64(1)},
			},
		},
		{
			name:     "known fields overwrite old values",
			existing: `{"autoReview":true,"reviewPasses":3}`,
			save:     Config{AutoReview: false, ReviewPasses: 1},
			want:     map[string]any{"autoReview": false, "reviewPasses": float64(1)},
		},
		{
			name:     "unreadable old file is replaced",
			existing: `not json`,
			save:     Config{Editor: "zed"},
			want:     map[string]any{"editor": "zed"},
		},
		{
			name:     "file holding null",
			existing: `null`,
			save:     Config{Ntfy: "x"},
			want:     map[string]any{"ntfy": "x"},
		},
		{
			name: "creates the file",
			save: Config{JiraBase: "https://x.atlassian.net"},
			want: map[string]any{"jiraBase": "https://x.atlassian.net"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			p := filepath.Join(home, ".rook", "config.json")
			if tc.existing != "" {
				require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
				require.NoError(t, os.WriteFile(p, []byte(tc.existing), 0o644))
			}

			require.NoError(t, saveConfig(tc.save))

			raw, err := os.ReadFile(p)
			require.NoError(t, err)
			got := map[string]any{}
			require.NoError(t, json.Unmarshal(raw, &got))
			for k, v := range tc.want {
				assert.Equal(t, v, got[k], k)
			}
			info, err := os.Stat(p)
			require.NoError(t, err)
			assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "config holds tokens; must be owner-only")
		})
	}
}

func TestSaveConfig_DirNotCreatable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// A file where the .rook directory should be makes MkdirAll fail.
	require.NoError(t, os.WriteFile(filepath.Join(home, ".rook"), []byte("x"), 0o644))

	assert.Error(t, saveConfig(Config{}))
}

func TestSaveConfig_WriteFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// A directory where config.json should be makes the write fail.
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".rook", "config.json"), 0o755))

	assert.Error(t, saveConfig(Config{}))
}
