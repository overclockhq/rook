// guide.js — the "?" page guide: a side panel that explains the current page
// (what it is for, how to use it, tips, related pages). Self-contained: it adds
// its own top-bar button, scoped CSS and keyboard shortcut, and follows the
// active rail button, so views don't need to know about it.
(function () {
  "use strict";

  // Each guide: what the page is for, steps to use it, tips, related pages.
  // Keep the wording plain and the steps in the order a first-time user needs.
  var G = {
    operator: {
      title: "Operator",
      what: "Every Claude Code (and Codex, Aider, Gemini) session on this Mac in one place: who is working, who is waiting on you, and what each one is doing right now.",
      steps: [
        "The left list groups agents by state: <b>Needs you</b> (waiting for a permission or an answer), <b>Working</b>, <b>Idle</b> and <b>Done</b>. Type in <i>Filter agents</i> to narrow it.",
        "Click an agent to open it. The tabs on the right show its <b>Overview</b> (what it is doing, context window fill, quality and cost), live <b>Terminal</b>, <b>Diff</b> of its changes, <b>Trace</b> of tool calls and <b>Files</b> it touched.",
        "When an agent is waiting on a permission, use <b>Allow</b> or <b>Deny</b> right from here; agents started from rook (tmux) can also be typed into from the Terminal tab.",
        "Use <b>+</b> to launch a new agent in a repo (optionally in its own git worktree), or a <b>Chain</b> to run several prompts one after another.",
        "Top-right buttons on an agent: <b>PR</b> (open or create its pull request), <b>Review</b> (start a review of its changes), <b>Logs</b>, <b>Stop</b>.",
      ],
      tips: [
        "<kbd>⌘K</kbd> opens the command palette: jump to any agent or page, or run a command.",
        "The context gauge turns amber near the limit; <b>Compact</b> tells the agent to summarise its context.",
        "Agents started in a plain terminal show up too, but only tmux-launched ones can be typed into.",
      ],
      related: ["board", "reviews", "notifications"],
    },
    insights: {
      title: "Insights",
      what: "How much Claude you are using and how well sessions are going: tokens over the last 5 hours and 7 days, quality and cost per session, and cost by model.",
      steps: [
        "The two top cards show tokens and messages for the last <b>5 hours</b> (your plan's rolling window) and <b>7 days</b>, split into input, output and cache.",
        "<b>Quality by session</b> scores each session 0–100 from tool errors, retries and checks; low scores are worth a look in Operator.",
        "<b>Cost by session</b> and <b>Cost by model</b> show where usage goes. Costs are estimates from token counts; on a Claude plan they are not billed separately.",
      ],
      tips: [
        "A few huge sessions usually dominate cost: long-running sessions with large context re-read it every turn. Starting fresh with <code>/clear</code> is cheaper.",
        "Cache reads are cheap; a big cache-write number means context keeps changing.",
      ],
      related: ["operator", "audit"],
    },
    board: {
      title: "Pull requests",
      what: "Your pull requests and the ones waiting on your review, across the repos you pin, grouped by what is blocking them.",
      steps: [
        "Pick the <b>Organisation</b> and <b>Pin repositories</b> in the scope bar; the board remembers them.",
        "<b>My pull requests</b> are grouped by state (waiting on review, changes requested, approved, landed) with the reviewer it is waiting on and any conflicts.",
        "<b>Awaiting my review</b> lists PRs where you are a requested reviewer.",
        "Click a PR to open it; use <b>Refresh</b> after pushing or reviewing.",
      ],
      tips: [
        "The board reads GitHub through your <code>gh</code> login; if it shows an error, run <code>gh auth status</code>.",
        "For a deep review of one PR, use the Reviews page.",
      ],
      related: ["reviews", "github"],
    },
    graph: {
      title: "Task graphs",
      what: "Multi-step agent runs: each step is an agent prompt, run in order, with an optional approval gate between steps.",
      steps: [
        "Use <b>New graph</b> to define the steps (a prompt per step) and the repo to run them in.",
        "Each box shows a step's status. Click <b>View</b> to open the agent that ran it.",
        "Steps that need approval stop and wait: <b>Approve</b> to continue, <b>Reject</b> to stop, or <b>Advance</b> to skip ahead.",
        "<b>Delete</b> removes a finished graph from the list.",
      ],
      tips: [
        "Keep each step small and checkable; the next step only sees what the previous one left in the repo.",
        "For a long list of similar tasks run unattended, a loop (Loops page) is a better fit.",
      ],
      related: ["loops", "operator"],
    },
    github: {
      title: "GitHub",
      what: "Your repositories with their open issues and pull requests, and a quick way to start an agent on one.",
      steps: [
        "Pick an org (or your account) at the top and filter repositories by name.",
        "Click a repository to load its <b>Open Issues</b> and <b>Open Pull Requests</b>.",
        "Use <b>Work</b> on an issue or PR to launch an agent on it in the local checkout (rook finds the clone from its git remote).",
      ],
      tips: [
        "Creating or merging PRs from rook only works when <b>Allow write actions</b> is on in Settings.",
      ],
      related: ["board", "reviews"],
    },
    reviews: {
      title: "Reviews",
      what: "A senior review of one PR or branch by your <b>tech-lead</b> agent, with every blocker and major finding checked by <b>finding-verifier</b> before you see it. Read-only: nothing is written to the repo or posted to GitHub.",
      steps: [
        "Choose <b>Pull request</b>: type <code>owner/repo#123</code>, or pick a repository (search it; recent ones come first) and click a PR in the list. Search by number, title, author or branch, and filter to <b>Mine</b> or <b>Ready</b> (not draft). Or choose <b>Local branch</b> and a base, e.g. <code>origin/development</code>.",
        "Optionally write a <b>Focus</b>: what the reviewer should look at hardest (a risky handler, the issue's acceptance criteria, files to ignore). It still reports blockers elsewhere.",
        "Click <b>Start review</b> (or ⌘Enter). The run goes <i>queued → reviewing → verifying → done</i>; one review runs at a time.",
        "Open a run to see the verdict, intent, blast radius and findings ranked blocker → nit. Each finding has a failure scenario, evidence and a fix.",
        "Badges show what the verifier found: <b>confirmed</b>, <b>disproved</b> (dimmed and collapsed) or <b>unclear</b>. Act on confirmed ones first.",
        "<b>Copy as markdown</b> copies the confirmed findings, ready to paste into a PR comment yourself.",
        "A running review can't take new instructions. When it's done, <b>Discuss in a session</b> opens an Operator agent in that checkout with the findings loaded, so you can ask follow-ups. <b>Re-run with focus…</b> starts a fresh review of the same target with new instructions.",
      ],
      tips: [
        "Each review uses your Claude plan (Opus, up to 40 turns). Use it for non-trivial changes, not one-liners.",
        "The repo must be one rook has discovered, and both agents must be your own (in <code>~/.claude/agents</code>); a repo can't swap in its own reviewer.",
        "The agents are installed with your Claude setup; see them on the Agents & skills page.",
        "On the GitHub page, <b>Team review</b> on any PR opens this form with that PR already picked.",
      ],
      related: ["kit", "board", "guardrails"],
    },
    summaries: {
      title: "Summaries",
      what: "Written summaries of your work over a date range, built from your GitHub activity and Claude sessions, saved so you can reuse them for stand-ups and reports.",
      steps: [
        "Click <b>Generate</b>, set the <b>GitHub author</b>, <b>Repos</b> and date range, and choose the model.",
        "Saved summaries are listed on the left, newest first; click one to read it.",
        "Use <b>Copy</b> to paste it elsewhere, or <b>Select</b> to delete several.",
      ],
      tips: [
        "Set a daily schedule (time of day) under Settings → Trackers & summaries to have one written automatically.",
        "Haiku is enough for summaries and the cheapest; switch to Sonnet for longer ranges.",
      ],
      related: ["settings", "board"],
    },
    notifications: {
      title: "Notifications",
      what: "Every alert rook sent: an agent waiting on you, finished, blocked by the safety gate, looping, or a verify result — and which channels it went to.",
      steps: [
        "Filter by kind with the chips: <b>Waiting</b>, <b>Alert</b>, <b>Finished</b>, <b>Agent</b>, <b>Blocked</b>, <b>Verify</b>.",
        "Each row shows when, the project, the message and the channels (desktop, ntfy, Slack, Discord).",
        "<b>Clear history</b> empties the list; it doesn't change any agent.",
      ],
      tips: [
        "Phone notifications: add an ntfy topic or Slack/Discord webhook in Settings.",
        "Repeated “looping” alerts usually mean an agent is retrying the same command; open it in Operator to see why.",
      ],
      related: ["settings", "operator"],
    },
    loops: {
      title: "Goals & loops",
      what: "Claude working toward a finish line without you prompting each step. <b>Goals</b> keep one session going until a condition is true; <b>Loops</b> run a task list unattended, one fresh session per task.",
      steps: [
        "<b>Goal:</b> in any Claude session type <code>/goal &lt;condition&gt;</code>, e.g. <i>all tests pass and lint is clean</i>. After each round a check runs; Claude keeps going until it holds. The Goals tab shows each goal, its check-ins and the latest check note; <b>Open session</b> jumps to it.",
        "<b>Loop:</b> in a Claude session inside a repo on a <code>feature/</code> or <code>fix/</code> branch, run <code>/loop-spec &lt;name&gt; &lt;goal&gt;</code>. It writes <code>.loop/&lt;name&gt;/</code> with the spec, a task list, a budget and a progress log.",
        "On the Loops tab pick the loop and press <b>Start</b>. Each pass takes one task, runs the gate, marks it passed only if the gate passes, logs progress and commits locally. It never pushes.",
        "It stops by itself when all tasks pass, the budget runs out, or three passes make no progress (shown as <b>needs you</b>). <b>Stop</b> ends it early.",
        "<b>Recent passes</b> lists every pass with its task, result, turns, time and estimated cost.",
      ],
      tips: [
        "Use a goal while you are around and the work is one thing; use a loop for many similar tasks overnight.",
        "Loops refuse to run on <code>main</code>/<code>development</code>. Check the branch in the loop's header before starting.",
        "Many passes without progress or many permission denials mean the spec or the allow-list needs fixing, not more passes.",
      ],
      related: ["guardrails", "operator"],
    },
    system: {
      title: "System health",
      what: "What is using this Mac's memory and CPU, with agents and their child processes called out, so you can spot a runaway process.",
      steps: [
        "The list shows each process's memory, uptime and which agent started it.",
        "Rows flagged with a reason (e.g. high memory, orphaned) are the ones worth acting on.",
        "<b>Stop</b> ends a process. Only stop what you recognise.",
      ],
      tips: [
        "Orphans are leftovers from agents that ended (test watchers, dev servers); they are usually safe to stop.",
      ],
      related: ["dev", "operator"],
    },
    dev: {
      title: "Dev servers",
      what: "Every local server listening on a port (node, python, ssh tunnels, rook itself), with the folder it runs from.",
      steps: [
        "<b>Open</b> opens the server's address in your browser.",
        "<b>Stop</b> ends it; tick several rows to stop them together.",
      ],
      tips: [
        "An address starting with <code>*</code> listens on every network interface, not just this Mac.",
      ],
      related: ["system"],
    },
    audit: {
      title: "Audit / savings",
      what: "A trail of every command and file write your agents ran, with risky ones flagged.",
      steps: [
        "Filter by text, agent or project to find what changed something.",
        "<b>Copy</b> copies the full command; <b>Open</b> jumps to the agent that ran it.",
        "The <b>Risky</b> card counts commands that matched destructive patterns.",
      ],
      tips: [
        "Use it after an unattended run (a loop or a goal) to see exactly what was executed.",
      ],
      related: ["guardrails", "operator"],
    },
    kit: {
      title: "Agents & skills",
      what: "Your Claude Code toolkit: the subagents (the team) and the skills (slash commands and playbooks), global and per repo.",
      steps: [
        "<b>Agents</b> tab: each subagent with its model, effort, whether it can write, its tools and hooks. Click one for its full definition and, for agents with memory (like tech-lead), the lessons it has saved.",
        "<b>Skills</b> tab: search, filter by scope, and use the chips to show manual-only, forked or side-effect skills. Click a skill to read its <code>SKILL.md</code>.",
        "<b>Run skill audit</b> checks every skill against the standard (size, description, side effects, hardcoded paths, overlaps) and shows findings per skill.",
      ],
      tips: [
        "Agents marked read-only have no write tools; agents with Bash can still write via the shell unless a hook stops them.",
        "Archived skills are listed at the bottom; they no longer load.",
        "New agents and skills load when a Claude session starts; restart open sessions to pick them up.",
      ],
      related: ["reviews", "guardrails"],
    },
    workspace: {
      title: "Workspace",
      what: "Git worktrees rook created for agents (e.g. PR reviews), and rook's own Claude Code hook bridge.",
      steps: [
        "<b>Git worktrees</b>: each agent worktree with its repo, branch and age. <b>Open in editor</b> or <b>Remove</b> when the agent is done.",
        "<b>Claude Code hooks</b>: install or uninstall rook's hook bridge, which feeds rook live events and powers Allow/Deny and the destructive-command gate.",
        "<b>Recent hook events</b> shows what the bridge received.",
      ],
      tips: [
        "Old review worktrees pile up; remove ones whose agent has finished to free disk space.",
        "Your own hooks (guard, gate, notifications) are on the Guardrails page.",
      ],
      related: ["guardrails", "settings"],
    },
    guardrails: {
      title: "Guardrails",
      what: "What keeps Claude safe and honest on this Mac: your hooks, permissions, the done-gate per repo, the hook self-test and the morning brief.",
      steps: [
        "<b>Safety hooks</b>: every hook by event, what it does and whether its script is healthy. Warnings at the top flag where rook's hooks and yours both run on the same event.",
        "<b>Permissions</b>: allow / ask / deny rules. Entries that look like credentials in <code>settings.local.json</code> are flagged (never shown) — rotate those keys and remove the entries.",
        "<b>Gate</b>: each Go repo with its branch and uncommitted changes. <b>Run gate</b> checks build, tests, ≥90% coverage on changed functions, lint, comment markers and migrations; the toggle turns the automatic Stop-hook gate off for that repo.",
        "<b>Self-test</b> runs the hook test suites and reports pass/fail.",
        "<b>Morning brief</b>: whether the daily job is loaded, its schedule, and past briefs to read.",
      ],
      tips: [
        "Turning the gate off for a repo only skips the automatic check; run it here before saying work is done.",
        "If a hook shows as missing or not executable, Claude silently runs without it — fix it first.",
      ],
      related: ["kit", "workspace", "loops"],
    },
    settings: {
      title: "Settings",
      what: "rook's own behaviour: automation after sessions finish, notifications, trackers and the summary schedule. Saved to <code>~/.rook/config.json</code> (owner-only, as it holds tokens).",
      steps: [
        "<b>Automation</b>: the destructive-command gate, auto-review and auto-verify when a session finishes with changes, auto-compact near the context limit, and whether rook may create or merge PRs.",
        "<b>Notifications & editor</b>: ntfy topic, Slack or Discord webhook for phone alerts, and which editor opens worktrees.",
        "<b>Trackers & summaries</b>: Linear or Jira tokens to start agents from tickets, and the daily summary time and repos.",
      ],
      tips: [
        "Auto-review and auto-verify start agents automatically and use your plan; turn them on per need.",
        "Settings rook doesn't know (added by another build or by hand) are kept when you save.",
      ],
      related: ["notifications", "workspace"],
    },
  };
  var NAMES = {
    operator: "Operator", insights: "Insights", board: "Pull requests", graph: "Task graphs", github: "GitHub", reviews: "Reviews",
    summaries: "Summaries", notifications: "Notifications", loops: "Goals & loops", system: "System health", dev: "Dev servers",
    audit: "Audit", kit: "Agents & skills", workspace: "Workspace", guardrails: "Guardrails", settings: "Settings",
  };

  var ICON_HELP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.4"/><path d="M12 17h.01"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function injectCSS() {
    if (document.getElementById("op-guide-css")) return;
    var s = document.createElement("style");
    s.id = "op-guide-css";
    s.textContent = [
      ".op-guide-btn{position:relative;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--surface);color:var(--ink-3);font-size:12px;cursor:pointer;margin-left:6px}",
      ".op-guide-btn:hover{color:var(--ink);border-color:var(--ink-4)}",
      ".op-guide-btn svg{width:15px;height:15px}",
      ".op-guide-btn .dot{position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:var(--coral);display:none}",
      ".op-guide-btn.new .dot{display:block}",
      ".op-guide-scrim{position:fixed;inset:0;background:rgba(0,0,0,.18);z-index:80;opacity:0;pointer-events:none;transition:opacity .15s}",
      ".op-guide-scrim.on{opacity:1;pointer-events:auto}",
      ".op-guide{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);z-index:81;background:var(--surface);border-left:1px solid var(--line);box-shadow:-12px 0 32px rgba(0,0,0,.12);transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column}",
      ".op-guide.on{transform:none}",
      "@media (prefers-reduced-motion:reduce){.op-guide,.op-guide-scrim{transition:none}}",
      ".op-guide .gh{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line)}",
      ".op-guide .gh .k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-4)}",
      ".op-guide .gh h2{margin:2px 0 0;font-size:17px;font-weight:600;color:var(--ink)}",
      ".op-guide .gh .x{margin-left:auto;width:30px;height:30px;border-radius:var(--radius-sm);border:1px solid transparent;background:none;color:var(--ink-3);cursor:pointer;display:grid;place-items:center}",
      ".op-guide .gh .x:hover{border-color:var(--line);color:var(--ink)}",
      ".op-guide .gh .x svg{width:16px;height:16px}",
      ".op-guide .gb{flex:1;min-height:0;overflow:auto;padding:16px 18px 24px;font-size:13px;line-height:1.6;color:var(--ink-2)}",
      ".op-guide .gb h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-4);font-weight:500;margin:20px 0 8px}",
      ".op-guide .gb h3:first-child{margin-top:0}",
      ".op-guide .gb p{margin:0}",
      ".op-guide .gb ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px}",
      ".op-guide .gb ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}",
      ".op-guide .gb b{color:var(--ink);font-weight:600}",
      ".op-guide .gb code,.op-guide .gb kbd{font-family:var(--mono);font-size:12px;padding:1px 5px;border-radius:4px;background:var(--surface-2);border:1px solid var(--line);color:var(--ink)}",
      ".op-guide .gb .rel{display:flex;flex-wrap:wrap;gap:6px}",
      ".op-guide .gb .rel button{height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);font-size:12px;cursor:pointer}",
      ".op-guide .gb .rel button:hover{color:var(--ink);border-color:var(--ink-4)}",
      ".op-guide .gf{padding:10px 18px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-4)}",
    ].join("");
    document.head.appendChild(s);
  }

  var ui = { btn: null, panel: null, scrim: null, open: false, view: null };

  function currentView() {
    var b = document.querySelector(".op-rail-btn.active[data-view]");
    return (b && b.dataset.view) || "operator";
  }

  function render() {
    var v = ui.view = currentView();
    var g = G[v];
    var body = ui.panel.querySelector(".gb");
    ui.panel.querySelector(".gh h2").textContent = g ? g.title : (NAMES[v] || v);
    if (!g) { body.innerHTML = "<p>No guide for this page yet.</p>"; return; }
    var html = "<h3>What it's for</h3><p>" + g.what + "</p>";
    html += "<h3>How to use it</h3><ol>" + g.steps.map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ol>";
    if (g.tips && g.tips.length) html += "<h3>Tips</h3><ul>" + g.tips.map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ul>";
    if (g.related && g.related.length) {
      html += '<h3>Related pages</h3><div class="rel">' + g.related.filter(function (r) { return document.querySelector('.op-rail-btn[data-view="' + r + '"]'); })
        .map(function (r) { return '<button data-go="' + r + '">' + (NAMES[r] || r) + "</button>"; }).join("") + "</div>";
    }
    body.innerHTML = html;
    body.scrollTop = 0;
    body.querySelectorAll("button[data-go]").forEach(function (b) {
      b.addEventListener("click", function () {
        var rb = document.querySelector('.op-rail-btn[data-view="' + b.dataset.go + '"]');
        if (rb) rb.click();
      });
    });
    store("opGuideSeen:" + v, "1");
    markNew();
  }

  // A dot on the button until the user has opened the guide for this page once.
  function markNew() {
    if (ui.btn) ui.btn.classList.toggle("new", !!G[currentView()] && !store("opGuideSeen:" + currentView()));
  }

  function setOpen(on) {
    ui.open = on;
    if (on) render();
    ui.panel.classList.toggle("on", on);
    ui.scrim.classList.toggle("on", on);
    ui.panel.setAttribute("aria-hidden", on ? "false" : "true");
    ui.btn.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) ui.panel.querySelector(".x").focus(); else ui.btn.focus();
  }

  function mount() {
    var cluster = document.querySelector(".op-status-cluster");
    if (!cluster || ui.btn) return;
    injectCSS();
    ui.btn = document.createElement("button");
    ui.btn.className = "op-guide-btn";
    ui.btn.type = "button";
    ui.btn.title = "Guide to this page (.)";
    ui.btn.setAttribute("aria-label", "Guide to this page");
    ui.btn.setAttribute("aria-expanded", "false");
    ui.btn.innerHTML = ICON_HELP + "<span>Guide</span><span class=\"dot\"></span>";
    cluster.parentNode.insertBefore(ui.btn, cluster.nextSibling);

    ui.scrim = document.createElement("div");
    ui.scrim.className = "op-guide-scrim";
    ui.panel = document.createElement("aside");
    ui.panel.className = "op-guide";
    ui.panel.setAttribute("role", "dialog");
    ui.panel.setAttribute("aria-label", "Page guide");
    ui.panel.setAttribute("aria-hidden", "true");
    ui.panel.innerHTML = '<div class="gh"><div><div class="k">Guide</div><h2></h2></div><button class="x" type="button" aria-label="Close guide">' + ICON_CLOSE + "</button></div>" +
      '<div class="gb"></div><div class="gf">Press <b>.</b> to open or close · <b>Esc</b> to close · <b>?</b> for all shortcuts</div>';
    document.body.appendChild(ui.scrim);
    document.body.appendChild(ui.panel);

    ui.btn.addEventListener("click", function () { setOpen(!ui.open); });
    ui.scrim.addEventListener("click", function () { setOpen(false); });
    ui.panel.querySelector(".x").addEventListener("click", function () { setOpen(false); });
    document.addEventListener("keydown", function (e) {
      var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.closest && t.closest(".xterm")));
      if (e.key === "Escape" && ui.open) { setOpen(false); return; }
      // "?" is rook's shortcuts help and "g <key>" jumps pages, so the guide uses ".".
      if (e.key === "." && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setOpen(!ui.open); }
    });
    // Follow page changes: refresh the open guide and the "new" dot.
    var rail = document.querySelector(".op-rail") || document.body;
    new MutationObserver(function () {
      if (currentView() === ui.view) return;
      if (ui.open) render(); else { ui.view = currentView(); markNew(); }
    }).observe(rail, { subtree: true, attributes: true, attributeFilter: ["class"] });
    ui.view = currentView();
    markNew();
  }

  // Exposed for tests and for views that want to open their guide.
  window.OP_GUIDE = { pages: G, open: function () { setOpen(true); }, close: function () { setOpen(false); } };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
