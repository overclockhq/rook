# AGENTS.md

Guide for AI coding agents (and humans) working on **rook**. Read this before making
changes — it maps the codebase, the conventions, and the verification loop.

## What rook is

A local, single-user dashboard that watches AI coding agents on your machine and lets
you drive them. Single Go binary (built on [GoFr](https://gofr.dev)) with an embedded,
**zero-build** vanilla-JS web UI. No database server (SQLite for saved summaries), no
frontend bundler.

## Build / run / test

```bash
go build -o rook ./cmd/rook   # or: make build
./rook                    # or: make run   → serves http://127.0.0.1:7480
go test ./...             # Go unit tests (gomock + testify + sqlmock)
make fmt                  # gofmt
make vet                  # go vet
node --check cmd/rook/web/<file>.js  # the frontend has NO build step — syntax-check JS this way
```

There is no JS build/bundle. Files in `web/` are served as-is (embedded via `go:embed`).
After editing frontend files, restart the binary (assets are embedded at build time).

## Backend (Go, single `package main`)

Lives in **`cmd/rook/`** (the embedded UI is `cmd/rook/web/`); `go.mod` stays at
the repo root. Build with `go build ./cmd/rook` (or `make build`). Paths below are
relative to `cmd/rook/`.

| File | Responsibility |
|------|----------------|
| `main.go` | flags, HTTP routes, `//go:embed web`, static handlers, access guard, no-cache |
| `scan.go` | **core**: discover sessions, parse `~/.claude` transcripts → tokens, tool calls, changed files, **context-window fill**, status |
| `repos.go` | discover local git repos + their `origin` remote (worktree-aware) → auto-resolve checkouts |
| `github.go` | read-only `gh` wrappers: repos, issues, PRs, PR/issue detail (comments, commits, linked issues) |
| `integrations.go` | PR create/merge (write, gated by `AllowWrite`), clone, tracker fetch (Linear/Jira/GitHub), webhook test, open-in-editor |
| `hooks.go` | Claude Code hooks bridge (install into `~/.claude/settings.json`), PreToolUse danger gate, event ring |
| `review.go`, `reflect.go` | auto-review subagent, build/test verify gate, Reflexion retry loop |
| `chains.go` | linear task chains (sequential agents), auto-advance on session finish |
| `diff.go` | review diff: canonical `gh pr diff` for PR checkouts, else git merge-base + untracked |
| `review_comments.go` | inline review comments as persisted threads (open→sent→addressed), routed to the agent's tmux |
| `resume.go` | list past sessions from transcripts + `claude --resume` a closed one (`/api/sessions/history`, `/api/resume`) |
| `agentdocs.go` | detect a repo's `AGENTS.md`/`CLAUDE.md`/etc. for the launcher's follow-instructions opt-in |
| `usage.go`, `pricing.go` | `/api/usage` cost/token breakdown; per-model price estimates |
| `term_ws.go` | `/ws/term` — real PTY bridged to xterm.js over a WebSocket via `tmux attach` |
| `spawn.go` | tmux spawn + optional git worktree isolation |
| `db.go`, `scheduler.go` | SQLite store (summaries + review comments); daily-summary scheduler + manual generate |
| `spawn.go` `buildLaunchCmd` | composes the agent command with `--resume` / `--model` (haiku\|sonnet\|opus) |
| `activity.go`, `audit.go`, `devservers.go`, `notify.go` | activity feed, command audit trail, dev-server discovery, desktop/ntfy/chat notifications |
| `codex.go`, `agents_extra.go` | Codex / Aider / Gemini adapters |
| `config.go` | `~/.rook/config.json` settings (Settings UI) |
| `gofrutil.go` | `rawJSON()` / `errf()` helpers — responses are raw JSON, **not** GoFr's `data`-wrapped default |

API responses use `rawJSON`, so the client mostly gets bare JSON — but frontend code
still defensively unwraps `j.data || j`.

## Frontend (`web/`, no build)

- `operator.html` — the shell (rail, top bar, command palette, script/style tags). An
  inline `<head>` script sets the theme before first paint (no flash).
- `operator.css` — **the whole design system**: design tokens on `:root` (dark) and
  `:root[data-theme="light"]`, plus every component. Everything reads tokens.
- `operator.js` — the core: 2s `/api/state` poll, shell chrome, agent roster, the
  tabbed **workspace** (Overview / Terminal / Diff / Trace / Files / PR-issue Context),
  command palette (⌘K), launch / chain / ticket modals, Settings, Insights, Board glue,
  theme toggle, and the shared **icon map `I`** + `opCtx()` helpers.
- `operator-<name>.js` — **plug-in views**: `github`, `summaries`, `dev`, `audit`,
  `workspace`. Each is self-contained (see the contract below).
- `board.js`/`board.css`, `charts.js`/`charts.css`, `diffview.js`/`diffview.css` —
  reusable modules (kanban, SVG charts, diff renderer).
- `vendor/` — xterm.js + fit addon, highlight.js, Geist fonts. All inlined/local (no CDN).
- `index.html` / `app.js` / `style.css` — the **legacy** "classic" UI at `/classic`,
  being retired. Prefer the Operator UI; don't add features to classic.

### Adding a view (the plug-in contract)

```js
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};
  window.OP_VIEWS["myview"] = {
    build: function (host, ctx) { /* mount into an INNER wrapper, never set host.className */ },
    render: function (state, ctx) { /* refresh; called on build + every 2s poll; idempotent */ }
  };
})();
```

`ctx` = `{ el, esc, fmtTokens, fmtUSD, ago, shortModel, statusOf, icon, now, toast,
charts, selectAgent(id), launch(prefill), resolveRepo(owner/repo), getRepos() }`.

To wire it in: (1) create `web/operator-myview.js`; (2) add a rail `<button data-view="myview">`
in `operator.html`; (3) add a `<script src="/operator-myview.js">` tag; (4) add the
name to the route loop in `main.go` and to `TITLES` in `operator.js`.

Mount pattern (don't clobber `#opView`):
```js
build: function (host, ctx) { host.innerHTML = '<div class="ins op-myview"></div>'; this.host = host.firstChild; ... }
```

## Conventions (do not break these)

- **Token-only CSS.** Never hard-code a color/font in a component. Use the CSS
  variables (`--bg --surface --surface-2/3 --line --ink --ink-2/3/4 --coral --busy
  --waiting --ok --danger --mono --sans …`). This is what makes both themes work.
- **Plug-in views inject their own scoped CSS once** via `<style id="op-<name>-css">`
  appended to `document.head`, every rule prefixed with `.op-<name>`. Never edit
  `operator.css` from a view (parallel-edit conflicts).
- **Icons** live in the `I` map in `operator.js` at **stroke-width 1.7**, `fill:none`,
  `stroke:currentColor`, round caps/joins. Views use `ctx.icon.*`. Keep the rail SVGs
  in `operator.html` at 1.7 too.
- **Fixed-height, in-place scroll** for list/table views (see `operator-dev.js`): the
  page never scrolls; a `.tablewrap{flex:1;min-height:0;overflow:auto}` scrolls, with a
  sticky `<thead>`. `.ins-grid` uses `grid-template-rows: minmax(0,1fr)` to bound panes.
- **Terminal stays dark** in both themes (standard for a console).
- No custom Go errors — return GoFr errors / the `errf()` helper (HTTP codes auto-map).

## Verification loop (before claiming done)

1. `go build ./...` and `go test ./...` green.
2. `node --check cmd/rook/web/<changed>.js` for each changed JS file.
3. Restart the binary and **look at the surface in a browser at a realistic width
   (~1512–1728) in BOTH themes** — most bugs (overflow, dead space, missing colors)
   only show at real size. Scroll it.
4. For interactive changes, click the actual control and confirm the effect.

## Gotchas learned the hard way

- `lastPrompt` is truncated (~120 chars) — don't rely on a full URL being in it. A
  session's repo is resolved from its **git remote** (`repoForDir`, worktree-aware) and
  exposed as `session.repo`; the PR/issue number comes from the cwd/title.
- **Context-window fill** = the last assistant turn's `input + cache_read + cache_write`
  (computed in `scan.go`, `session.contextTokens`). The gauge's denominator is inferred
  **per model** in `operator.js` (`windowForModel`): if any session on that model has
  ever exceeded 200k, the whole model is treated as a 1M window — so a 1M agent sitting
  at 179k reads ~18%, not a false 90%.
- Editing a `web/` asset twice under the same `?v=` query can serve a stale cached copy
  in the browser — hard-reload, or the embedded copy after a rebuild is authoritative.
- The board's columns are **derived state** (busy/waiting/idle) — they're read-only, not
  draggable; don't add drag that pretends to move an agent.
- Don't set `host.className` in a plug-in view — it clobbers `#opView`'s `.op-view`
  layout. Mount into an inner `<div class="ins op-<name>">`.
