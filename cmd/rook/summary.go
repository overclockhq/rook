package main

import (
	"net/http"
	"strconv"
	"strings"

	"gofr.dev/pkg/gofr"
)

// handleSummaryPost saves the spawned agent's finished markdown. The body is the
// raw markdown (Content-Type: binary/octet-stream); metadata comes from query
// params. Save is an upsert on (start,end,author).
//
//	POST /api/summary?start=&end=&author=&repos=   body = markdown
func handleSummaryPost(ctx *gofr.Context) (any, error) {
	if db == nil {
		return nil, errf(http.StatusServiceUnavailable, "summary store unavailable")
	}
	var body []byte
	if err := ctx.Bind(&body); err != nil {
		return nil, errf(http.StatusBadRequest, "read error (send Content-Type: binary/octet-stream)")
	}
	content := strings.TrimSpace(string(body))
	if content == "" {
		return nil, errf(http.StatusBadRequest, "empty summary body")
	}
	s := Summary{
		Start:   ctx.Param("start"),
		End:     ctx.Param("end"),
		Author:  ctx.Param("author"),
		Repos:   ctx.Param("repos"),
		Content: content,
	}
	id, err := saveSummary(s)
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "id": id})
}

func handleSummaryGet(ctx *gofr.Context) (any, error) {
	if db == nil {
		return nil, errf(http.StatusServiceUnavailable, "summary store unavailable")
	}
	id, err := strconv.ParseInt(ctx.Param("id"), 10, 64)
	if err != nil {
		return nil, errf(http.StatusBadRequest, "bad id")
	}
	s, err := getSummary(id)
	if err != nil {
		return nil, errf(http.StatusNotFound, "not found")
	}
	return rawJSON(s)
}

func handleSummaryDelete(ctx *gofr.Context) (any, error) {
	if db == nil {
		return nil, errf(http.StatusServiceUnavailable, "summary store unavailable")
	}
	id, err := strconv.ParseInt(ctx.Param("id"), 10, 64)
	if err != nil {
		return nil, errf(http.StatusBadRequest, "bad id")
	}
	if err := deleteSummary(id); err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true})
}

// handleSummaries lists stored summaries (metadata + snippet), newest first.
func handleSummaries(ctx *gofr.Context) (any, error) {
	if db == nil {
		return rawJSON([]Summary{})
	}
	list, err := listSummaries()
	if err != nil {
		return nil, errf(http.StatusInternalServerError, "%v", err)
	}
	if list == nil {
		list = []Summary{}
	}
	return rawJSON(list)
}
