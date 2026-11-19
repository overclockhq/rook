package main

import "testing"

func TestBucketPR(t *testing.T) {
	me := "PiyushSingh-ZS"

	cases := []struct {
		name     string
		pr       boardPR
		wantLane string
		wantCol  string
		wantMine bool
	}{
		{
			name:     "my open draft",
			pr:       boardPR{Author: me, State: "OPEN", IsDraft: true},
			wantLane: laneMine, wantCol: "draft", wantMine: true,
		},
		{
			name:     "my PR nobody has reviewed yet",
			pr:       boardPR{Author: me, State: "OPEN"},
			wantLane: laneMine, wantCol: "waiting", wantMine: true,
		},
		{
			name:     "my PR with changes requested",
			pr:       boardPR{Author: me, State: "OPEN", ReviewDecision: "CHANGES_REQUESTED"},
			wantLane: laneMine, wantCol: "changes", wantMine: true,
		},
		{
			name:     "my approved PR",
			pr:       boardPR{Author: me, State: "OPEN", ReviewDecision: "APPROVED"},
			wantLane: laneMine, wantCol: "approved", wantMine: true,
		},
		{
			// a draft that already collected a CHANGES_REQUESTED is still a draft
			// to its author — it is not back in anyone's queue.
			name:     "draft outranks review decision",
			pr:       boardPR{Author: me, State: "OPEN", IsDraft: true, ReviewDecision: "CHANGES_REQUESTED"},
			wantLane: laneMine, wantCol: "draft", wantMine: true,
		},
		{
			name:     "my merged PR",
			pr:       boardPR{Author: me, State: "MERGED"},
			wantLane: laneMine, wantCol: "merged", wantMine: true,
		},
		{
			name:     "review requested from me",
			pr:       boardPR{Author: "someone", State: "OPEN", ReviewRequested: true},
			wantLane: laneReview, wantCol: "requested", wantMine: false,
		},
		{
			name:     "I already approved it",
			pr:       boardPR{Author: "someone", State: "OPEN", MyReview: "APPROVED"},
			wantLane: laneReview, wantCol: "approved_by_me", wantMine: false,
		},
		{
			// a re-request after my approval puts it back in my queue
			name:     "re-requested after my approval",
			pr:       boardPR{Author: "someone", State: "OPEN", ReviewRequested: true, MyReview: "APPROVED"},
			wantLane: laneReview, wantCol: "requested", wantMine: false,
		},
		{
			name:     "I only commented",
			pr:       boardPR{Author: "someone", State: "OPEN", MyReview: "COMMENTED"},
			wantLane: laneReview, wantCol: "commented", wantMine: false,
		},
		{
			name:     "involved but no review of mine",
			pr:       boardPR{Author: "someone", State: "OPEN"},
			wantLane: laneReview, wantCol: "commented", wantMine: false,
		},
		{
			// authoring wins over being a requested reviewer on your own PR
			name:     "authored beats involvement",
			pr:       boardPR{Author: me, State: "OPEN", ReviewRequested: true, MyReview: "COMMENTED"},
			wantLane: laneMine, wantCol: "waiting", wantMine: true,
		},
		{
			// login comparison must not be case sensitive — GitHub logins are not
			name:     "author match ignores case",
			pr:       boardPR{Author: "piyushsingh-zs", State: "OPEN"},
			wantLane: laneMine, wantCol: "waiting", wantMine: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.pr
			bucketPR(&got, me)
			if got.Lane != c.wantLane {
				t.Errorf("lane = %q, want %q", got.Lane, c.wantLane)
			}
			if got.Col != c.wantCol {
				t.Errorf("col = %q, want %q", got.Col, c.wantCol)
			}
			if got.Mine != c.wantMine {
				t.Errorf("mine = %v, want %v", got.Mine, c.wantMine)
			}
		})
	}
}

// Closed-but-not-merged PRs of mine should not be presented as landed work.
func TestBucketPRClosedUnmerged(t *testing.T) {
	pr := boardPR{Author: "me", State: "CLOSED"}
	bucketPR(&pr, "me")
	if pr.Col != "merged" {
		t.Errorf("closed PR col = %q, want merged (the trailing 'landed/closed' column)", pr.Col)
	}
	if pr.Merged {
		t.Errorf("a CLOSED PR must not be flagged Merged")
	}
}

func TestSearchQueryScoping(t *testing.T) {
	// no repo pins: the org filter alone narrows the search
	q := prSearchQuery("author:@me", "zopdev", nil)
	if !contains(q, "org:zopdev") || !contains(q, "author:@me") || !contains(q, "is:pr") {
		t.Errorf("org-scoped query missing a clause: %q", q)
	}
	// pinned repos are more specific than the org, so they replace it
	q = prSearchQuery("author:@me", "zopdev", []string{"zopdev/zopnight", "zopdev/notification"})
	if !contains(q, "repo:zopdev/zopnight") || !contains(q, "repo:zopdev/notification") {
		t.Errorf("repo-scoped query missing a repo clause: %q", q)
	}
	if contains(q, "org:zopdev") {
		t.Errorf("pinned repos should replace the org filter, got %q", q)
	}
	// a repo pin that isn't well formed must never reach the search string
	q = prSearchQuery("author:@me", "", []string{"not a repo", "zopdev/ok"})
	if contains(q, "not a repo") {
		t.Errorf("malformed repo leaked into query: %q", q)
	}
	if !contains(q, "repo:zopdev/ok") {
		t.Errorf("valid repo dropped alongside the malformed one: %q", q)
	}
}
