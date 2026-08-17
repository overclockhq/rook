package main

import (
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func withTestDB(t *testing.T) func() {
	t.Helper()
	prev := db
	d, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	d.SetMaxOpenConns(1)
	if _, err := d.Exec(reviewCommentsSchema); err != nil {
		t.Fatal(err)
	}
	db = d
	return func() { d.Close(); db = prev }
}

func TestReviewCommentLifecycle(t *testing.T) {
	defer withTestDB(t)()
	sid := "cbcd2e95-f25a-4cd5-8baf-b9dae38e8496"

	c1, err := addReviewComment(reviewComment{SessionID: sid, File: "a.go", Line: 10, Side: "new", Text: "rename this"})
	if err != nil || c1.ID == 0 {
		t.Fatalf("add failed: %v", err)
	}
	if c1.State != "open" {
		t.Fatalf("new comment should be open, got %q", c1.State)
	}
	if _, err := addReviewComment(reviewComment{SessionID: sid, File: "b.go", Line: 3, Text: "extract helper"}); err != nil {
		t.Fatal(err)
	}
	// other session's comment must not leak in
	if _, err := addReviewComment(reviewComment{SessionID: "aaaaaaaa-0000-0000-0000-000000000000", File: "x", Text: "other"}); err != nil {
		t.Fatal(err)
	}

	got, err := listReviewComments(sid)
	if err != nil || len(got) != 2 {
		t.Fatalf("expected 2 comments for session, got %d (%v)", len(got), err)
	}
	if got[0].File != "a.go" || got[1].File != "b.go" {
		t.Fatalf("ordering wrong: %+v", got)
	}

	// state transitions
	if err := setReviewCommentState(c1.ID, "sent"); err != nil {
		t.Fatal(err)
	}
	rc, _ := getReviewComment(c1.ID)
	if rc.State != "sent" {
		t.Fatalf("expected sent, got %q", rc.State)
	}

	// formatting includes file:line
	msg := formatReviewComments(got)
	if !strings.Contains(msg, "a.go:10 — rename this") || !strings.Contains(msg, "b.go:3 — extract helper") {
		t.Fatalf("format wrong:\n%s", msg)
	}

	// delete
	if err := deleteReviewComment(c1.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = listReviewComments(sid)
	if len(got) != 1 {
		t.Fatalf("expected 1 after delete, got %d", len(got))
	}
}
