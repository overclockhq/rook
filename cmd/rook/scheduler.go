package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"gofr.dev/pkg/gofr"
)

// summaryOrigin is the base URL the summary agent calls back on; set when the
// scheduler starts so the manual trigger can reuse it.
var summaryOrigin string

// buildSummaryPrompt is the Go-side twin of the frontend's buildSummaryPrompt,
// used by the scheduled auto-run. Keep the two in sync.
func buildSummaryPrompt(start, end, author, repos, origin string) string {
	saveURL := fmt.Sprintf("%s/api/summary?start=%s&end=%s&author=%s&repos=%s",
		origin, start, end, author, repos)
	lines := []string{
		fmt.Sprintf("Produce my work summary for %s to %s (inclusive dates). GitHub author: %s. Repos: %s.", start, end, author, repos),
		"Cover EVERYTHING that happened in the window regardless of working directory: all local AI-agent (Claude Code) work across every project/directory, AND all GitHub contributions (commits, PRs, issues, reviews) by the author. Do not scope to a single repo or folder.",
		"Follow this flow:",
		fmt.Sprintf("1) GitHub authored artifacts: gh search prs --author=%s --created=\"%s..%s\" --json repository,number,title,state,createdAt,url --limit 50 ; and gh search issues (same filters). For each repo, list ALL commits via the commit SEARCH API (search/commits, q=author:%s+repo:<repo>+committer-date:%s..%s) — critical because the plain repo commits endpoint misses squash-merged/deleted branches.", author, start, end, author, start, end),
		fmt.Sprintf("2) Reviews with timestamps via GraphQL search (repo:<repo> reviewed-by:%s updated:%s..%s is:pr), reading each review's submittedAt to place it on the correct day.", author, start, end),
		"3) For each authored/merged PR, get its individual commits and body (gh pr view <n> --json title,body,headRefName ; gh api repos/<repo>/pulls/<n>/commits).",
		fmt.Sprintf("4) Local Claude Code work (REQUIRED): fetch it from rook: curl -s \"%s/api/claude-activity?start=%s&end=%s\" — JSON grouped by project of the prompts run in Claude Code sessions in the window (already filtered). Incorporate it into each day.", origin, start, end),
		"5) Cross-reference commits, PRs and sessions into a coherent story; pull full PR/issue bodies for root-cause context.",
		"Dedup: authored PR -> task list (note review rounds inline); reviewed PR -> only the daily review count; filed issue -> task list; a session that produced a PR merges into that PR's bullet.",
		"Output has TWO sections in order. SECTION 1 (## Detailed): per-day sections (chronological) with task bullets, a Local Claude Code work sub-list per project, then a Reviews line with count + names; a daily review summary table (dates x counts); a TL;DR narrative.",
		"SECTION 2 (## Work at a glance): a scannable PER-DAY index. For each day with meaningful work (chronological, '### <YYYY-MM-DD>' subheading), list that day's work as SHORT self-explanatory headline TITLES only — no descriptions, one line each — grouped under exactly '#### Tasks', '#### Docs & reports', and '#### PR reviews'. Within a day each item appears exactly once (no duplicates); include the PR/issue number when there is one; SKIP small/trivial items; omit an empty sub-subheading and any day with no meaningful work.",
		"Style: markdown, no emojis, no session IDs/paths, include PR numbers + branch names, root-cause over description.",
		fmt.Sprintf("FINAL STEP: write the complete markdown to /tmp/rook-summary.md, then save it by running: curl -s -X POST \"%s\" -H \"Content-Type: binary/octet-stream\" --data-binary @/tmp/rook-summary.md ; then print SUMMARY_SAVED.", saveURL),
	}
	return strings.Join(lines, "\n")
}

// startSummaryScheduler triggers a daily summary at the configured local time.
func startSummaryScheduler(origin string) {
	summaryOrigin = origin
	go func() {
		lastRun := ""
		for {
			time.Sleep(30 * time.Second)
			c := loadConfig()
			if c.SummarySchedule == "" || c.SummaryCwd == "" || c.SummaryAuthor == "" {
				continue
			}
			now := time.Now()
			if now.Format("15:04") != c.SummarySchedule {
				continue
			}
			today := now.Format("2006-01-02")
			if lastRun == today {
				continue
			}
			lastRun = today
			runScheduledSummary(c, origin, today)
		}
	}()
}

