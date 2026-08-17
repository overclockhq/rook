<div align="center">

<img src="img/logo.svg" alt="rook" width="180" />

# Features

Everything rook can do, explained simply — and how to use each part.

</div>

For install and setup see the **[Setup &amp; Usage Guide](USAGE.md)**. For the big
picture see the **[README](../README.md)**.

---

## Contents

- [The Operator console](#the-operator-console)
- [Seeing what an agent is doing](#seeing-what-an-agent-is-doing)
- [Driving an agent](#driving-an-agent)
- [Reviewing changes](#reviewing-changes)
- [Review comments that reach the agent](#review-comments-that-reach-the-agent)
- [GitHub: PRs, issues &amp; context](#github-prs-issues--context)
- [Launching agents](#launching-agents)
- [Following a repo's instructions](#following-a-repos-instructions)
- [Starting from a ticket](#starting-from-a-ticket)
- [Resuming a closed session](#resuming-a-closed-session)
- [Daily work summaries](#daily-work-summaries)
- [Costs &amp; tokens (Insights)](#costs--tokens-insights)
- [Cheaper models for background work](#cheaper-models-for-background-work)
- [Board, Audit &amp; Workspace](#board-audit--workspace)
- [Automation &amp; safety](#automation--safety)
- [Notifications](#notifications)
- [Keyboard &amp; command palette](#keyboard--command-palette)
- [Themes](#themes)

---

## The Operator console

The home screen. On the left is a **live roster** of every agent, grouped into
**Needs you / Working / Idle / Done**, newest first. A pulsing amber dot means an
agent is waiting on you. On the right is the **workspace** for whichever agent you
select, with tabs for Overview, Terminal, Diff, Trace, Files, and the PR it's
working on.

The top bar always shows how many agents **need you** vs are **working**, plus a
**⌘K** command bar.

## Seeing what an agent is doing

The **Overview** tab is the agent at a glance:

- **Context window gauge** — how full the agent's context is (e.g. `179k / ~1M ·
  18%`). rook figures out whether the model is on the 200k or 1M window by looking
  at every session on that model, so the percentage is honest.
- **Tokens &amp; cost** — totals plus 5-hour and 7-day usage, and an estimated $ cost.
- **Tool-usage mix** — how often it used Bash, Read, Edit, and so on.
- **Health** — a watchdog flags agents that look stuck or are looping on the same
  tool call.
- **Recent activity** — the last handful of tool calls with timestamps.

The **Trace** tab shows the same tool calls as a waterfall timeline.

## Driving an agent

When an agent is waiting, an **Allow / Deny / reply** box appears right in the
Overview — no need to find its terminal. You can also:

- Pick a numbered menu option the agent is offering.
- Type a reply and send it (**⌘↵**).
- Open the **Terminal** tab for the agent's *real* terminal, live over tmux — full
  keyboard, arrow keys, Ctrl-sequences, even full-screen TUIs. Closing the tab just
  detaches; the agent keeps running.

Driving requires the agent to run inside tmux (see [Launching agents](#launching-agents)).

## Reviewing changes

The **Diff** tab shows the agent's work:

- For an agent **reviewing a PR**, it shows the *canonical PR diff* — exactly what
  GitHub shows — so you're never thrown off by stale local branches.
- For an agent **writing code**, it shows the working-tree changes against the fork
  point (committed + uncommitted), plus untracked files.

You get a file tree with per-file ± counts, split or unified view, and syntax
highlighting.

## Review comments that reach the agent

Leave a comment on any line of the diff and rook turns it into a **tracked thread**.
Each thread has a state:

- **open** — written, not yet sent.
- **sent** — delivered to the agent's terminal.
- **addressed** — you've marked it done.

Hit **Send open to agent** and rook types the comments straight into the agent's
tmux session as a single, clear message. Threads live in a panel above the diff and
**survive reloads and restarts**, so a review-in-progress is never lost. Mark each
done (or reopen it) as the agent works through them.

## GitHub: PRs, issues &amp; context

With the `gh` CLI authenticated:

- The **GitHub** view lets you browse an org's repos and each repo's open issues and
  PRs, and **Clone**, **Work on**, **Review**, or **Merge** (merge needs write
  actions on).
- Choosing **Work** or **Review** launches an agent with a ready task prompt **and
  auto-fills the working directory** from your local checkout — no path typing.
- For any review agent, a **PR / Issue tab** shows the full **description, commits,
  linked issues, reviews, and comments** — pulled live, in-app.

## Launching agents

Click **+** in the roster (or ⌘K → *Launch agent*). You choose:

- **Working directory** — autocompletes from the git repos rook found on your machine.
- **Agent** — Claude, Codex, Aider, or Gemini.
- **Model** — Default, or route this run to Haiku / Sonnet / Opus.
- **Initial prompt** — optional.
- **Isolate in a git worktree** — run in a throwaway worktree so the agent can check
  out a PR branch or make commits without touching your working checkout.

rook starts it inside tmux (so it's fully controllable) and jumps you to its session
as soon as it appears.

## Following a repo's instructions

When you pick a working directory that has an **`AGENTS.md`, `CLAUDE.md`,
`.cursorrules`, `CONTRIBUTING.md`,** or Copilot instructions file, the launcher
offers a checkbox — **Follow this repo's agent instructions** (on by default). Leave
it checked and rook tells the new agent to read and follow those files first, so it
picks up your conventions with zero extra typing.

## Starting from a ticket

⌘K → *New agent from a ticket*. Paste a **Linear id, Jira key, or `owner/repo#123`**
and rook fetches the ticket, turns it into the agent's task prompt, and launches it.
You describe work by its ticket, not by writing a brief.

## Resuming a closed session

Closed a session by mistake, or want to pick one back up? rook keeps a record of
**every past session** (from the transcripts agents write to disk). Click the **↻
Resume** button in the roster header — or press ⌘K and type **`resume`** — to see
them, then choose one. rook relaunches it with `--resume`, so it comes back with the
**same conversation, context, and history**, and opens automatically.

## Daily work summaries

The **Summaries** view generates a readable write-up of a day's work. Click
**Generate**, pick the day and your GitHub author, and rook spawns an agent that
gathers **everything you and your agents did that day — across every project — plus
all your GitHub contributions** (commits, PRs, issues, reviews) and saves a tidy
markdown summary you can read, copy, or download. You can also schedule it to run
automatically at a set time each day (Settings).

## Costs &amp; tokens (Insights)

The **Insights** view breaks down usage:

- 5-hour and 7-day windows with **input / output / cache** token composition.
- **Cost by model** (with $/million-token efficiency) and **cost by project**.
- A **30-day activity trend** you can flip between messages, tokens, and tool calls.
- Your **top runs by cost**.

## Cheaper models for background work

rook does some work on your behalf — daily summaries, for instance. Those are
low-stakes, so rook routes them to **Haiku** by default to keep costs down, while
quality-sensitive work (agent reviews, verification) stays on the strong model. You
can change the summary model in Settings, or pick a model per launch.

## Board, Audit &amp; Workspace

- **Board** — every agent as a card in its live-state column (Queued / Working /
  Needs you / Review / Idle-Done). Act on a card (Diff / Review / Terminal) or
  create a **task chain** — a sequence of agents that hand off to each other.
- **Audit** — a searchable, filterable table of every command your agents ran, with
  **risky commands flagged**; click to jump to the agent.
- **Workspace** — manage git **worktrees** (bulk-delete, open in your editor, jump
  to the agent using one) and the **Claude Code hooks** bridge.

## Automation &amp; safety

In **Settings** you can turn on:

- **Destructive-command gate** — via the Claude Code hooks bridge, rook can block
  clearly-dangerous commands before they run.
- **Auto-review** — when an agent finishes with changes, spawn a read-only reviewer
  agent automatically.
- **Auto-verify** — run the project's build/test command on finish and report
  pass/fail. On failure, rook can loop the agent with the failure (a Reflexion-style
  retry) up to a cap you set.

All of these are **off by default** — you opt in.

## Notifications

- **Desktop** notifications when an agent starts waiting (on by default; `--notify=false` to disable).
- **Phone push** via an [ntfy](https://ntfy.sh) topic.
- **Slack / Discord** via incoming webhooks, with a *Send test notification* button.

## Keyboard &amp; command palette

- **⌘K** — the command palette: jump to any agent, switch views, launch an agent /
  from a ticket / a chain, resume a closed session, open Settings.
- **j / k** (or ↑/↓) — move through the roster. **1–5** — switch workspace tabs.
- **g o / g i / g b** — go to Operator / Insights / Board.
- **/** — focus the roster filter. **⌘↵** — send a reply.

## Themes

Dark and light, toggled from the sun/moon in the rail. Your choice is remembered.
