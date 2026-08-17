package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestPostNtfyHeaders pins that a stuck (urgent) push carries the Priority header
// and every push carries a click-through — a routine ping used to be byte-for-byte
// identical to a stuck escalation.
func TestPostNtfyHeaders(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer srv.Close()

	postNtfy(srv.URL, "agent waiting 12m", "still blocked", "urgent")
	if got.Get("Priority") != "urgent" {
		t.Errorf("urgent push should set Priority: urgent, got %q", got.Get("Priority"))
	}
	if got.Get("Title") != "agent waiting 12m" {
		t.Errorf("Title header = %q", got.Get("Title"))
	}
	if got.Get("Click") == "" {
		t.Errorf("push should carry a Click deep-link so tapping it opens the console")
	}

	// a routine push must NOT be tagged urgent — otherwise every ping reads the same
	postNtfy(srv.URL, "agent needs you", "answer a question", "")
	if got.Get("Priority") != "" {
		t.Errorf("routine push should leave Priority default, got %q", got.Get("Priority"))
	}
}