func runScheduledSummary(c Config, origin, date string) {
	if tmuxBin == "" {
		log.Printf("scheduled summary skipped: tmux not installed")
		return
	}
	name := "summary-auto-" + strings.ReplaceAll(date, "-", "")
	if _, err := spawnSummary(c, origin, date, date, c.SummaryAuthor, c.SummaryRepos, c.SummaryCwd, summaryModel(c, ""), name); err != nil {
		log.Printf("scheduled summary failed: %v", err)
		return
	}
	log.Printf("scheduled summary spawned for %s", date)
}

// summaryModel picks the model for the summary agent: an explicit override, else
// the configured SummaryModel, else a cheap default. The summary is low-stakes
// synthesis, so routing it to Haiku by default keeps rook's background work cheap
// without touching quality-sensitive work (review/verify stay on the strong model).
func summaryModel(c Config, override string) string {
	return firstNonEmpty(override, c.SummaryModel, "haiku")
}

// spawnSummary launches a Claude agent that assembles a work summary for the
// window and POSTs it back to /api/summary. Shared by the scheduler and the
// manual "Generate summary" trigger.
func spawnSummary(c Config, origin, start, end, author, repos, cwd, model, name string) (string, error) {
	if cwd == "" {
		return "", fmt.Errorf("no working directory available to run the summary agent")
	}
	// kill any leftover session with this name so new-session doesn't collide
	_, _ = runTmux("kill-session", "-t", name)
	prompt := buildSummaryPrompt(start, end, author, repos, origin)
	_, _, _, err := spawnAgentSession(spawnReq{Name: name, CWD: cwd, Agent: "claude", Prompt: prompt, Model: model})
	if err != nil {
		return "", err
	}
	return name, nil
}

// defaultSummaryCwd picks a directory to run the summary agent in when none is
// configured — the summary is cwd-agnostic (it pulls all agents' work and all
// GitHub contributions regardless of directory), so any real repo will do.
func defaultSummaryCwd() string {
	if rs := discoverRepos(); len(rs) > 0 {
		return rs[0].Path
	}
	home, _ := os.UserHomeDir()
	return home
}

type summaryGenReq struct {
	Date   string `json:"date"`
	Author string `json:"author"`
	Repos  string `json:"repos"`
	Cwd    string `json:"cwd"`
	Model  string `json:"model"`
}

// handleSummaryGenerate is the manual trigger for a work summary. It defaults
// the date to today, the author/repos from config, and the working directory to
// any local repo — the summary covers every agent's work and all GitHub
// contributions for the day regardless of where they happened.
func handleSummaryGenerate(ctx *gofr.Context) (any, error) {
	if tmuxBin == "" {
		return nil, errf(http.StatusServiceUnavailable, "tmux is required to run the summary agent — install tmux and retry")
	}
	var req summaryGenReq
	_ = ctx.Bind(&req)
	c := loadConfig()
	author := firstNonEmpty(req.Author, c.SummaryAuthor)
	if author == "" {
		return nil, errf(http.StatusBadRequest, "a GitHub author is required — set one in Settings or pass 'author'")
	}
	repos := firstNonEmpty(req.Repos, c.SummaryRepos)
	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	cwd := firstNonEmpty(req.Cwd, c.SummaryCwd, defaultSummaryCwd())
	name := "summary-" + strings.ReplaceAll(date, "-", "") + "-" + fmt.Sprint(time.Now().Unix()%100000)
	session, err := spawnSummary(c, summaryOrigin, date, date, author, repos, cwd, summaryModel(c, req.Model), name)
	if err != nil {
		return nil, errf(http.StatusBadGateway, "%v", err)
	}
	return rawJSON(map[string]any{"ok": true, "session": session, "date": date, "author": author})
}
