# rook — Setup & Usage Guide

Everything you need to install rook, wire it up on your machine, and actually use it.
For a plain-language tour of every feature see **[FEATURES.md](FEATURES.md)**; for an
overview see the [README](../README.md); to hack on rook see [AGENTS.md](../AGENTS.md).

- [1. What rook needs on your machine](#1-what-rook-needs-on-your-machine)
- [2. Install & run](#2-install--run)
- [3. First run — what you're looking at](#3-first-run--what-youre-looking-at)
- [4. Running agents so rook can control them](#4-running-agents-so-rook-can-control-them)
- [5. The everyday loop](#5-the-everyday-loop)
- [6. GitHub, PRs & tickets](#6-github-prs--tickets)
- [7. Insights, Board, Audit, Workspace](#7-insights-board-audit-workspace)
- [8. Settings — what to configure](#8-settings--what-to-configure)
- [9. Keyboard & command palette](#9-keyboard--command-palette)
- [10. Security & privacy](#10-security--privacy)
- [11. Troubleshooting](#11-troubleshooting)

---

## 1. What rook needs on your machine

| Tool | Needed for | Install (macOS) |
|------|-----------|-----------------|
| **Go** (recent toolchain, see `go.mod`) | Building rook | `brew install go` |
| **tmux** | Controlling agents — live terminal, Allow/Deny, spawning | `brew install tmux` |
| **gh** CLI, authenticated | GitHub view, PR/issue context, clone, PR create/merge | `brew install gh && gh auth login` |
| An **AI coding agent** (e.g. Claude Code) | The thing rook watches | per that tool's install |

tmux and gh are optional — rook still **monitors** agents without them; you just won't
be able to control agents (needs tmux) or use GitHub features (needs gh).

rook reads agent session data from `~/.claude` (Claude Code) and other agent dirs, and
scans your common dev folders (`~`, `~/Desktop`, `~/Desktop/github`, `~/dev`, `~/code`,
`~/Projects`, …) to discover local git repos.

## 2. Install & run

```bash
git clone https://github.com/overclockhq/rook.git
cd rook

make run                 # builds ./rook and starts it on http://127.0.0.1:7480
# equivalently:
make build && ./rook
```

Open **http://127.0.0.1:7480**. Leave it running in a terminal tab (or run it under a
process manager). To stop it, Ctrl-C.

Run options:

```bash
./rook --addr 127.0.0.1:9000   # different port
./rook --notify=false          # no desktop notifications
./rook --token=SECRET          # allow remote clients (e.g. Tailscale) that send the token
```

## 3. First run — what you're looking at

rook opens on the **Operator** console:

- **Left rail** — Operator, Insights, Board, GitHub, Summaries, Dev servers, Audit,
  Workspace, a theme toggle, and Settings.
- **Left column** — a live **roster** of every agent, grouped **Needs you / Working /
  Idle / Done**, newest first. A pulsing amber dot means an agent is waiting on you.
- **Right side** — the selected agent's **workspace**, with tabs:
  - **Overview** — status, a **context-window gauge** (how full the agent is), tokens,
    cost, running time, health, tool-usage mix, and recent activity. If the agent is
    waiting, an Allow / Deny / reply box appears here.
  - **Terminal** — the agent's real terminal, live (requires tmux).
  - **Diff** — the agent's uncommitted changes: file tree, split/unified, syntax
    highlighting, and inline comments you can send back to the agent.
  - **Trace** — a waterfall of the agent's tool calls over time.
  - **Files** — the changed files.
  - **PR #… / Issue #…** — appears when the agent is working on a GitHub PR/issue (see §6).

The top bar shows live **"N need you / N working"** counters and a **⌘K** command bar.

## 4. Running agents so rook can control them

rook **monitors** any agent that writes session transcripts to disk automatically. To
**control** an agent (drive its terminal, Allow/Deny its prompts), the agent must run
inside a **tmux** session. Two ways:

- **Let rook launch it** — click **+** in the roster (or ⌘K → "Launch agent"), pick a
  working directory (autocompletes from your local repos), a **model** (Default /
  Haiku / Sonnet / Opus), optionally an initial prompt, and whether to isolate it in
  a git worktree. If the repo has an `AGENTS.md` / `CLAUDE.md`, a **"Follow this
  repo's agent instructions"** toggle appears (on by default) — leave it checked and
  the agent reads and follows them first. rook starts it in tmux for you.
- **Launch it yourself in tmux** — `tmux new -s my-task claude`. rook detects it and it
  becomes controllable.

You can also **reopen a closed session**: click the **↻ Resume** button in the
roster header (or ⌘K → "resume"), pick a past session, and rook relaunches it with
its full context and history intact.

An agent started outside tmux still shows up (read-only) — you just can't send it keys.

## 5. The everyday loop

1. An agent hits a permission prompt → its dot goes amber and the "needs you" counter
   ticks up (with a desktop/phone notification if enabled).
2. Click it in the roster. The **Overview** shows what it's asking.
3. **Allow** / **Deny**, pick a menu option, or type a reply and send — or open the
   **Terminal** tab and drive it directly.
4. When it's done, open **Diff** to review and add inline comments. Each comment
   becomes a **tracked thread** (open → sent → addressed) that you route to the
   agent's terminal with **Send open to agent** — threads survive reloads and
   restarts. Open a **PR** straight from the workspace header (auto-filled from the
   commits; requires *Allow write actions*).

## 6. GitHub, PRs & tickets

With `gh` authenticated:

- **GitHub view** — pick an org, browse repos, and each repo's open **issues & PRs**.
  - **Clone** a repo (the parent dir is remembered).
  - **Work** on an issue/PR, or **Review** a PR → rook launches an agent with a ready
    task prompt (including "read CONTRIBUTING/CLAUDE/AGENTS/SKILL docs and follow them")
    **and auto-fills the working directory** from your local checkout.
  - **Merge** a PR (squash) when *Allow write actions* is on.
- **PR/Issue Context tab** — for any review agent, rook shows the PR/issue **description,
  commits, linked issues (in full), reviews, and comments** in-app — no jumping to GitHub.
- **Ticket → agent** — ⌘K → "New agent from a ticket": paste a Linear id, Jira key, or
  `owner/repo#123`; rook fetches the ticket and turns it into the agent's task.

## 7. Insights, Board, Audit, Workspace

- **Insights** — 5-hour & 7-day windows with input/output/cache **token composition**,
  **cost by model** (with $/M-token efficiency), **cost by project**, a 30-day activity
  trend (Messages / Tokens / Tool calls), and top runs by cost.
- **Board** — every agent as a card in its live state column (Queued / Working / Needs
  you / Review / Idle-Done). Click a card to open it; act (Diff / Review / Terminal)
  from the card; create a task chain with **+ New task**.
- **Audit** — a searchable, filterable table of every command agents ran, with
  **risky-command flags** and click-to-open-the-agent.
- **Workspace** — manage git **worktrees** (multi-select delete, open in editor, jump to
  the agent using one) and the **Claude Code hooks** bridge (install, gate, recent events).
- **Summaries** — generate and read daily work summaries. Click **Generate**, pick the
  day, GitHub author, and model; rook spawns an agent that gathers all of that day's
  agent work (every project) plus your GitHub contributions into one markdown summary.

## 8. Settings — what to configure

Open **Settings** (gear, bottom of the rail):

- **Automation** — destructive-command **gate**, **auto-review** and **auto-verify** on
  finish, **Allow write actions** (required for PR create/merge), max reflect iterations.
- **Claude Code hooks** — **Install** the hooks bridge so rook can surface notifications
  and gate dangerous commands. Uninstall cleanly at any time.
- **Notifications & editor** — ntfy topic (phone push), Slack/Discord webhooks (with a
  **Send test notification** button), and which editor "open in editor" uses.
- **Trackers & summaries** — Linear token, Jira base/email/token, and daily-summary
  author / repos / schedule / **model** (defaults to Haiku to keep this low-stakes
  work cheap).

Settings persist to `~/.rook/config.json`.

## 9. Keyboard & command palette

- **⌘K** — command palette: jump to any agent, switch views, launch an agent / from a
  ticket / a chain, open Settings.
- **j / k** (or ↑/↓) — move through the roster; **1–5** switch workspace tabs.
- **g o / g i / g b** — go to Operator / Insights / Board.
- **/** — focus the roster filter. **⌘↵** — send a reply.
- **Theme** — sun/moon in the rail; your choice is remembered.

## 10. Security & privacy

- rook binds to `127.0.0.1` only. Non-loopback requests are rejected unless you pass
  `--token` (then remote clients must send it). Use this for Tailscale, not the open net.
- **GitHub is read-only by default.** PR create/merge only work after you enable *Allow
  write actions* in Settings.
- Nothing leaves your machine. rook reads local agent data and talks to GitHub through
  your own `gh` login.
- State-changing actions are only the ones you trigger: keystrokes to your own tmux
  panes, spawning an agent, stopping a dev server, deleting a worktree, and (if enabled)
  PR create/merge.

## 11. Troubleshooting

- **No agents show up** — rook watches `~/.claude`; set `CLAUDE_CONFIG_DIR` if yours
  lives elsewhere. Make sure an agent has actually run recently.
- **Can't Allow/Deny or open a terminal** — the agent isn't in tmux. Launch it via
  rook's **+** button, or `tmux new -s name claude`.
- **GitHub view is empty / errors** — install and authenticate the gh CLI:
  `gh auth login`. The view will tell you if gh isn't configured.
- **PR create/merge says it's disabled** — turn on *Allow write actions* in Settings.
- **Port already in use** — start with `--addr 127.0.0.1:<other-port>`.
- **Nothing at localhost:7480** — check the terminal where rook is running for the
  `rook listening on …` line and any errors.
