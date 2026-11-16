package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"gofr.dev/pkg/gofr"
)

// The PR board answers one question for a developer: what is blocked on me, and
// what am I blocking? It is split into two lanes — pull requests you raised, and
// pull requests waiting on your review — because those are two different jobs
// with different urgency, and a single mixed list hides which is which.
const (
	laneMine   = "mine"
	laneReview = "review"
)

// boardPR is the normalised shape the UI renders. Everything the card needs is
// computed here rather than in JS so the bucketing rules are testable.
type boardPR struct {
	Number       int      `json:"number"`
	Title        string   `json:"title"`
	URL          string   `json:"url"`
	Repo         string   `json:"repo"`
	Author       string   `json:"author"`
	State        string   `json:"state"` // OPEN | MERGED | CLOSED
	IsDraft      bool     `json:"isDraft"`
	Merged       bool     `json:"merged"`
	BaseRef      string   `json:"baseRef"`
	HeadRef      string   `json:"headRef"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
	Additions    int      `json:"additions"`
	Deletions    int      `json:"deletions"`
	ChangedFiles int      `json:"changedFiles"`
	Labels       []string `json:"labels"`

	// review state
	ReviewDecision  string   `json:"reviewDecision"`  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
	ReviewRequested bool     `json:"reviewRequested"` // a review is requested from me (directly or via a team)
	MyReview        string   `json:"myReview"`        // my latest review state on it
	Reviewers       []string `json:"reviewers"`       // who is on the hook / has reviewed
	Approvals       int      `json:"approvals"`
	ChangesRequests int      `json:"changesRequested"`

	// blockers a developer needs to see without opening the PR
	Checks     string `json:"checks"`     // SUCCESS | FAILURE | PENDING | ""
	Mergeable  string `json:"mergeable"`  // MERGEABLE | CONFLICTING | UNKNOWN
	Unresolved int    `json:"unresolved"` // open review threads still to address
	Unread     bool   `json:"unread"`     // changed since you last looked at it

	// assigned by bucketPR
	Lane string `json:"lane"`
	Col  string `json:"col"`
	Mine bool   `json:"mine"`
}

// bucketPR decides which lane and column a PR belongs in. The ordering of the
// checks is the product decision: the first rule that matches wins, so a PR only
// ever appears in the one place a developer would look for it.
func bucketPR(pr *boardPR, me string) {
	pr.Mine = strings.EqualFold(pr.Author, me)

	if pr.Mine {
		pr.Lane = laneMine
		switch {
		// anything not open has already left the queue — it goes in the trailing
		// "landed" column whether it merged or was closed
		case pr.State != "OPEN":
			pr.Col = "merged"
		// a draft is not in anyone's queue yet, even if it collected a review
		case pr.IsDraft:
			pr.Col = "draft"
		case pr.ReviewDecision == "CHANGES_REQUESTED":
			pr.Col = "changes"
		case pr.ReviewDecision == "APPROVED":
			pr.Col = "approved"
		default:
			pr.Col = "waiting"
		}
		return
	}

	pr.Lane = laneReview
	switch {
	// an explicit request outranks my past review: a re-request after I approved
	// means it is back on me
	case pr.ReviewRequested:
		pr.Col = "requested"
	case pr.MyReview == "APPROVED":
		pr.Col = "approved_by_me"
	default:
		pr.Col = "commented"
	}
}

var repoFullRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var orgNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// prSearchQuery builds a GitHub search string for one lane. Pinned repos are
// more specific than the org, so when any are pinned they replace the org
// filter rather than intersecting with it (repo: and org: would AND to nothing
// for a repo outside the org).
func prSearchQuery(who, org string, repos []string) string {
	parts := []string{"is:pr", who, "archived:false"}
	var scoped []string
	for _, r := range repos {
		r = strings.TrimSpace(r)
		if repoFullRe.MatchString(r) {
			scoped = append(scoped, "repo:"+r)
		}
	}
	if len(scoped) > 0 {
		parts = append(parts, strings.Join(scoped, " "))
	} else if orgNameRe.MatchString(strings.TrimSpace(org)) && org != "" {
		parts = append(parts, "org:"+strings.TrimSpace(org))
	}
	return strings.Join(parts, " ")
}

// prBoardGQL runs the four lane searches in one round trip. Aliased searches
// keep this to a single API call no matter how many lanes the board grows.
const prBoardGQL = `
query($mine: String!, $requested: String!, $involved: String!, $landed: String!, $n: Int!) {
  mine:      search(query: $mine,      type: ISSUE, first: $n) { nodes { ...pr } }
  requested: search(query: $requested, type: ISSUE, first: $n) { nodes { ...pr } }
  involved:  search(query: $involved,  type: ISSUE, first: $n) { nodes { ...pr } }
  landed:    search(query: $landed,    type: ISSUE, first: $n) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft state createdAt updatedAt
  additions deletions changedFiles baseRefName headRefName
  isReadByViewer mergeable
  author { login }
  repository { nameWithOwner }
  reviewDecision
  reviewThreads(first: 20) { nodes { isResolved isOutdated } }
  labels(first: 6) { nodes { name } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

// gqlPR mirrors the fragment above.
type gqlPR struct {
	Number       int    `json:"number"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	IsDraft      bool   `json:"isDraft"`
	State        string `json:"state"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	Additions    int    `json:"additions"`
	Deletions    int    `json:"deletions"`
	ChangedFiles int    `json:"changedFiles"`
	BaseRefName  string `json:"baseRefName"`
	HeadRefName  string `json:"headRefName"`
	IsRead       bool   `json:"isReadByViewer"`
	Mergeable    string `json:"mergeable"`
	Author       struct {
		Login string `json:"login"`
	} `json:"author"`
	Repository struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
	ReviewDecision string `json:"reviewDecision"`
	ReviewThreads  struct {
		Nodes []struct {
			IsResolved bool `json:"isResolved"`
			IsOutdated bool `json:"isOutdated"`
		} `json:"nodes"`
	} `json:"reviewThreads"`
	Labels struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	} `json:"labels"`
	ReviewRequests struct {
		Nodes []struct {
			RequestedReviewer struct {
				Login string `json:"login"`
				Name  string `json:"name"`
			} `json:"requestedReviewer"`
		} `json:"nodes"`
	} `json:"reviewRequests"`
	LatestReviews struct {
		Nodes []struct {
			State  string `json:"state"`
			Author struct {
				Login string `json:"login"`
			} `json:"author"`
		} `json:"nodes"`
	} `json:"latestReviews"`
	Commits struct {
		Nodes []struct {
			Commit struct {
				StatusCheckRollup *struct {
					State string `json:"state"`
				} `json:"statusCheckRollup"`
			} `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
}

// toBoardPR flattens the GraphQL node, folding in what the viewer's own
// relationship to the PR is.
func toBoardPR(n gqlPR, me string) boardPR {
	pr := boardPR{
		Number: n.Number, Title: n.Title, URL: n.URL,
		Repo: n.Repository.NameWithOwner, Author: n.Author.Login,
		State: n.State, IsDraft: n.IsDraft, Merged: n.State == "MERGED",
		BaseRef: n.BaseRefName, HeadRef: n.HeadRefName,
		CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt,
		Additions: n.Additions, Deletions: n.Deletions, ChangedFiles: n.ChangedFiles,
		ReviewDecision: n.ReviewDecision,
		Mergeable:      n.Mergeable,
		Unread:         !n.IsRead,
	}
	for _, l := range n.Labels.Nodes {
		pr.Labels = append(pr.Labels, l.Name)
	}
	// an outdated thread is attached to code the author has already rewritten —
	// counting it would overstate what is actually left to address
	for _, t := range n.ReviewThreads.Nodes {
		if !t.IsResolved && !t.IsOutdated {
			pr.Unresolved++
		}
	}
	for _, r := range n.ReviewRequests.Nodes {
		who := r.RequestedReviewer.Login
		if who == "" {
			who = r.RequestedReviewer.Name
		}
		if who == "" {
			continue
		}
		pr.Reviewers = append(pr.Reviewers, who)
		if strings.EqualFold(who, me) {
			pr.ReviewRequested = true
		}
	}
	for _, rv := range n.LatestReviews.Nodes {
		switch rv.State {
		case "APPROVED":
			pr.Approvals++
		case "CHANGES_REQUESTED":
			pr.ChangesRequests++
		}
		if strings.EqualFold(rv.Author.Login, me) {
			pr.MyReview = rv.State
		}
	}
	if len(n.Commits.Nodes) > 0 && n.Commits.Nodes[0].Commit.StatusCheckRollup != nil {
		pr.Checks = n.Commits.Nodes[0].Commit.StatusCheckRollup.State
	}
	bucketPR(&pr, me)
	return pr
}

// GitHub is the slow part: the four searches cost six seconds or more and
// occasionally fail outright, which left both the web board and Peek staring at
// a spinner. One cached answer serves every caller for a minute, and a failed
// refresh keeps serving the last good one rather than a 502.
type boardCacheEntry struct {
	resp    prBoardResp
	fetched time.Time
}

var (
	boardCacheMu  sync.Mutex
	boardCache    = map[string]boardCacheEntry{}
	boardCacheTTL = time.Minute
)

func boardCacheGet(key string) (prBoardResp, bool, bool) {
	boardCacheMu.Lock()
	defer boardCacheMu.Unlock()
	e, ok := boardCache[key]
	if !ok {
		return prBoardResp{}, false, false
	}
	return e.resp, true, time.Since(e.fetched) < boardCacheTTL
}

func boardCachePut(key string, v prBoardResp) {
	boardCacheMu.Lock()
	defer boardCacheMu.Unlock()
	boardCache[key] = boardCacheEntry{resp: v, fetched: time.Now()}
}

type prBoardResp struct {
	Login string    `json:"login"`
	PRs   []boardPR `json:"prs"`
	Org   string    `json:"org"`
	Repos []string  `json:"repos"`
}

// handlePRBoard returns every PR the viewer needs to act on, bucketed.
func handlePRBoard(ctx *gofr.Context) (any, error) {
	if err := ghGuard(); err != nil {
		return nil, err
	}
	org := strings.TrimSpace(ctx.Param("org"))
	if org != "" && !orgNameRe.MatchString(org) {
		return nil, errf(http.StatusBadRequest, "bad org")
	}
	var repos []string
	if r := strings.TrimSpace(ctx.Param("repos")); r != "" {
		repos = strings.Split(r, ",")
	}

	cacheKey := org + "|" + strings.Join(repos, ",")
	if cached, ok, fresh := boardCacheGet(cacheKey); ok && fresh {
		return rawJSON(cached)
	}

	loginRaw, err := runGH("api", "user", "--jq", ".login")
	if err != nil {
		return nil, errf(http.StatusBadGateway, "gh is not authenticated — run `gh auth login`")
	}
	me := trimNL(string(loginRaw))

	// "landed" is scoped by date so the column stays a short tail of recent work
	// rather than an unbounded archive.
	since := time.Now().AddDate(0, 0, -7).Format("2006-01-02")

	out, err := runGH("api", "graphql",
		"-F", "mine="+prSearchQuery("author:@me is:open", org, repos),
		"-F", "requested="+prSearchQuery("review-requested:@me is:open", org, repos),
		"-F", "involved="+prSearchQuery("involves:@me is:open -author:@me", org, repos),
		"-F", "landed="+prSearchQuery("author:@me is:closed closed:>="+since, org, repos),
		"-F", "n=25",
		"-f", "query="+prBoardGQL,
	)
	if err != nil {
		// A stale board is far more useful than an error page; the UI shows the
		// age, and the next poll will refresh it.
		if cached, ok, _ := boardCacheGet(cacheKey); ok {
			return rawJSON(cached)
		}
		return nil, errf(http.StatusBadGateway, "GitHub search failed — check `gh auth status`")
	}

	var parsed struct {
		Data struct {
			Mine      struct{ Nodes []gqlPR } `json:"mine"`
			Requested struct{ Nodes []gqlPR } `json:"requested"`
			Involved  struct{ Nodes []gqlPR } `json:"involved"`
			Landed    struct{ Nodes []gqlPR } `json:"landed"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, errf(http.StatusBadGateway, "could not read GitHub's response")
	}

	// The searches overlap by design (a PR you authored can also be one you were
	// mentioned in). Dedupe on URL and keep the first hit — search order runs
	// most-specific first, so the first bucket is the right one.
	seen := map[string]bool{}
	var prs []boardPR
	for _, group := range [][]gqlPR{
		parsed.Data.Mine.Nodes, parsed.Data.Requested.Nodes,
		parsed.Data.Involved.Nodes, parsed.Data.Landed.Nodes,
	} {
		for _, n := range group {
			if n.URL == "" || seen[n.URL] {
				continue
			}
			seen[n.URL] = true
			prs = append(prs, toBoardPR(n, me))
		}
	}

	resp := prBoardResp{Login: me, PRs: prs, Org: org, Repos: repos}
	boardCachePut(cacheKey, resp)
	return rawJSON(resp)
}
