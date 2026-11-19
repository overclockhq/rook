package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gofr.dev/pkg/gofr"
	resp "gofr.dev/pkg/gofr/http/response"
)

// queryReq is a fakeReq that also answers query parameters.
type queryReq struct {
	fakeReq
	q map[string]string
}

func (r queryReq) Param(k string) string { return r.q[k] }

// fakeGH installs a gh stand-in that records its arguments and prints out.
func fakeGH(t *testing.T, out string, code int) string {
	t.Helper()
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + args + "'\nprintf '%s' '" + out + "'\n" +
		"[ " + string(rune('0'+code)) + " = 0 ] || { echo 'gh: not signed in' >&2; exit " + string(rune('0'+code)) + "; }\n"
	bin := filepath.Join(dir, "gh")
	require.NoError(t, os.WriteFile(bin, []byte(script), 0o755))
	prev := ghBin
	ghBin = bin
	t.Cleanup(func() { ghBin = prev })
	return args
}

func TestHandleGHPRs(t *testing.T) {
	ctx := func(repo string) *gofr.Context {
		return &gofr.Context{Context: context.Background(), Request: queryReq{q: map[string]string{"repo": repo}}}
	}

	t.Run("lists open PRs with the branch name", func(t *testing.T) {
		args := fakeGH(t, `[{"number":1}]`, 0)
		out, err := handleGHPRs(ctx("a/b"))
		require.NoError(t, err)
		f, ok := out.(resp.File)
		require.True(t, ok)
		assert.JSONEq(t, `[{"number":1}]`, string(f.Content))
		got, _ := os.ReadFile(args)
		assert.Contains(t, string(got), "--repo\na/b\n")
		assert.Contains(t, string(got), "headRefName")
	})
	t.Run("bad repo is refused before gh runs", func(t *testing.T) {
		args := fakeGH(t, `[]`, 0)
		_, err := handleGHPRs(ctx("a/b;rm"))
		assert.Equal(t, 400, statusOf(t, err))
		_, statErr := os.Stat(args)
		assert.True(t, os.IsNotExist(statErr), "gh must not run")
	})
	t.Run("gh failure surfaces its stderr", func(t *testing.T) {
		fakeGH(t, ``, 1)
		_, err := handleGHPRs(ctx("a/b"))
		assert.Equal(t, 502, statusOf(t, err))
		assert.ErrorContains(t, err, "not signed in")
	})
	t.Run("no gh installed", func(t *testing.T) {
		prev := ghBin
		ghBin = ""
		t.Cleanup(func() { ghBin = prev })
		_, err := handleGHPRs(ctx("a/b"))
		assert.Equal(t, 503, statusOf(t, err))
	})
}
