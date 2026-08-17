/* ============================================================================
   rook Operator console — live renderer. Self-contained: no dependency on the
   legacy app.js. Reuses window.rookCharts, window.renderDiffV2, and the
   vendored xterm globals. Workspace-first: a live agent roster beside a tabbed
   workspace (Overview / Terminal / Diff / Trace / Files).
   ========================================================================== */
(function () {
  "use strict";
  var OP_VERSION = "1";
  var POLL_MS = 2000;

  // ---- tiny helpers --------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtTokens(n) { if (n == null) return "0"; if (n >= 1e9) return (n / 1e9).toFixed(2) + "B"; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"; return String(n); }
  function fmtUSD(n) { if (!n) return "$0"; if (n < 0.01) return "<$0.01"; if (n < 100) return "$" + n.toFixed(2); return "$" + Math.round(n).toLocaleString(); }
  function ago(ms, now) { if (!ms) return "—"; var s = Math.max(0, Math.floor((now - ms) / 1000)); if (s < 60) return s + "s"; var m = Math.floor(s / 60); if (m < 60) return m + "m"; var h = Math.floor(m / 60); if (h < 24) return h + "h"; return Math.floor(h / 24) + "d"; }
  function shortModel(m) { return m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : ""; }
  function statusOf(s) { return s.alive ? (s.status || "idle") : "dead"; }
  function groupOf(s) { var st = statusOf(s); if (st === "waiting") return "needs"; if (st === "busy" || st === "shell") return "working"; if (st === "dead") return "done"; return "idle"; }

  // ---- icons (inline, one stroke set) --------------------------------------
  var I = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6"/></svg>',
    columns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="10" rx="1.5"/><rect x="16" y="4" width="5" height="13" rx="1.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 4 4-4 4M12 16h6"/><rect x="2" y="3" width="20" height="18" rx="2.5"/></svg>',
    diff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7M18 9v6"/><circle cx="18" cy="6" r="2.5"/><path d="M12 6h3.5"/></svg>',
    trace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
    resume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    pr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><circle cx="18" cy="18" r="2.5"/><path d="M18 15.5V10a4 4 0 0 0-4-4h-3M13 3l-2 3 2 3"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.9L3 21l1.9-4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>'
  };

  // ghRefFromSession detects the PR/issue an agent is working on, so its
  // workspace can surface the description + comments in a Context tab. Prefers a
  // github URL in the prompt/summary; falls back to a #number in the name/cwd
  // resolved against the discovered repo's remote.
  function ghRefFromSession(s) {
    if (!s) return null;
    var hay = (s.lastPrompt || "") + " " + (s.summary || "") + " " + (s.title || "") + " " + (s.cwd || "");
    var m = hay.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i);
    if (m) return { owner: m[1], repo: m[2], kind: m[3] === "pull" ? "pr" : "issue", number: parseInt(m[4], 10) };
    // rook's own launch-prompt format ("… pull request #N in owner/repo …"),
    // which survives even when lastPrompt is truncated before the URL.
    var p2 = hay.match(/(pull request|pull|\bpr|issue)\s+#?(\d+)\s+in\s+([\w.-]+)\/([\w.-]+)/i);
    if (p2) return { owner: p2[3], repo: p2[4].replace(/[.:,)]+$/, ""), kind: /issue/i.test(p2[1]) ? "issue" : "pr", number: parseInt(p2[2], 10) };
    var nm = (s.cwd || "") + " " + (s.title || "");
    var pr = nm.match(/(?:review-)?pr[-# ]?(\d+)/i), iss = nm.match(/issue[-# ]?(\d+)/i);
    var kind, num;
    if (pr) { kind = "pr"; num = parseInt(pr[1], 10); } else if (iss) { kind = "issue"; num = parseInt(iss[1], 10); } else return null;
    // repo comes from the session's git remote (resolved server-side, worktrees
    // included); fall back to matching the project name against discovered repos.
    var repoStr = s.repo || "";
    if (!repoStr || repoStr.indexOf("/") < 0) {
      var proj = (s.project || "").toLowerCase();
      var r = repoList.filter(function (x) { return (x.name || "").toLowerCase() === proj && x.remote; })[0];
      repoStr = r ? r.remote : "";
    }
    if (!repoStr || repoStr.indexOf("/") < 0) return null;
    var ow = repoStr.split("/");
    return { owner: ow[0], repo: ow[1], kind: kind, number: num };
  }
  function mdLite(s) {
    s = esc(s || "");
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    return s;
  }
  function ghStatePill(state, draft) {
    var st = (state || "").toUpperCase();
    if (draft) return '<span class="pill idle">draft</span>';
    if (st === "MERGED" || st === "APPROVED") return '<span class="pill done">' + (st === "MERGED" ? "merged" : "approved") + "</span>";
    if (st === "CLOSED" || st === "CHANGES_REQUESTED") return '<span class="pill dead">' + (st === "CLOSED" ? "closed" : "changes requested") + "</span>";
    if (st === "OPEN") return '<span class="pill busy">open</span>';
    return st ? '<span class="pill idle">' + esc(st.toLowerCase()) + "</span>" : "";
  }
  function brandMark() { return '<svg viewBox="0 0 32 32" fill="none"><path d="M16 5 25 12l-4 3 5 8-10-6-10 6 5-8-4-3z" fill="#0a0a0c"/><circle cx="16" cy="13" r="2" fill="#ff5c3a"/></svg>'; }

  // ---- state ---------------------------------------------------------------
  var state = null, stale = false;
  var selectedId = localStorage.getItem("opSel") || null;
  var activeView = localStorage.getItem("opView") || "operator";
  var rosterFilter = "";
  var ws = { id: null, tab: "overview", term: null, diffLoaded: false, traceLoaded: false };

  // after a spawn we don't have the new session's id yet (it appears once the
  // agent starts writing), so remember what to select and grab it on a later poll.
  var pendingSpawn = null; // { cwd, worktree, since }
  function trySelectSpawned() {
    if (!pendingSpawn) return;
    if (now() - pendingSpawn.since > 30000) { pendingSpawn = null; return; } // give up after 30s
    var recent = sessions().filter(function (s) { return (s.startedAt || 0) >= pendingSpawn.since - 8000; });
    var m = recent.filter(function (s) {
      return (pendingSpawn.worktree && s.cwd === pendingSpawn.worktree) || s.cwd === pendingSpawn.cwd;
    }).sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); })[0]
      || recent.sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); })[0]; // fallback: any brand-new session
    if (m) { pendingSpawn = null; selectAgent(m.sessionId); toast("Opened " + (m.title || m.project || "the new agent"), "ok"); }
  }

  // after resuming a closed session, `claude --resume` reuses the SAME session id,
  // so wait for that exact id to reappear alive, then open it.
  var pendingResume = null; // { id, since }
  function trySelectResumed() {
    if (!pendingResume) return;
    if (now() - pendingResume.since > 45000) { pendingResume = null; return; } // give up after 45s
    var m = sessions().filter(function (s) { return s.sessionId === pendingResume.id && s.alive; })[0];
    if (m) { pendingResume = null; setView("operator"); selectAgent(m.sessionId); toast("Resumed " + (m.title || m.project || "session"), "ok"); }
  }

  // resumable (not-alive) sessions from /api/sessions/history, shown in the palette
  var closedSessions = [];
  async function fetchHistory() {
    try {
      var r = await fetch("/api/sessions/history?limit=40", { cache: "no-store" });
      var j = await r.json(); if (j && j.data) j = j.data;
      closedSessions = (j || []).filter(function (s) { return !s.alive; });
      if (paletteOpen) renderPaletteList();
    } catch (e) {}
  }
  function resumeErr(j) {
    if (!j) return "";
    if (j.error && j.error.message) return j.error.message;
    if (typeof j.error === "string") return j.error;
    return j.message || "";
  }
  function resumeSession(id, label) {
    fetch("/api/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: (j && j.data) || j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(resumeErr(res.j) || "couldn't resume that session");
        pendingResume = { id: id, since: now() };
        setView("operator");
        toast("Resuming " + (label || "session") + " — restoring its context…", "ok");
        setTimeout(poll, 500);
      })
      .catch(function (e) { toast((e && e.message) || "Couldn't resume", "err"); });
  }

  // discovered local repos ({path,name,branch,remote}) — lets us auto-resolve a
  // working directory instead of making the user type it.
  var repoList = [];
  async function fetchRepos() { try { var r = await fetch("/api/repos", { cache: "no-store" }); var j = await r.json(); if (j && j.data) j = j.data; repoList = j || []; } catch (e) {} }
  function rememberRepoPath(nameWithOwner, p) { try { localStorage.setItem("opRepoPath:" + String(nameWithOwner).toLowerCase(), p); } catch (e) {} }
  // resolveRepoPath: given a GitHub "owner/repo", find its local checkout —
  // exact git-remote match first, then a remembered path, then folder-name match.
  function resolveRepoPath(nameWithOwner) {
    if (!nameWithOwner) return "";
    var nwo = String(nameWithOwner).toLowerCase(), repo = nwo.split("/").pop();
    var m = repoList.filter(function (r) { return (r.remote || "").toLowerCase() === nwo; })[0];
    if (m) return m.path;
    try { var mem = localStorage.getItem("opRepoPath:" + nwo); if (mem) return mem; } catch (e) {}
    m = repoList.filter(function (r) { return (r.name || "").toLowerCase() === repo; })[0];
    return m ? m.path : "";
  }
  // repoField renders a searchable repo picker (a text input + a styled dropdown)
  // in place of the clunky native <datalist>. Pair with wireRepoPicker(id).
  function repoField(id, placeholder, value) {
    return '<div class="repo-pick">' +
      '<input class="set-in repo-input" id="' + id + '" autocomplete="off" spellcheck="false" placeholder="' + esc(placeholder || "search your repos by name…") + '" value="' + esc(value || "") + '" />' +
      '<div class="repo-menu" id="' + id + '_menu" hidden></div></div>';
  }
  // wireRepoPicker upgrades the input into a keyboard-driven combobox over the
  // discovered repos (match by name / remote / path). onPick runs after a choice.
  function wireRepoPicker(id, onPick) {
    var input = $(id), menu = $(id + "_menu"); if (!input || !menu) return;
    var active = -1, rows = [];
    function filtered() {
      var q = (input.value || "").toLowerCase().trim();
      return repoList.filter(function (r) {
        if (!q) return true;
        return ((r.name || "") + " " + (r.remote || "") + " " + (r.path || "")).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 60);
    }
    function render() {
      rows = filtered();
      if (!rows.length) { menu.innerHTML = '<div class="repo-menu-empty">No matching repo — type or paste a full path</div>'; }
      else menu.innerHTML = rows.map(function (r, i) {
        return '<div class="repo-row' + (i === active ? " act" : "") + '" data-i="' + i + '">' +
          '<div class="repo-row-main"><span class="repo-name">' + esc(r.name || "") + "</span>" + (r.remote ? '<span class="repo-remote">' + esc(r.remote) + "</span>" : "") + "</div>" +
          '<div class="repo-path">' + esc(r.path || "") + "</div></div>";
      }).join("");
      menu.querySelectorAll(".repo-row").forEach(function (el) {
        el.addEventListener("mousedown", function (e) { e.preventDefault(); pick(parseInt(el.dataset.i, 10)); });
      });
    }
    function pick(i) { var r = rows[i]; if (!r) return; input.value = r.path; menu.hidden = true; active = -1; if (onPick) onPick(); }
    function scrollActive() { var el = menu.querySelector(".repo-row.act"); if (el) el.scrollIntoView({ block: "nearest" }); }
    input.addEventListener("focus", function () { active = -1; render(); menu.hidden = false; });
    input.addEventListener("input", function () { active = -1; menu.hidden = false; render(); });
    input.addEventListener("keydown", function (e) {
      if (menu.hidden || !rows.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); render(); scrollActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); scrollActive(); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === "Escape") { menu.hidden = true; active = -1; }
    });
    input.addEventListener("blur", function () { setTimeout(function () { menu.hidden = true; active = -1; }, 120); });
  }

  // ---- data ----------------------------------------------------------------
  function sessions() { return (state && state.sessions) || []; }
  function findAgent(id) { return sessions().filter(function (s) { return s.sessionId === id; })[0]; }
  function now() { return (state && state.now) || Date.now(); }

  async function poll() {
    try {
      var r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state = await r.json(); if (state.data) state = state.data;
      stale = false;
      onState();
    } catch (e) { stale = true; setConn(); }
  }

  function onState() {
    setConn(); setStatusCluster();
    if (!selectedId || !findAgent(selectedId)) {
      var first = pickDefault(); if (first) selectedId = first.sessionId;
    }
    trySelectResumed(); // open a just-resumed session as soon as it reappears
    if (activeView === "operator") {
      trySelectSpawned(); // grab a just-launched agent as soon as it appears
      renderRoster();
      if (ws.id !== selectedId) buildWorkspace();
      else {
        refreshWorkspaceHead(findAgent(selectedId)); // keep the status pill / tokens / Stop live
        if (ws.tab === "overview") renderOverview(); // live-refresh overview only
      }
    } else if (activeView === "insights") {
      renderInsights();
    } else if (activeView === "board") {
      renderBoard();
    } else if (extRender) {
      extRender();
    }
    if (paletteOpen) renderPaletteList();
  }

  // shared helpers handed to plug-in views (operator-*.js) so they render with
  // the exact same formatting + toasts and never invent their own.
  function opCtx() {
    return { el: el, esc: esc, fmtTokens: fmtTokens, fmtUSD: fmtUSD, ago: ago, shortModel: shortModel, statusOf: statusOf, icon: I, now: now, toast: toast, charts: window.rookCharts, selectAgent: function (id) { setView("operator"); selectAgent(id); }, launch: function (prefill) { newAgent(prefill); }, launchGraph: function () { newGraph(); }, resolveRepo: resolveRepoPath, rememberRepo: rememberRepoPath, getRepos: function () { return repoList; } };
  }

  function pickDefault() {
    var ss = sessions();
    var order = { needs: 0, working: 1, idle: 2, done: 3 };
    return ss.slice().sort(function (a, b) { return (order[groupOf(a)] - order[groupOf(b)]) || (b.updatedAt - a.updatedAt); })[0];
  }

  // ---- shell chrome --------------------------------------------------------
  function setConn() {
    var c = $("opConn"); if (!c) return;
    c.classList.toggle("stale", stale);
    c.querySelector(".ct").textContent = stale ? "reconnecting" : "live";
  }
  function setStatusCluster() {
    var ss = sessions();
    var working = ss.filter(function (s) { return groupOf(s) === "working"; }).length;
    var needs = ss.filter(function (s) { return groupOf(s) === "needs"; }).length;
    var w = $("opStatWorking"), n = $("opStatNeeds");
    if (w) w.innerHTML = '<i class="dot busy"></i><b>' + working + "</b> working";
    if (n) n.innerHTML = '<i class="dot waiting"></i><b>' + needs + "</b> need you";
  }

  // registry for plug-in views (operator-<name>.js register window.OP_VIEWS[name])
  window.OP_VIEWS = window.OP_VIEWS || {};
  var TITLES = { operator: "Operator", insights: "Insights", board: "Board", graph: "Task graphs", settings: "Settings", github: "GitHub", summaries: "Summaries", dev: "Dev servers", audit: "Audit", workspace: "Workspace", notifications: "Notifications" };
  var extRender = null; // active plug-in view's render() for live refresh on poll

  function setView(v) {
    activeView = v; localStorage.setItem("opView", v);
    document.querySelectorAll(".op-rail-btn[data-view]").forEach(function (b) { b.classList.toggle("active", b.dataset.view === v); });
    var crumb = $("opCrumb");
    crumb.querySelector("b").textContent = TITLES[v] || "Operator";
    var host = $("opView");
    // host.innerHTML wipes every view's DOM (including the terminal); drop the
    // live PTY and the built-workspace guard so the workspace re-renders when we
    // return to Operator instead of the guard blocking it (blank detail bug).
    teardownTerm(); ws.id = null; extRender = null;
    host.innerHTML = "";
    if (window.OP_VIEWS[v]) { var api = window.OP_VIEWS[v]; api.build(host, opCtx()); extRender = function () { try { api.render(state, opCtx()); } catch (e) {} }; extRender(); return; }
    if (v === "operator") { host.appendChild(buildConsole()); onState(); }
    else if (v === "insights") { host.appendChild(buildInsights()); renderInsights(); }
    else if (v === "board") { host.appendChild(buildBoardView()); renderBoard(); }
    else { buildSettings(host); }
  }

  // ---- operator console ----------------------------------------------------
  function buildConsole() {
    var root = el("div", "op-console");
    var roster = el("aside", "op-roster");
    roster.innerHTML =
      '<div class="op-roster-head">' +
        '<input class="op-roster-search" id="opRosterSearch" placeholder="Filter agents…" />' +
        '<button class="op-roster-new" id="opResume" title="Reopen a closed session">' + I.resume + "</button>" +
        '<button class="op-roster-new" id="opNewAgent" title="New agent (n)">' + I.plus + "</button>" +
      "</div>" +
      '<div class="op-roster-list" id="opRosterList"></div>';
    var work = el("section", "op-workspace"); work.id = "opWorkspace";
    work.innerHTML = '<div class="ws-empty">Select an agent</div>';
    root.appendChild(roster); root.appendChild(work);
    setTimeout(function () {
      var s = $("opRosterSearch");
      if (s) { s.value = rosterFilter; s.addEventListener("input", function () { rosterFilter = s.value.toLowerCase(); renderRoster(); }); }
      $("opNewAgent") && $("opNewAgent").addEventListener("click", newAgent);
      $("opResume") && $("opResume").addEventListener("click", function () { openPalette(true); });
    }, 0);
    return root;
  }

  var GROUPS = [["needs", "Needs you"], ["working", "Working"], ["idle", "Idle"], ["done", "Done"]];
  function renderRoster() {
    var list = $("opRosterList"); if (!list) return;
    var ss = sessions().slice();
    if (rosterFilter) ss = ss.filter(function (s) { return ((s.title || "") + " " + (s.project || "") + " " + (s.model || "")).toLowerCase().indexOf(rosterFilter) >= 0; });
    var by = { needs: [], working: [], idle: [], done: [] };
    ss.forEach(function (s) { by[groupOf(s)].push(s); });
    Object.keys(by).forEach(function (k) {
      by[k].sort(function (a, b) {
        // Needs-you: most-stuck first (oldest update = blocked longest). Others: newest first.
        return k === "needs" ? (a.updatedAt || 0) - (b.updatedAt || 0) : (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    });
    var html = "";
    GROUPS.forEach(function (g) {
      var arr = by[g[0]]; if (!arr.length) return;
      var needs = g[0] === "needs";
      html += '<div class="op-group-label ' + (needs ? "needs" : "") + '">' + esc(g[1]) + '<span class="cnt">' + arr.length + "</span></div>";
      arr.forEach(function (s) {
        var st = statusOf(s);
        var agoTxt = (needs && st === "waiting") ? "blocked " + ago(s.updatedAt, now()) : ago(s.updatedAt, now());
        // what a waiting agent is asking for — the reason it needs you
        var ask = (needs && s.asking) ? '<span class="op-agent-ask">' + esc(s.asking.replace(/\s+/g, " ").trim().slice(0, 90)) + "</span>" : "";
        // inline Allow/Deny for controllable, alive, needs-you agents (spans, not
        // nested buttons; the click stopsPropagation so it doesn't also select)
        var acts = (needs && s.controllable && s.alive)
          ? '<span class="op-agent-acts">' +
              '<span class="op-mini allow" data-act="allow" data-id="' + esc(s.sessionId) + '" role="button" tabindex="0">Allow</span>' +
              '<span class="op-mini deny" data-act="deny" data-id="' + esc(s.sessionId) + '" role="button" tabindex="0">Deny</span>' +
            "</span>"
          : "";
        html += '<button class="op-agent ' + (needs ? "needs " : "") + (s.sessionId === selectedId ? "sel" : "") + '" data-id="' + esc(s.sessionId) + '">' +
          '<span class="op-agent-status"><i class="dot ' + st + '"></i></span>' +
          '<span class="op-agent-main">' +
            '<span class="op-agent-title">' + esc(s.title || s.project || "session") + "</span>" +
            '<span class="op-agent-meta">' + (s.spawnedByRook ? '<span class="op-agent-src" title="Spawned by rook — controllable from here">rook</span>' : '') + esc(s.project || "—") + " · " + esc(shortModel(s.model) || "?") + "</span>" +
            ask + acts +
          "</span>" +
          '<span class="op-agent-right"><span class="op-agent-tok">' + fmtTokens(s.tokensTotal) + '</span><span class="op-agent-ago">' + agoTxt + "</span></span>" +
        "</button>";
      });
    });
    if (!html) html = '<div class="op-empty">' + I.inbox + '<div class="t">No agents</div><div class="h">launch one with a tmux session</div></div>';
    list.innerHTML = html;
    list.querySelectorAll(".op-agent").forEach(function (b) { b.addEventListener("click", function () { selectAgent(b.dataset.id); }); });
    list.querySelectorAll(".op-mini").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation(); // act without navigating to the agent
        var act = el.dataset.act;
        respond(el.dataset.id, act, "").then(function (res) {
          var ok = res.ok && res.landed;
          toast(!res.ok ? (act === "allow" ? "Allow failed" : "Deny failed") : res.landed ? (act === "allow" ? "Allowed" : "Denied") : "Sent — the agent's screen didn't change", ok ? "ok" : "");
        });
      });
    });
  }

  function selectAgent(id) {
    if (selectedId === id && ws.id === id) return;
    selectedId = id; localStorage.setItem("opSel", id);
    renderRoster();
    buildWorkspace();
  }

  // ---- workspace (tabbed) --------------------------------------------------
  var TABS = [
    ["overview", "Overview", I.grid],
    ["terminal", "Terminal", I.terminal],
    ["diff", "Diff", I.diff],
    ["trace", "Trace", I.trace],
    ["files", "Files", I.file],
    ["find", "Find", I.search],
    ["notes", "Notes", I.note]
  ];
  function teardownTerm() { if (ws.term) { try { ws.term.ws && ws.term.ws.close(); } catch (e) {} try { ws.term.xt && ws.term.xt.dispose(); } catch (e) {} try { ws.term.ro && ws.term.ro.disconnect(); } catch (e) {} ws.term = null; } }

  function buildWorkspace() {
    var host = $("opWorkspace"); if (!host) return;
    var s = findAgent(selectedId);
    // Bail without claiming ws.id when state isn't loaded yet, so the next poll
    // (once the agent exists) still passes the ws.id !== selectedId guard.
    if (!s) { host.innerHTML = '<div class="ws-empty">Select an agent</div>'; ws.id = null; return; }
    teardownTerm();
    ws.id = selectedId; ws.diffLoaded = false; ws.traceLoaded = false; ws.ctxLoaded = false;
    if (!ws.tab) ws.tab = "overview";
    var st = statusOf(s);
    var changed = (s.changedFiles || []).length;
    var tabHTML = TABS.map(function (t) {
      var badge = "";
      if (t[0] === "files" && changed) badge = '<span class="tab-badge">' + changed + "</span>";
      if (t[0] === "trace" && (s.toolCalls || []).length) badge = '<span class="tab-badge">' + (s.toolCalls || []).length + "</span>";
      var dis = (t[0] === "terminal" && !(s.controllable && s.tmuxPane)) ? ' style="opacity:.4;pointer-events:none"' : "";
      var dis2 = ((t[0] === "diff" || t[0] === "find") && !s.cwd) ? ' style="opacity:.4;pointer-events:none"' : "";
      return '<button class="ws-tab ' + (t[0] === ws.tab ? "on" : "") + '" data-tab="' + t[0] + '"' + dis + dis2 + ">" + t[2] + "<span>" + t[1] + "</span>" + badge + "</button>";
    }).join("");
    ws.ghRef = ghRefFromSession(s);
    if (ws.ghRef) {
      var ctxLabel = (ws.ghRef.kind === "pr" ? "PR #" : "Issue #") + ws.ghRef.number;
      tabHTML += '<button class="ws-tab ' + (ws.tab === "context" ? "on" : "") + '" data-tab="context">' + I.chat + "<span>" + ctxLabel + "</span></button>";
    }
    host.innerHTML =
      '<div class="ws-head">' +
        '<div class="ws-head-main">' +
          '<div class="ws-title">' + esc(s.title || s.project || "session") + '<span class="pill ' + st + '">' + st + "</span></div>" +
          '<div class="ws-sub"><span>' + esc(s.project || "—") + '</span><span>' + esc(shortModel(s.model) || "?") + '</span><span>' + fmtTokens(s.tokensTotal) + " tok</span><span>" + fmtUSD(s.costUsd) + "</span></div>" +
        "</div>" +
        '<div class="ws-actions">' +
          (s.cwd ? '<button class="btn sm" id="wsPR" title="Open a pull request from this agent\'s branch">' + I.pr + "PR</button>" : "") +
          (s.cwd ? '<button class="btn sm" id="wsReview">' + I.review + "Review</button>" : "") +
          '<button class="btn sm" id="wsLogs">' + I.external + "Logs</button>" +
          (s.controllable && s.alive ? '<button class="btn sm danger" id="wsStop">' + I.stop + "Stop</button>" : "") +
        "</div>" +
      "</div>" +
      '<div class="ws-tabs" id="wsTabs">' + tabHTML + "</div>" +
      '<div class="ws-body" id="wsBody">' +
        '<div class="ws-panel overview-panel" id="wsOverview"></div>' +
        '<div class="ws-panel term-panel" id="wsTerm"></div>' +
        '<div class="ws-panel" id="wsDiff"></div>' +
        '<div class="ws-panel" id="wsTrace"></div>' +
        '<div class="ws-panel" id="wsFiles"></div>' +
        '<div class="ws-panel" id="wsFind"></div>' +
        '<div class="ws-panel" id="wsNotes"></div>' +
        '<div class="ws-panel" id="wsContext"></div>' +
      "</div>";
    host.querySelectorAll(".ws-tab").forEach(function (b) { b.addEventListener("click", function () { switchTab(b.dataset.tab); }); });
    $("wsReview") && $("wsReview").addEventListener("click", function () { switchTab("diff"); });
    $("wsPR") && $("wsPR").addEventListener("click", function () { createPR(s); });
    $("wsLogs") && $("wsLogs").addEventListener("click", function () { window.open("/api/logs?session=" + encodeURIComponent(s.sessionId), "_blank"); });
    $("wsStop") && $("wsStop").addEventListener("click", function () { if (confirm("Stop this agent? This kills its tmux pane.")) killAgent(s); });
    activateTab(ws.tab);
  }

  // refreshWorkspaceHead updates the live bits of the detail header in place on
  // each poll — status pill, tokens/cost, and the Stop button's presence —
  // WITHOUT rebuilding the workspace (which would tear down the terminal socket
  // and reset the open tab). buildWorkspace only runs on selection, so without
  // this the header pill stays frozen at the status it had when you opened it.
  function refreshWorkspaceHead(s) {
    if (!s) return;
    var head = document.querySelector(".ws-head"); if (!head) return;
    var st = statusOf(s);
    var pill = head.querySelector(".ws-title .pill");
    if (pill && (pill.textContent !== st || pill.className !== "pill " + st)) {
      pill.className = "pill " + st;
      pill.textContent = st;
    }
    var sub = head.querySelector(".ws-sub");
    if (sub) {
      sub.innerHTML = "<span>" + esc(s.project || "—") + "</span><span>" + esc(shortModel(s.model) || "?") + "</span><span>" + fmtTokens(s.tokensTotal) + " tok</span><span>" + fmtUSD(s.costUsd) + "</span>";
    }
    var actions = head.querySelector(".ws-actions");
    if (actions) {
      var hasStop = !!actions.querySelector("#wsStop");
      var wantStop = !!(s.controllable && s.alive);
      if (wantStop && !hasStop) {
        var b = el("button", "btn sm danger", I.stop + "Stop"); b.id = "wsStop";
        b.addEventListener("click", function () { if (confirm("Stop this agent? This kills its tmux pane.")) killAgent(s); });
        actions.appendChild(b);
      } else if (!wantStop && hasStop) {
        actions.querySelector("#wsStop").remove();
      }
    }
  }

  function switchTab(tab) { ws.tab = tab; document.querySelectorAll(".ws-tab").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === tab); }); activateTab(tab); }
  function activateTab(tab) {
    var map = { overview: "wsOverview", terminal: "wsTerm", diff: "wsDiff", trace: "wsTrace", files: "wsFiles", find: "wsFind", notes: "wsNotes", context: "wsContext" };
    Object.keys(map).forEach(function (k) { var p = $(map[k]); if (p) p.classList.toggle("on", k === tab); });
    if (tab === "overview") renderOverview();
    else if (tab === "files") renderFiles();
    else if (tab === "trace") renderTraceTab();
    else if (tab === "diff") loadDiff();
    else if (tab === "terminal") openTermTab();
    else if (tab === "find") renderFind();
    else if (tab === "notes") renderNotes();
    else if (tab === "context") renderContext();
  }

  // renderContext shows the PR/issue an agent is reviewing — description,
  // conversation + review comments, and linked issues — fetched from GitHub.
  async function renderContext() {
    var p = $("wsContext"); if (!p) return;
    var ref = ws.ghRef; if (!ref) { p.innerHTML = '<div class="ov"><div class="op-empty">' + I.chat + '<div class="t">No linked PR or issue</div></div></div>'; return; }
    var key = ref.owner + "/" + ref.repo + "#" + ref.number;
    if (ws.ctxLoaded && p.dataset.for === key) return;
    ws.ctxLoaded = true; p.dataset.for = key;
    p.innerHTML = '<div class="ov"><div class="op-empty">Loading ' + esc(ref.kind === "pr" ? "PR" : "issue") + " #" + ref.number + "…</div></div>";
    var repo = ref.owner + "/" + ref.repo;
    var url = "/api/github/" + (ref.kind === "pr" ? "pr" : "issue") + "?repo=" + encodeURIComponent(repo) + "&number=" + ref.number;
    var d; try { d = await (await fetch(url, { cache: "no-store" })).json(); if (d && d.data) d = d.data; } catch (e) { d = null; }
    if (!d || d.error || d.message && !d.title) { p.innerHTML = '<div class="ov"><div class="op-empty">' + I.alert + '<div class="t">Couldn\'t load ' + esc(repo) + " #" + ref.number + '</div><div class="h">' + esc((d && (d.error && (d.error.message || d.error) || d.message)) || "gh CLI error") + "</div></div></div>"; return; }
    p.innerHTML = ctxHTML(d, ref, repo);
    p.querySelectorAll("[data-open]").forEach(function (b) { b.addEventListener("click", function () { window.open(b.dataset.open, "_blank"); }); });
    // for a PR, pull each linked issue's full content and inline it
    if (ref.kind === "pr") {
      var links = (d.closingIssuesReferences || []).filter(function (x) { return x && x.number; });
      var box = $("ctxLinked");
      if (box && links.length) links.forEach(function (li) {
        fetch("/api/github/issue?repo=" + encodeURIComponent(repo) + "&number=" + li.number, { cache: "no-store" })
          .then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.data) j = j.data; if (!j || !j.title) return;
            var card = el("div", "ctx-linkcard");
            card.innerHTML = '<div class="ctx-c-head"><b>Linked issue #' + esc(j.number) + "</b>" + ghStatePill(j.state) + '<span class="ctx-when">' + esc(j.title || "") + "</span></div>" +
              '<div class="ctx-c-body">' + (j.body && j.body.trim() ? mdLite(j.body) : '<span class="ctx-empty">No description.</span>') + "</div>";
            box.appendChild(card);
          }).catch(function () {});
      });
    }
  }
  function ctxComment(c) {
    var who = (c.author && c.author.login) || c.user || "someone";
    var when = c.createdAt || c.submittedAt || c.created_at;
    var state = c.state ? ghStatePill(c.state) : "";
    var body = c.body && c.body.trim() ? mdLite(c.body) : '<span class="ctx-empty">(no comment body)</span>';
    return '<div class="ctx-comment"><div class="ctx-c-head"><b>@' + esc(who) + "</b>" + state + (when ? '<span class="ctx-when">' + esc(ago(Date.parse(when), Date.now())) + " ago</span>" : "") + "</div><div class=\"ctx-c-body\">" + body + "</div></div>";
  }
  function ctxHTML(d, ref, repo) {
    var branch = ref.kind === "pr" && d.headRefName ? '<span class="mono">' + esc(d.headRefName) + " → " + esc(d.baseRefName || "") + "</span>" : "";
    var links = (d.closingIssuesReferences || []).filter(function (x) { return x && x.number; });
    var reviews = (d.reviews || []).filter(function (r) { return r && r.body && r.body.trim(); });
    var comments = d.comments || [];
    var h = '<div class="ov ctx-wrap">' +
      '<div class="ctx-head"><div class="ctx-title">' + esc(d.title || "") + " " + ghStatePill(d.state, d.isDraft) + "</div>" +
        '<div class="ws-sub"><span class="mono">' + esc(repo) + " #" + d.number + "</span><span>@" + esc((d.author && d.author.login) || "") + "</span>" + (branch ? "<span>" + branch + "</span>" : "") +
        '<button class="btn sm" data-open="' + esc(d.url || "") + '">' + I.external + "Open on GitHub</button></div></div>";
    if (links.length) {
      h += '<div class="ov-sec-label">Linked issues</div><div class="ov-files">' + links.map(function (x) {
        return '<button class="ov-file" data-open="' + esc(x.url || "") + '">#' + esc(x.number) + " · " + esc((x.title || "").slice(0, 60)) + "</button>";
      }).join("") + '</div><div class="ctx-linked" id="ctxLinked"></div>';
    }
    h += '<div class="ov-sec-label">Description</div><div class="ctx-body">' + (d.body && d.body.trim() ? mdLite(d.body) : '<span class="ctx-empty">No description provided.</span>') + "</div>";
    if (ref.kind === "pr") {
      var commits = d.commits || [];
      h += '<div class="ov-sec-label">Commits (' + commits.length + ")</div>";
      h += commits.length ? '<div class="ctx-commits">' + commits.map(function (c) {
        var sha = (c.oid || "").slice(0, 7), who = (c.authors && c.authors[0] && (c.authors[0].login || c.authors[0].name)) || "";
        return '<div class="ctx-commit"><span class="ctx-sha mono">' + esc(sha) + '</span><span class="ctx-cmsg">' + esc(c.messageHeadline || "") + "</span>" + (who ? '<span class="ctx-cauthor">@' + esc(who) + "</span>" : "") + "</div>";
      }).join("") + "</div>" : '<div class="ctx-empty" style="padding:8px 0">No commits.</div>';
    }
    if (reviews.length) h += '<div class="ov-sec-label">Reviews (' + reviews.length + ")</div>" + reviews.map(ctxComment).join("");
    h += '<div class="ov-sec-label">Comments (' + comments.length + ")</div>" + (comments.length ? comments.map(ctxComment).join("") : '<div class="ctx-empty" style="padding:8px 0">No comments yet.</div>');
    return h + "</div>";
  }

  function renderOverview() {
    var p = $("wsOverview"); if (!p) return;
    var s = findAgent(selectedId); if (!s) return;
    var st = statusOf(s);
    var h = "";
    if (st === "waiting") {
      var gate = s.controllable
        ? '<div class="ov-gate">' +
            '<button class="btn allow" id="ovAllow" title="Enter — accept the highlighted choice">' + I.check + "Allow</button>" +
            '<button class="btn danger" id="ovDeny" title="Esc — cancel the request">' + I.x + "Deny</button>" +
            '<button class="btn sm" data-key="interrupt" title="send Ctrl-C">interrupt</button>' +
          "</div>" +
          '<div class="ov-reply"><textarea id="ovReply" placeholder="Reply to the agent…  (⌘↵ to send)"></textarea>' +
          '<button class="btn primary" id="ovSend">' + I.send + "Send</button></div>"
        : '<div class="ov-hint">not in tmux — launch with <code>tmux new -s name claude</code> to answer from here</div>';
      h += '<div class="ov-alert reveal">' +
        '<div class="ov-alert-label">' + I.alert + "Waiting — needs you</div>" +
        '<div class="ov-alert-text">' + esc(s.asking || s.lastPrompt || "(no message captured)") + "</div>" +
        gate +
      "</div>";
    } else if (s.activity) {
      h += '<div class="ov-summary reveal"><div class="ov-summary-label">Now</div><div class="ov-summary-text">' + esc(s.activity) + "</div></div>";
    }
    // watchdog Health, promoted to a lead block (was buried as 1 of 15 stats)
    if (s.health && s.health.level && s.health.level !== "ok" && st !== "waiting") {
      var hact = s.health.action === "terminal" ? '<button class="btn sm" id="ovHealthAct">' + I.terminal + "Open terminal</button>" : "";
      h += '<div class="ov-health ' + esc(s.health.level) + '"><span class="ovh-ic">' + I.alert + "</span><span class=\"ovh-txt\">" + esc(s.health.reason || s.health.level) + "</span>" + hact + "</div>";
    }
    if (s.summary) h += '<div class="ov-summary"><div class="ov-summary-label">Work done</div><div class="ov-summary-text">' + esc(s.summary) + "</div></div>";
    // context-window fill — how full the agent is (near-limit → likely compaction)
    if (s.contextTokens > 0) {
      var ctx = s.contextTokens, lim = ctxLimit(s.model, ctx), pct = lim ? Math.min(100, Math.round(ctx / lim * 100)) : 0;
      var cls = pct >= 85 ? "crit" : pct >= 60 ? "warn" : "ok";
      h += '<div class="ov-ctx"><div class="ov-ctx-head"><span class="ov-ctx-k">Context window</span>' +
        '<span class="ov-ctx-right"><span class="ov-ctx-v mono">' + fmtTokens(ctx) + " / ~" + fmtTokens(lim) + " · " + pct + "% full</span>" +
          (s.controllable && s.tmuxPane ? '<button class="btn xs ov-compact-btn" id="ovCompact" title="Tell the agent to compact its context (/compact)">Compact</button>' : "") +
        "</span></div>" +
        '<div class="ov-ctx-bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div>' +
        (pct >= 85 ? '<div class="ov-ctx-hint">near the limit — compact to free the window before recall degrades</div>' : "") + "</div>";
    }
    // Quality & cost — the per-session score + breakdown, inline on the overview
    if (s.tokensTotal > 0 || (s.toolCalls && s.toolCalls.length)) {
      var qv = s.qualityScore == null ? 100 : s.qualityScore;
      var perMtok = s.tokensTotal > 0 ? "$" + (s.costUsd / (s.tokensTotal / 1e6)).toFixed(2) + " /M tok" : "";
      var qfac = (s.qualityFactors || []).map(function (f) {
        return '<div class="q-row ' + (f.ok ? "ok" : "bad") + '"><span class="q-row-ic">' + (f.ok ? "✓" : "−" + f.penalty) + '</span><span class="q-row-main"><b>' + esc(f.name) + "</b><span>" + esc(f.detail) + "</span></span></div>";
      }).join("");
      h += '<div class="ov-sec-label">Quality &amp; cost</div>' +
        '<div class="q-detail ovq-card">' +
          '<div class="q-hero"><div class="q-score ' + qualityCls(qv) + '">' + (qv < 0 ? "—" : qv) + "</div>" +
            '<div class="q-hero-lab"><b>' + esc(s.qualityLabel || "") + "</b><span>work-quality score</span></div>" +
            '<div class="q-cost"><div class="qc-v">' + fmtUSD(s.costUsd) + '</div><div class="qc-k">cost' + (perMtok ? " · " + esc(perMtok) : "") + "</div></div></div>" +
          '<div class="q-rows">' + qfac + "</div></div>";
    }
    var changed = (s.changedFiles || []).length;
    var health = s.health ? (s.health.level === "alert" ? "⚠ " : "") + (s.health.reason || s.health.level) : "healthy";
    h += '<div class="ov-stats">' +
      stat("Agent", esc(s.provider || "claude")) +
      stat("Status", st) +
      stat("Model", esc(shortModel(s.model) || "—")) +
      stat("Version", esc(s.version || "—")) +
      stat("Tokens", fmtTokens(s.tokensTotal) + " total") +
      stat("Cost (est)", fmtUSD(s.costUsd)) +
      stat("Quality", qualityHTML(s)) +
      stat("Last 5h / 7d", fmtTokens(s.tokens5h) + " / " + fmtTokens(s.tokens7d)) +
      stat("Running for", s.startedAt ? ago(s.startedAt, now()) : "—") +
      stat("Updated", ago(s.updatedAt, now()) + " ago") +
      stat("Health", esc(health)) +
      (s.reflectionAttempts ? stat("Reflexion retries", s.reflectionAttempts + " to green") : "") +
      stat("Changed files", changed ? String(changed) : "0") +
      stat("PID", (s.pid || "—") + (s.alive ? "" : " (exited)")) +
      '<div class="ov-stat full"><div class="k">cwd</div><div class="v wrap">' + esc(s.cwd || "—") + "</div></div>" +
      "</div>";
    // what the agent has been doing — tool-call mix
    var byTool = {}; (s.toolCalls || []).forEach(function (t) { byTool[t.name] = (byTool[t.name] || 0) + 1; });
    var toolNames = Object.keys(byTool).sort(function (a, b) { return byTool[b] - byTool[a]; });
    if (toolNames.length) h += '<div class="ov-sec-label">Tool usage</div><div class="ov-tools">' + toolNames.map(function (n) { return '<span class="ov-tool">' + esc(n) + '<b>' + byTool[n] + "</b></span>"; }).join("") + "</div>";
    if ((s.skills || []).length) h += '<div class="ov-sec-label">Project skills</div><div class="ov-files">' + s.skills.map(function (k) { return '<span class="ov-file">' + esc(k) + "</span>"; }).join("") + "</div>";
    var tools = (s.toolCalls || []).slice(-14).reverse();
    h += '<div class="ov-sec-label">Recent activity</div>';
    if (tools.length) h += '<div class="ov-activity">' + tools.map(function (t) {
      return '<div class="ov-act"><span class="t">' + esc(new Date(t.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) + '</span><span class="n">' + esc(t.name) + '</span><span class="s">' + esc(t.summary || "") + "</span></div>";
    }).join("") + "</div>";
    else h += '<div class="op-empty">' + I.trace + '<div class="t">No tool calls yet</div></div>';
    p.innerHTML = '<div class="ov">' + h + "</div>";
    var send = $("ovSend"), ta = $("ovReply");
    if (send && ta) {
      var doSend = function () { var v = ta.value.trim(); if (!v) return; respond(s.sessionId, "text", v); ta.value = ""; toast("Sent to agent", "ok"); };
      send.addEventListener("click", doSend);
      ta.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doSend(); } });
    }
    $("ovQuality") && $("ovQuality").addEventListener("click", function () { showQuality(s); });
    $("ovHealthAct") && $("ovHealthAct").addEventListener("click", function () { switchTab("terminal"); });
    $("ovCompact") && $("ovCompact").addEventListener("click", function () {
      fetch("/api/compact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: s.sessionId }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: (j && j.data) || j }; }); })
        .then(function (res) { toast(res.ok ? "Sent /compact to the agent" : (resumeErr(res.j) || "Couldn't compact"), res.ok ? "ok" : "err"); })
        .catch(function () { toast("Couldn't compact", "err"); });
    });
    $("ovAllow") && $("ovAllow").addEventListener("click", function () {
      respond(s.sessionId, "allow", "").then(function (res) {
        toast(!res.ok ? "Allow failed" : res.landed ? "Allowed" : "Sent Allow — but the agent's screen didn't change", res.ok && res.landed ? "ok" : "");
      });
    });
    $("ovDeny") && $("ovDeny").addEventListener("click", function () {
      respond(s.sessionId, "deny", "").then(function (res) {
        toast(!res.ok ? "Deny failed" : res.landed ? "Denied" : "Sent Deny — but the agent's screen didn't change", res.ok ? "" : "err");
      });
    });
    p.querySelectorAll("[data-key]").forEach(function (b) {
      b.addEventListener("click", function () { var k = b.dataset.key; respond(s.sessionId, k === "interrupt" ? "interrupt" : "key", k === "interrupt" ? "" : k); });
    });
  }
  function stat(k, v, wrap) { return '<div class="ov-stat"><div class="k">' + k + '</div><div class="v' + (wrap ? " wrap" : "") + '">' + v + "</div></div>"; }
  // qualityHTML renders the per-task work-quality badge (score + label), colored,
  // with the contributing reasons as a tooltip. "—" until the agent has done work.
  function qualityCls(q) { return q < 0 ? "unrated" : q >= 85 ? "ok" : q >= 70 ? "warn" : q >= 50 ? "warn" : "crit"; }
  function qualityHTML(s) {
    if (!(s.tokensTotal > 0 || (s.toolCalls && s.toolCalls.length))) return "—";
    var q = s.qualityScore == null ? 100 : s.qualityScore;
    if (q < 0) return '<span class="q-badge unrated q-click" id="ovQuality" role="button" tabindex="0" title="See how this score is computed">unrated <span class="q-badge-i">?</span></span>';
    return '<span class="q-badge ' + qualityCls(q) + ' q-click" id="ovQuality" role="button" tabindex="0" title="See how this score is computed">' + q + " · " + esc(s.qualityLabel || "") + ' <span class="q-badge-i">?</span></span>';
  }
  // showQuality opens the per-task breakdown: how the score was computed, cost
  // alongside it, and an honest note on what it does and doesn't measure.
  function showQuality(s) {
    var q = s.qualityScore == null ? 100 : s.qualityScore;
    var factors = s.qualityFactors || [];
    var perM = s.tokensTotal > 0 ? "$" + (s.costUsd / (s.tokensTotal / 1e6)).toFixed(2) + " /M tok" : "";
    var rows = factors.map(function (f) {
      return '<div class="q-row ' + (f.ok ? "ok" : "bad") + '">' +
        '<span class="q-row-ic">' + (f.ok ? "✓" : "−" + f.penalty) + "</span>" +
        '<span class="q-row-main"><b>' + esc(f.name) + "</b><span>" + esc(f.detail) + "</span></span></div>";
    }).join("");
    var note = "<b>What this is:</b> a read on how the run went — anchored on the build/test outcome and the tool-call error rate, with looping/retries/stalls as minor factors — all from signals rook tracks locally. " +
      "<b>What it is not:</b> a check that the output is correct (there is no LLM judge here). A 100 with no gate run means nothing went visibly wrong, not that the work is verified. " +
      "Turn on Auto-verify in Settings so the build/test outcome drives the score.";
    var body = '<div class="q-detail">' +
      '<div class="q-hero"><div class="q-score ' + qualityCls(q) + '">' + (q < 0 ? "—" : q) + "</div>" +
        '<div class="q-hero-lab"><b>' + esc(s.qualityLabel || "") + "</b><span>work-quality score</span></div>" +
        '<div class="q-cost"><div class="qc-v">' + fmtUSD(s.costUsd) + '</div><div class="qc-k">cost' + (perM ? " · " + esc(perM) : "") + "</div></div></div>" +
      (q < 0 ? "" : '<div class="q-formula">Starts at <b>100</b>; each detected problem subtracts points.</div>') +
      '<div class="q-rows">' + rows + "</div>" +
      '<div class="q-note">' + note + "</div></div>";
    modal("Quality · " + (s.title || s.project || "task"), body);
  }
  // Claude's context window is ~200k by default, or ~1M with the long-context
  // beta. rook can't read the setting, so it infers the window as a per-MODEL
  // property: if ANY session on a model has read >200k tokens, that model is on
  // the 1M window here, so every session on it uses 1M — even ones currently
  // well under 200k. Without this, a 1M agent sitting at 179k gets mislabelled a
  // 200k agent at "90% full". Scanning one session in isolation can't tell the
  // difference; scanning all sessions on the model can.
  function windowForModel(model) {
    var max = 0, m = model || "";
    sessions().forEach(function (s) { if ((s.model || "") === m) max = Math.max(max, s.contextTokens || 0); });
    return max > 200000 ? 1000000 : 200000;
  }
  function ctxLimit(model, used) {
    return Math.max(windowForModel(model), (used || 0) > 200000 ? 1000000 : 200000);
  }

  function renderFiles() {
    var p = $("wsFiles"); if (!p || p.dataset.done === selectedId) { if (p) p.dataset.done = selectedId; }
    var s = findAgent(selectedId); if (!s || !p) return;
    var files = s.changedFiles || [];
    if (!files.length) { p.innerHTML = '<div class="op-empty">' + I.file + '<div class="t">No changed files</div></div>'; return; }
    p.innerHTML = '<div class="ws-diff-mount"><div class="ov-sec-label">Files changed (' + files.length + ')</div><div class="ov-files">' +
      files.map(function (f) { return '<button class="ov-file" data-f="' + esc(f) + '" title="' + esc(f) + '">' + esc(f.split("/").pop()) + "</button>"; }).join("") + "</div></div>";
    p.querySelectorAll(".ov-file").forEach(function (b) { b.addEventListener("click", function () { switchTab("diff"); }); });
  }

  function renderTraceTab() {
    var p = $("wsTrace"); if (!p) return;
    var s = findAgent(selectedId); if (!s) return;
    if (ws.traceLoaded && p.dataset.for === selectedId) return;
    ws.traceLoaded = true; p.dataset.for = selectedId;
    var calls = (s.toolCalls || []).map(function (t) { return { name: t.name, summary: t.summary, ts: new Date(t.timestamp).getTime(), durMs: t.durMs || 0, isError: !!t.isError }; }).filter(function (c) { return !isNaN(c.ts); }).sort(function (a, b) { return a.ts - b.ts; });
    if (calls.length < 2 || !window.rookCharts) { p.innerHTML = '<div class="op-empty">' + I.trace + '<div class="t">Not enough tool calls for a trace</div></div>'; return; }
    var t0 = calls[0].ts;
    // real per-call duration (result_ts - use_ts); estimate the few still running
    var real = calls.map(function (c) { return c.durMs; }).filter(function (d) { return d > 0; }).sort(function (a, b) { return a - b; });
    var estDur = real.length ? real[Math.floor(real.length / 2)] : 800;
    var spans = calls.map(function (c) {
      var est = !(c.durMs > 0);
      return { name: c.summary ? (c.name + " · " + c.summary).slice(0, 60) : c.name, type: c.name, startMs: c.ts - t0, durMs: est ? estDur : c.durMs, isError: c.isError, estimated: est, depth: 0 };
    });
    p.innerHTML = '<div class="ws-trace-mount"><div class="ov-sec-label">Execution trace · ' + calls.length + ' spans</div><div id="wsTraceChart"></div></div>';
    window.rookCharts.traceTimeline($("wsTraceChart"), { spans: spans });
  }

  // ---- review comment threads (persisted, routed to the agent, stateful) ----
  function loadReviewThreads(sid, container) {
    if (!container) return;
    fetch("/api/review/comments?sessionId=" + encodeURIComponent(sid), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (j) { if (j && j.data) j = j.data; renderReviewThreads(container, sid, j || []); })
      .catch(function () {});
  }
  function postJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: (j && j.data) || j }; }); });
  }
  function renderReviewThreads(container, sid, comments) {
    if (!container) return;
    if (!comments.length) { container.innerHTML = ""; return; }
    var open = comments.filter(function (c) { return c.state === "open"; }).length;
    container.innerHTML =
      '<div class="ws-th-head"><span class="ws-th-title">Review threads <b>' + comments.length + "</b></span>" +
      (open ? '<button class="btn sm" id="wsThSendAll">Send ' + open + " open to agent</button>" : "") + "</div>" +
      '<div class="ws-th-list">' + comments.map(function (c) {
        return '<div class="ws-th-item ' + c.state + '" data-id="' + c.id + '">' +
          '<div class="ws-th-loc mono">' + esc(c.file || "") + (c.line ? ":" + c.line : "") + "</div>" +
          '<div class="ws-th-text">' + esc(c.text) + "</div>" +
          '<div class="ws-th-actions"><span class="ws-th-state ' + c.state + '">' + c.state + "</span>" +
            (c.state === "open" ? '<button class="btn xs" data-act="send">Send</button>' : "") +
            (c.state === "sent" ? '<button class="btn xs" data-act="send" title="Re-send this comment to the agent">Nudge</button>' : "") +
            (c.state === "addressed" ? '<button class="btn xs" data-act="reopen">Reopen</button>' : '<button class="btn xs" data-act="addressed">Mark done</button>') +
            '<button class="btn xs danger" data-act="del" title="Delete">×</button>' +
          "</div></div>";
      }).join("") + "</div>";
    var sendAll = container.querySelector("#wsThSendAll");
    if (sendAll) sendAll.addEventListener("click", function () {
      postJSON("/api/review/comment/send", { sessionId: sid }).then(function (res) {
        if (!res.ok) throw new Error(resumeErr(res.j) || "send failed");
        toast("Sent " + (res.j.sent || "") + " to agent", "ok"); loadReviewThreads(sid, container);
      }).catch(function (e) { toast(e.message || "send failed", "err"); });
    });
    container.querySelectorAll(".ws-th-item").forEach(function (row) {
      var id = parseInt(row.dataset.id, 10);
      row.querySelectorAll("[data-act]").forEach(function (b) {
        b.addEventListener("click", function () {
          var act = b.dataset.act;
          if (act === "del") { fetch("/api/review/comment?id=" + id, { method: "DELETE" }).then(function () { loadReviewThreads(sid, container); }); return; }
          if (act === "send") {
            postJSON("/api/review/comment/send", { id: id }).then(function (res) {
              if (!res.ok) throw new Error(resumeErr(res.j) || "send failed");
              toast("Sent to agent", "ok"); loadReviewThreads(sid, container);
            }).catch(function (e) { toast(e.message || "send failed", "err"); });
            return;
          }
          postJSON("/api/review/comment/state", { id: id, state: act === "reopen" ? "open" : "addressed" })
            .then(function () { loadReviewThreads(sid, container); });
        });
      });
    });
  }

  async function loadDiff() {
    var p = $("wsDiff"); if (!p) return;
    var s = findAgent(selectedId); if (!s || !s.cwd) { p.innerHTML = '<div class="op-empty">' + I.diff + '<div class="t">No working directory</div></div>'; return; }
    ws.diffLoaded = true; p.dataset.for = selectedId;
    p.innerHTML = '<div class="ws-diff-mount"><div class="op-empty">Loading diff…</div></div>';
    try {
      // for a PR-review agent, ask for that PR's diff by number so it's correct
      // even before the worktree has checked the PR branch out
      var url = "/api/diff?path=" + encodeURIComponent(s.cwd);
      if (ws.ghRef && ws.ghRef.kind === "pr" && ws.ghRef.number) url += "&pr=" + encodeURIComponent(ws.ghRef.number);
      var d = await (await fetch(url, { cache: "no-store" })).json();
      if (d.data) d = d.data;
      p.innerHTML = "";
      var threads = el("div", "ws-threads"); threads.id = "wsThreads"; p.appendChild(threads);
      var mount = el("div"); p.appendChild(mount);
      if (window.renderDiffV2) {
        window.renderDiffV2(mount, d, { onSend: function (comments) {
          if (!comments || !comments.length) return;
          var sid = s.sessionId;
          // persist each inline comment as an open thread, then route all open ones
          Promise.all(comments.map(function (c) {
            return fetch("/api/review/comment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid, file: c.file || "", line: c.line || 0, side: c.side || "", text: c.text }) });
          })).then(function () {
            return postJSON("/api/review/comment/send", { sessionId: sid });
          }).then(function (res) {
            toast(((res.j && res.j.sent) || comments.length) + " comment(s) sent to agent", "ok");
            loadReviewThreads(sid, $("wsThreads"));
          }).catch(function () { toast("Couldn't send comments", "err"); loadReviewThreads(sid, $("wsThreads")); });
        } });
      } else { p.innerHTML = "<pre style='padding:16px;white-space:pre-wrap'>" + esc(d.patch || "") + "</pre>"; return; }
      loadReviewThreads(s.sessionId, threads); // hydrate persisted threads (survive reload/restart)
    } catch (e) { p.innerHTML = '<div class="op-empty">' + I.alert + '<div class="t">Couldn\'t load diff</div></div>'; }
  }

  // ---- Find: search the agent's repo (grep/ripgrep, no index) ---------------
  function renderFind() {
    var p = $("wsFind"); if (!p) return;
    var s = findAgent(selectedId);
    if (!s || !s.cwd) { p.innerHTML = '<div class="op-empty">' + I.search + '<div class="t">No working directory</div></div>'; return; }
    if (p.dataset.for === selectedId) { var inp = $("wsFindInput"); inp && inp.focus(); return; } // keep state on re-activate
    p.dataset.for = selectedId;
    var cwd = s.cwd;
    p.innerHTML =
      '<div class="ws-find">' +
        '<div class="ws-find-bar">' + I.search +
          '<input id="wsFindInput" placeholder="Search this repo — symbol, string, regex…" autocomplete="off" spellcheck="false" />' +
          '<span class="ws-find-meta mono" id="wsFindMeta"></span>' +
        "</div>" +
        '<div class="ws-find-results" id="wsFindResults"><div class="op-empty">' + I.search + '<div class="t">Search the agent\'s repo</div><div class="h">Exact file:line hits — ripgrep / git grep, no index. Click a hit to open it in your editor.</div></div></div>' +
      "</div>";
    var input = $("wsFindInput"), meta = $("wsFindMeta"), results = $("wsFindResults");
    var timer = null, lastQ = null;
    function run() {
      var q = input.value.trim();
      if (q === lastQ) return; lastQ = q;
      if (q.length < 2) { results.innerHTML = '<div class="op-empty">' + I.search + '<div class="t">Type at least 2 characters</div></div>'; meta.textContent = ""; return; }
      meta.textContent = "searching…";
      fetch("/api/context?dir=" + encodeURIComponent(cwd) + "&q=" + encodeURIComponent(q), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.data) j = j.data; if (input.value.trim() !== q) return; renderFindResults(results, meta, cwd, q, j || {}); })
        .catch(function () { meta.textContent = ""; results.innerHTML = '<div class="op-empty">' + I.alert + '<div class="t">Search failed</div></div>'; });
    }
    input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(run, 220); });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { clearTimeout(timer); run(); } });
    setTimeout(function () { input.focus(); }, 30);
  }
  function findHighlight(text, q) {
    var e = esc(text);
    try {
      var eq = esc(q), idx = e.toLowerCase().indexOf(eq.toLowerCase());
      if (idx >= 0) return e.slice(0, idx) + "<mark>" + e.slice(idx, idx + eq.length) + "</mark>" + e.slice(idx + eq.length);
    } catch (x) {}
    return e;
  }
  function renderFindResults(results, meta, cwd, q, j) {
    var m = j.matches || [], base = cwd.replace(/\/+$/, "");
    meta.textContent = (j.count || 0) + (j.count >= 100 ? "+" : "") + " hit" + (j.count === 1 ? "" : "s") + (j.tool ? " · " + j.tool : "");
    if (!m.length) { results.innerHTML = '<div class="op-empty">' + I.search + '<div class="t">No matches for “' + esc(q) + '”</div></div>'; return; }
    results.innerHTML = m.map(function (r) {
      var abs = r.file.charAt(0) === "/" ? r.file : base + "/" + r.file;
      var rel = abs.indexOf(base + "/") === 0 ? abs.slice(base.length + 1) : r.file;
      return '<div class="ws-find-row" data-abs="' + esc(abs) + '" data-line="' + r.line + '" title="Open in editor">' +
        '<div class="ws-find-loc mono"><span class="ff-file">' + esc(rel) + '</span><span class="ff-line">:' + r.line + "</span></div>" +
        '<div class="ws-find-code mono">' + findHighlight(r.text, q) + "</div>" +
      "</div>";
    }).join("");
    results.querySelectorAll(".ws-find-row").forEach(function (row) {
      row.addEventListener("click", function () {
        fetch("/api/open-editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: row.dataset.abs, line: parseInt(row.dataset.line, 10) }) })
          .then(function (r) { return r.json().then(function (jj) { return { ok: r.ok, j: (jj && jj.data) || jj }; }); })
          .then(function (res) { toast(res.ok ? "Opened in editor" : (resumeErr(res.j) || "Couldn't open — set your editor in Settings"), res.ok ? "ok" : "err"); })
          .catch(function () { toast("Couldn't open", "err"); });
      });
    });
  }

  // ---- Notes: a durable per-run scratchpad (kept outside the context window) -
  function renderNotes() {
    var p = $("wsNotes"); if (!p) return;
    var s = findAgent(selectedId); if (!s) return;
    if (p.dataset.for === selectedId) { var ta0 = $("wsNotesTA"); ta0 && ta0.focus(); return; } // build once; keep the textarea across polls
    p.dataset.for = selectedId;
    p.innerHTML =
      '<div class="ws-notes">' +
        '<div class="ws-notes-head"><span class="ws-notes-k">Scratchpad</span>' +
          '<span class="ws-notes-status" id="wsNotesStatus">durable notes for this run — kept outside the context window</span>' +
          (s.controllable && s.tmuxPane ? '<button class="btn xs" id="wsNotesSend" title="Paste these notes to the agent as context">Send to agent</button>' : "") +
        "</div>" +
        '<textarea class="ws-notes-ta" id="wsNotesTA" placeholder="Jot durable context, decisions, TODOs… autosaved, survives restart."></textarea>' +
      "</div>";
    var ta = $("wsNotesTA"), status = $("wsNotesStatus"), idleMsg = "durable notes for this run — kept outside the context window";
    fetch("/api/scratchpad?sessionId=" + encodeURIComponent(s.sessionId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.data) j = j.data; if (p.dataset.for === selectedId && document.activeElement !== ta) ta.value = (j && j.content) || ""; })
      .catch(function () {});
    var timer = null;
    ta.addEventListener("input", function () {
      clearTimeout(timer); status.textContent = "saving…";
      timer = setTimeout(function () {
        fetch("/api/scratchpad", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: s.sessionId, content: ta.value }) })
          .then(function (r) { status.textContent = r.ok ? "saved ✓" : "save failed"; setTimeout(function () { if (status) status.textContent = idleMsg; }, 1600); })
          .catch(function () { status.textContent = "save failed"; });
      }, 500);
    });
    $("wsNotesSend") && $("wsNotesSend").addEventListener("click", function () {
      if (!ta.value.trim()) { toast("Nothing to send", ""); return; }
      respond(s.sessionId, "text", "Notes for context:\n" + ta.value.trim()); toast("Sent notes to agent", "ok");
    });
    setTimeout(function () { ta.focus(); }, 30);
  }

  function openTermTab() {
    var p = $("wsTerm"); if (!p) return;
    var s = findAgent(selectedId); if (!s || !s.controllable || !s.tmuxPane) { p.innerHTML = '<div class="op-empty">' + I.terminal + '<div class="t">This agent has no attachable terminal</div></div>'; return; }
    // Already attached to this pane — do nothing on poll. Re-fitting here every
    // 2s cleared any in-progress text selection, making copy impossible; genuine
    // container resizes are handled by the ResizeObserver below.
    if (ws.term && ws.term.pane === s.tmuxPane) { return; }
    teardownTerm();
    p.innerHTML = '<div class="ws-term-wrap"><div class="ws-term-bar">' + I.terminal + "<span>tmux · " + esc(s.tmuxPane) + "</span><span class=\"ws-term-hint\">scroll to view history · ⌥-drag to select &amp; copy</span></div><div class=\"ws-term-host\" id=\"wsTermHost\"></div></div>";
    if (typeof Terminal === "undefined") { p.innerHTML = '<div class="op-empty">terminal library not loaded</div>'; return; }
    var host = $("wsTermHost");
    var xt = new Terminal({ fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 8000, allowProposedApi: true, macOptionClickForcesSelection: true, theme: { background: "#08080a", foreground: "#e6e6ea", cursor: "#ff5c3a", selectionBackground: "rgba(255,92,58,.4)" } });
    var fit = new FitAddon.FitAddon(); xt.loadAddon(fit); xt.open(host);
    var rec = { pane: s.tmuxPane, xt: xt, fit: fit, host: host, ws: null };
    ws.term = rec;
    xt.onData(function (d) { if (rec.ws && rec.ws.readyState === 1) rec.ws.send(d); });
    rec.ro = new ResizeObserver(function () { if (ws.tab === "terminal") fitTerm(); }); rec.ro.observe(host);
    connectTerm(rec);
  }
  function fitTerm() {
    var r = ws.term; if (!r) return;
    // never resize mid-selection — fit() clears the xterm selection, which would
    // wipe what the user is trying to copy.
    if (r.xt.hasSelection && r.xt.hasSelection()) return;
    try {
      r.fit.fit();
      // backend control protocol is {"resize":[cols,rows]}; only send when the
      // size actually changed to avoid a resize storm on every layout tick.
      if (r.ws && r.ws.readyState === 1 && (r.xt.cols !== r._c || r.xt.rows !== r._r)) {
        r._c = r.xt.cols; r._r = r.xt.rows;
        r.ws.send(JSON.stringify({ resize: [r.xt.cols, r.xt.rows] }));
      }
    } catch (e) {}
  }
  function connectTerm(rec) {
    try { rec.fit.fit(); } catch (e) {}
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var url = proto + "://" + location.host + "/ws/term?target=" + encodeURIComponent(rec.pane) + "&cols=" + (rec.xt.cols || 120) + "&rows=" + (rec.xt.rows || 32);
    var sock = new WebSocket(url); sock.binaryType = "arraybuffer"; rec.ws = sock;
    sock.onopen = function () { setTimeout(fitTerm, 60); };
    sock.onmessage = function (e) { rec.xt.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data)); };
    sock.onclose = function () { try { rec.xt.write("\r\n\x1b[38;5;244m[detached]\x1b[0m\r\n"); } catch (e) {} };
    sock.onerror = function () {};
  }

  // ---- insights view -------------------------------------------------------
  function buildInsights() { var v = el("div", "ins"); v.id = "opInsights"; v.innerHTML = '<div class="op-empty">Loading…</div>'; return v; }
  var insMetric = "messages"; // messages | tokens | toolCalls
  var insTrends = [];
  function compBar(w) {
    var t = w.total || 1;
    var seg = [["input", w.input, "--busy"], ["output", w.output, "--ok"], ["cache write", w.cacheWrite, "--waiting"], ["cache read", w.cacheRead, "--coral"]];
    var bar = seg.map(function (s) { var pct = (s[1] || 0) / t * 100; return pct > 0.05 ? '<i style="width:' + pct.toFixed(2) + "%;background:var(" + s[2] + ')"></i>' : ""; }).join("");
    var legend = seg.map(function (s) { return '<span><i style="background:var(' + s[2] + ')"></i>' + s[0] + " " + fmtTokens(s[1] || 0) + "</span>"; }).join("");
    return '<div class="ins-comp">' + bar + '</div><div class="ins-comp-legend">' + legend + "</div>";
  }
  function renderInsTrend() {
    if (!window.rookCharts || !$("insTrend")) return;
    var isTok = insMetric === "tokens";
    var fmt = isTok ? fmtTokens : function (v) { return Math.round(v).toLocaleString(); };
    window.rookCharts.lineArea($("insTrend"), {
      points: insTrends.map(function (t) { return { label: new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: t[insMetric] || 0 }; }),
      format: fmt
    });
  }
  async function renderInsights() {
    var host = $("opInsights"); if (!host) return;
    var d = {}; try { d = await (await fetch("/api/usage", { cache: "no-store" })).json(); if (d.data) d = d.data; } catch (e) {}
    var models = (d.models || []).filter(function (m) { return (m.tokensTotal || 0) > 0 || (m.costUsd || 0) > 0; });
    var runs = d.runs || [], wins = d.windows || [];
    insTrends = (state && state.trends) || [];
    var TL = { messages: "Messages", tokens: "Tokens", toolCalls: "Tool calls" };
    host.innerHTML =
      '<div class="ins-windows">' + wins.map(function (w) {
        return '<div class="ins-win"><div class="ins-win-label">' + esc(w.label) + '</div>' +
          '<div class="ins-win-val">' + fmtTokens(w.total) + ' <span class="ins-win-unit">tokens</span></div>' +
          '<div class="ins-win-sub">' + (w.messages || 0).toLocaleString() + " messages · " + fmtUSD(w.costUsd) + "</div>" +
          compBar(w) +
        "</div>";
      }).join("") + "</div>" +
      '<div style="height:16px"></div>' +
      '<div class="ins-sec-title">Quality &amp; cost per session</div>' +
      '<div class="ins-qtiles" id="insQTiles"></div>' +
      '<div class="ins-grid">' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Quality by session</div><div class="ins-card-meta">0–100 · higher is better</div></div><div id="insQualBar"></div></div>' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Cost by session</div></div><div id="insCostBar"></div></div>' +
      "</div>" +
      '<div style="height:22px"></div>' +
      '<div class="ins-grid">' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Cost by model</div><div class="ins-card-meta">' + fmtUSD(d.costUsd) + " · " + fmtTokens(d.tokensTotal) + '</div></div><div id="insModels"></div></div>' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Share</div></div><div id="insDonut"></div></div>' +
        '<div class="ins-card wide"><div class="ins-card-head"><div class="ins-card-title">Activity · last 30 days</div>' +
          '<div class="ins-toggle" id="insToggle">' + Object.keys(TL).map(function (k) { return '<button data-m="' + k + '" class="' + (k === insMetric ? "on" : "") + '">' + TL[k] + "</button>"; }).join("") + "</div>" +
        '</div><div id="insTrend"></div></div>' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Cost by project</div></div><div id="insProjects"></div></div>' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Top runs by cost</div><div class="ins-card-meta">' + runs.length + ' runs</div></div><div id="insRuns"></div></div>' +
      "</div>";
    // per-project cost, aggregated from the live session list (complete, not just top runs)
    var worked = function (s) { return (s.tokensTotal > 0) || (s.toolCalls && s.toolCalls.length); };
    var qAvgHTML = function (sum, n) { if (!n) return "—"; var q = Math.round(sum / n); return '<span class="q-badge ' + qualityCls(q) + '">' + q + "</span>"; };
    var byProj = {};
    sessions().forEach(function (s) { var p = s.project || "—"; if (!byProj[p]) byProj[p] = { agents: 0, tok: 0, cost: 0, qsum: 0, qn: 0 }; byProj[p].agents++; byProj[p].tok += s.tokensTotal || 0; byProj[p].cost += s.costUsd || 0; if (worked(s) && s.qualityScore != null && s.qualityScore >= 0) { byProj[p].qsum += s.qualityScore; byProj[p].qn++; } });
    var projRows = Object.keys(byProj).map(function (p) { return { p: p, agents: byProj[p].agents, tok: byProj[p].tok, cost: byProj[p].cost, qsum: byProj[p].qsum, qn: byProj[p].qn }; })
      .filter(function (r) { return r.tok > 0 || r.cost > 0; }).sort(function (a, b) { return b.cost - a.cost; });
    if ($("insProjects")) $("insProjects").innerHTML = projRows.length
      ? '<table class="ins-mtable"><thead><tr><th>Project</th><th>Agents</th><th>Tokens</th><th>Quality</th><th>Cost</th></tr></thead><tbody>' +
        projRows.slice(0, 10).map(function (r) {
          return "<tr><td class=mn>" + esc(r.p) + "</td><td class=n>" + r.agents + "</td><td class=n>" + fmtTokens(r.tok) + '</td><td class="n">' + qAvgHTML(r.qsum, r.qn) + '</td><td class="n cost">' + fmtUSD(r.cost) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="op-empty">No project cost yet</div>';
    // avg quality per model (from the live session list) to pair with cost-by-model
    var qByModel = {};
    sessions().forEach(function (s) { if (!worked(s) || s.qualityScore == null || s.qualityScore < 0) return; var m = shortModel(s.model) || "—"; if (!qByModel[m]) qByModel[m] = { sum: 0, n: 0 }; qByModel[m].sum += s.qualityScore; qByModel[m].n++; });
    var perMtok = function (m) { var mt = (m.tokensTotal || 0) / 1e6; return mt > 0.0001 ? "$" + (m.costUsd / mt).toFixed(2) : "—"; };
    $("insModels").innerHTML = models.length
      ? '<table class="ins-mtable"><thead><tr><th>Model</th><th>Sessions</th><th>Tokens</th><th>$/M tok</th><th>Quality</th><th>Cost</th></tr></thead><tbody>' +
        models.map(function (m) {
          var qm = qByModel[shortModel(m.model) || "—"] || { sum: 0, n: 0 };
          return "<tr><td class=mn>" + esc(shortModel(m.model) || "—") + "</td><td class=n>" + (m.sessions || 0) + "</td><td class=n>" + fmtTokens(m.tokensTotal) + "</td><td class=n>" + perMtok(m) + '</td><td class="n">' + qAvgHTML(qm.sum, qm.n) + '</td><td class="n cost">' + fmtUSD(m.costUsd) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="op-empty">No usage yet</div>';
    $("insRuns").innerHTML = runs.length
      ? '<table class="ins-rtable"><tbody>' + runs.slice(0, 15).map(function (r, i) {
          return '<tr><td class="rk-num">' + (i + 1) + '</td><td class="rt">' + esc(r.title || r.project || r.sessionId) + '</td><td class="rm">' + esc(shortModel(r.model) || "") + '</td><td class="n">' + fmtTokens(r.tokensTotal) + '</td><td class="n cost">' + fmtUSD(r.costUsd) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="op-empty">No runs</div>';
    var tog = $("insToggle");
    if (tog) tog.querySelectorAll("button").forEach(function (b) { b.addEventListener("click", function () { insMetric = b.dataset.m; tog.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); }); renderInsTrend(); }); });
    if (window.rookCharts) {
      window.rookCharts.donut($("insDonut"), { slices: models.map(function (m) { return { label: shortModel(m.model) || "—", value: m.costUsd || 0 }; }), format: fmtUSD });
      renderInsTrend();
    }
    // Quality & cost per session — tiles + two bar charts over the top sessions
    var qWorked = sessions().filter(function (s) { return ((s.tokensTotal > 0) || (s.toolCalls && s.toolCalls.length)) && s.qualityScore != null && s.qualityScore >= 0; });
    var qScore = function (s) { return s.qualityScore == null ? 0 : s.qualityScore; };
    var qColor = function (v) { return v >= 85 ? "var(--ok)" : v >= 60 ? "var(--busy)" : "var(--danger)"; };
    var qLabel = function (s) { return (s.title || s.project || "session").slice(0, 26); };
    var qTop = qWorked.slice().sort(function (a, b) { return (b.costUsd || 0) - (a.costUsd || 0); }).slice(0, 8);
    if ($("insQTiles")) {
      var scores = qWorked.map(qScore);
      var avgQ = scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) : 0;
      var pctExc = scores.length ? Math.round(scores.filter(function (v) { return v >= 85; }).length / scores.length * 100) : 0;
      var risk = scores.filter(function (v) { return v < 50; }).length;
      $("insQTiles").innerHTML =
        '<div class="ins-qtile"><div class="qt-v ' + (avgQ >= 85 ? "ok" : avgQ >= 60 ? "warn" : "crit") + '">' + avgQ + '</div><div class="qt-k">avg quality</div></div>' +
        '<div class="ins-qtile"><div class="qt-v">' + pctExc + '%</div><div class="qt-k">excellent</div></div>' +
        '<div class="ins-qtile"><div class="qt-v ' + (risk ? "crit" : "") + '">' + risk + '</div><div class="qt-k">at risk</div></div>';
    }
    if (window.rookCharts && $("insQualBar")) {
      window.rookCharts.barChart($("insQualBar"), { series: qTop.map(function (s) { var v = qScore(s); return { label: qLabel(s), value: v, sub: s.qualityLabel || "", color: qColor(v) }; }), format: function (v) { return String(Math.round(v)); } });
      window.rookCharts.barChart($("insCostBar"), { series: qTop.map(function (s) { return { label: qLabel(s), value: s.costUsd || 0, sub: shortModel(s.model) || "" }; }), format: fmtUSD });
    }
  }

  // ---- board view ----------------------------------------------------------
  function buildBoardView() {
    var v = el("div", "op-board-view");
    v.innerHTML = '<div class="op-board-head"><h1>Board</h1><p>Every agent by its live state — click a card to open it, or act right from the card.</p></div><div id="opBoardMount"></div>';
    return v;
  }
  var boardChains = [];
  async function renderBoard() {
    var mount = $("opBoardMount"); if (!mount) return;
    try { boardChains = await (await fetch("/api/chains", { cache: "no-store" })).json(); if (boardChains && boardChains.data) boardChains = boardChains.data; } catch (e) { boardChains = []; }
    if (!window.renderBoardV2) { mount.innerHTML = '<div class="op-empty">board module not loaded</div>'; return; }
    window.renderBoardV2(mount, { sessions: sessions(), chains: boardChains || [] }, {
      onOpen: function (id) { setView("operator"); selectAgent(id); },
      onDiff: function (id) { setView("operator"); selectAgent(id); switchTab("diff"); },
      onReview: function (id) { setView("operator"); selectAgent(id); switchTab("diff"); },
      onTerminal: function (id) { setView("operator"); selectAgent(id); switchTab("terminal"); },
      onAllow: function (id) { respond(id, "allow", ""); },
      onDeny: function (id) { respond(id, "deny", ""); },
      onNewTask: createChain, onMove: function () {}
    });
  }

  // ---- settings (real form over /api/config + hooks) -----------------------
  function buildSettings(host) {
    var v = el("div", "ins"); v.id = "opSettings";
    v.innerHTML = '<div class="op-empty">Loading settings…</div>';
    host.appendChild(v);
    loadSettings();
  }
  async function loadSettings() {
    var host = $("opSettings"); if (!host) return;
    var cfg = {}, hooks = {};
    try { cfg = await (await fetch("/api/config", { cache: "no-store" })).json(); if (cfg.data) cfg = cfg.data; } catch (e) {}
    try { hooks = await (await fetch("/api/hooks/status", { cache: "no-store" })).json(); if (hooks.data) hooks = hooks.data; } catch (e) {}
    var field = function (label, id, val, ph, type) { return '<label class="set-field"><span class="set-k">' + esc(label) + '</span><input class="set-in" id="set_' + id + '" type="' + (type || "text") + '" value="' + esc(val == null ? "" : val) + '" placeholder="' + esc(ph || "") + '" /></label>'; };
    var toggle = function (label, id, on, hint) { return '<label class="set-toggle"><input type="checkbox" id="set_' + id + '" ' + (on ? "checked" : "") + ' /><span><b>' + esc(label) + "</b>" + (hint ? '<span class="set-hint">' + esc(hint) + "</span>" : "") + "</span></label>"; };
    var selectField = function (label, id, val, opts) { return '<label class="set-field"><span class="set-k">' + esc(label) + '</span><select class="set-in" id="set_' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === val ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select></label>"; };
    var chip = function (on, name) { return '<span class="pill ' + (on ? "ok" : "idle") + '" style="margin-left:6px">' + esc(name) + "</span>"; };
    host.innerHTML =
      '<div class="ins-grid" style="grid-template-columns:1fr 1fr">' +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Automation</div></div>' +
          toggle("Destructive-command gate", "hooksGate", cfg.hooksGate, "block clearly-dangerous commands via the PreToolUse hook") +
          toggle("Auto-review on finish", "autoReview", cfg.autoReview, "spawn a review subagent when a session ends with changes") +
          toggle("Auto-verify (build/test) on finish", "autoVerify", cfg.autoVerify, "run the project's test/build command when a session ends") +
          toggle("Auto-compact near context limit", "autoCompact", cfg.autoCompact, "tell an idle agent to /compact when its context passes ~85%") +
          toggle("Allow write actions", "allowWrite", cfg.allowWrite, "enable PR create/merge to GitHub") +
          field("Max reflect iterations", "maxReflectIterations", cfg.maxReflectIterations || "", "3", "number") +
          field("Review passes (diverse panel)", "reviewPasses", cfg.reviewPasses || "", "1 = single · 2–3 = panel", "number") +
        "</div>" +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Claude Code hooks</div><div class="ins-card-meta">' + (hooks.installed ? '<span class="pill ok">installed</span>' : '<span class="pill dead">not installed</span>') + "</div></div>" +
          '<div class="set-hint mono" style="margin-bottom:10px;word-break:break-all">' + esc(hooks.settingsPath || "") + "</div>" +
          '<div class="ov-sec-label">Recent events (' + (hooks.events || 0) + ")</div>" +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
            (hooks.installed ? '<button class="btn sm danger" id="setHookUninstall">Uninstall</button>' : '<button class="btn sm primary" id="setHookInstall">Install hooks</button>') +
          "</div>" +
        "</div>" +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Notifications & editor</div><div class="ins-card-meta">' + chip(!!cfg.slackWebhook, "Slack") + chip(!!cfg.discordWebhook, "Discord") + chip(!!cfg.ntfy, "ntfy") + "</div></div>" +
          field("ntfy topic URL", "ntfy", cfg.ntfy, "https://ntfy.sh/your-topic") +
          field("Slack webhook", "slackWebhook", cfg.slackWebhook, "https://hooks.slack.com/…") +
          field("Discord webhook", "discordWebhook", cfg.discordWebhook, "https://discord.com/api/webhooks/…") +
          selectField("Open worktrees in", "editor", cfg.editor || "code", ["code", "cursor", "idea", "zed", "subl"]) +
          '<div style="margin-top:8px"><button class="btn sm" id="setNotifTest">' + I.send + "Send test notification</button></div>" +
        "</div>" +
        '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Trackers & summaries</div><div class="ins-card-meta">' + chip(!!cfg.linearToken, "Linear") + chip(!!(cfg.jiraToken && cfg.jiraBase), "Jira") + "</div></div>" +
          field("Linear token", "linearToken", cfg.linearToken, "lin_api_…") +
          field("Jira base URL", "jiraBase", cfg.jiraBase, "https://acme.atlassian.net") +
          field("Jira email", "jiraEmail", cfg.jiraEmail, "") +
          field("Jira token", "jiraToken", cfg.jiraToken, "") +
          field("Summary author (GitHub)", "summaryAuthor", cfg.summaryAuthor, "") +
          field("Summary repos", "summaryRepos", cfg.summaryRepos, "org/repo, org/repo2") +
          field("Summary schedule", "summarySchedule", cfg.summarySchedule, "HH:MM local, empty = off") +
          selectField("Summary model", "summaryModel", cfg.summaryModel || "haiku", ["haiku", "sonnet", "opus"]) +
        "</div>" +
      "</div>" +
      '<div style="margin-top:16px;display:flex;gap:10px;align-items:center"><button class="btn primary" id="setSave">' + I.check + 'Save settings</button><span id="setSaved" class="mono" style="color:var(--ok);font-size:12px"></span></div>';
    var cfgKeys = { ntfy: 1, summaryAuthor: 1, summaryRepos: 1, summaryCwd: 1, summarySchedule: 1, summaryModel: 1, hooksGate: 1, autoReview: 1, autoVerify: 1, autoCompact: 1, maxReflectIterations: 1, reviewPasses: 1, allowWrite: 1, slackWebhook: 1, discordWebhook: 1, editor: 1, linearToken: 1, jiraBase: 1, jiraEmail: 1, jiraToken: 1 };
    $("setSave").addEventListener("click", async function () {
      var out = {};
      Object.keys(cfgKeys).forEach(function (k) {
        var elm = $("set_" + k); if (!elm) { out[k] = cfg[k]; return; }
        if (elm.type === "checkbox") out[k] = elm.checked;
        else if (elm.type === "number") out[k] = parseInt(elm.value, 10) || 0;
        else out[k] = elm.value;
      });
      try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) }); $("setSaved").textContent = "saved ✓"; setTimeout(function () { $("setSaved").textContent = ""; }, 2500); toast("Settings saved", "ok"); }
      catch (e) { toast("Save failed", "err"); }
    });
    $("setNotifTest") && $("setNotifTest").addEventListener("click", async function () {
      try { var r = await fetch("/api/webhook/test", { method: "POST" }); var d = await r.json().catch(function () { return {}; }); if (d.data) d = d.data; if (!r.ok) { toast((d && ((d.error && (d.error.message || d.error)) || d.message)) || "Configure a Slack or Discord webhook first", "err"); return; } toast("Test sent — check Slack/Discord", "ok"); }
      catch (e) { toast("Test failed", "err"); }
    });
    $("setHookInstall") && $("setHookInstall").addEventListener("click", async function () { try { await fetch("/api/hooks/install", { method: "POST" }); toast("Hooks installed", "ok"); loadSettings(); } catch (e) { toast("Install failed", "err"); } });
    $("setHookUninstall") && $("setHookUninstall").addEventListener("click", async function () { if (!confirm("Uninstall rook hooks from ~/.claude/settings.json?")) return; try { await fetch("/api/hooks/uninstall", { method: "POST" }); toast("Hooks uninstalled", ""); loadSettings(); } catch (e) { toast("Uninstall failed", "err"); } });
  }

  // ---- actions -------------------------------------------------------------
  async function respond(id, action, value) {
    try {
      var r = await fetch("/api/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, action: action, value: value }) });
      var j = await r.json().catch(function () { return {}; }); if (j && j.data) j = j.data;
      return { ok: r.ok, landed: !!(j && j.landed) };
    } catch (e) { toast("Action failed", "err"); return { ok: false, landed: false }; }
  }
  async function killAgent(s) {
    try { await fetch("/api/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: s.sessionId, target: s.tmuxPane }) }); toast("Agent stopped", ""); }
    catch (e) { toast("Stop failed", "err"); }
  }
  async function createPR(s) {
    // zero-friction: title + body auto-filled from the branch's commits (gh --fill)
    if (!confirm("Open a pull request from this agent's branch?\nTitle and description are filled in automatically from the commits.")) return;
    toast("Creating PR…", "");
    try {
      var r = await fetch("/api/pr/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: s.cwd }) });
      var d = await r.json(); if (d.data) d = d.data;
      if (!r.ok) { toast((d && ((d.error && (d.error.message || d.error)) || d.message)) || "PR failed — enable Allow write actions in Settings", "err"); return; }
      toast("PR created", "ok"); if (d.url) window.open(d.url, "_blank");
    } catch (e) { toast("PR failed", "err"); }
  }

  // ---- modal + launch/chain -----------------------------------------------
  function modal(title, bodyHTML, onMount) {
    var ov = el("div", "op-modal-ov");
    ov.innerHTML = '<div class="op-modal"><div class="op-modal-head"><b>' + esc(title) + '</b><button class="op-modal-x">' + I.x + '</button></div><div class="op-modal-body">' + bodyHTML + "</div></div>";
    document.body.appendChild(ov);
    var close = function () { ov.remove(); };
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.querySelector(".op-modal-x").addEventListener("click", close);
    onMount && onMount(ov, close);
    return ov;
  }
  function newAgent(prefill) {
    prefill = prefill || {};
    modal(prefill.title || "Launch agent",
      '<label class="set-field"><span class="set-k">Task name</span><input class="set-in" id="sp_name" placeholder="fix-auth-bug" value="' + esc(prefill.name || "") + '" /></label>' +
      '<label class="set-field"><span class="set-k">Working directory' + (prefill.cwd ? ' <span class="set-hint" style="color:var(--ok)">auto-detected</span>' : "") + '</span>' + repoField("sp_cwd", "search your repos by name…", prefill.cwd || "") + "</label>" +
      '<label class="set-field"><span class="set-k">Agent</span><select class="set-in" id="sp_agent"><option value="claude">claude</option><option value="codex">codex (beta)</option><option value="aider">aider (beta)</option><option value="gemini">gemini (beta)</option></select></label>' +
      '<label class="set-field" id="sp_model_wrap"><span class="set-k">Model</span><select class="set-in" id="sp_model"><option value="default">Default (account)</option><option value="haiku">Haiku — cheapest</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label>' +
      '<label class="set-field"><span class="set-k">Initial prompt (optional)</span><textarea class="set-in" id="sp_prompt" rows="' + (prefill.prompt ? 6 : 4) + '" placeholder="what should the agent do?">' + esc(prefill.prompt || "") + '</textarea></label>' +
      '<label class="set-toggle"><input type="checkbox" id="sp_wt" ' + (prefill.worktree ? "checked" : "") + ' /><span><b>Isolate in a git worktree</b><span class="set-hint">don\'t touch your working checkout</span></span></label>' +
      '<div id="sp_docs_wrap" style="display:none"><label class="set-toggle"><input type="checkbox" id="sp_docs" checked /><span><b>Follow this repo\'s agent instructions</b><span class="set-hint" id="sp_docs_list"></span></span></label></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn primary" id="sp_go">' + I.plus + "Launch</button></div>",
      function (ov, close) {
        if (prefill.cwd) $("sp_prompt").focus(); else $("sp_cwd").focus();
        // model routing is Claude-only; hide it for other agents (server rejects it too)
        function syncAgent() {
          var claude = $("sp_agent").value === "claude";
          if ($("sp_model_wrap")) $("sp_model_wrap").style.display = claude ? "" : "none";
          if (!claude) $("sp_model").value = "default";
        }
        $("sp_agent").addEventListener("change", syncAgent);
        syncAgent();
        // detect a repo's AGENTS.md/CLAUDE.md etc. so the agent can be told to follow them
        var docFiles = [];
        function loadDocs() {
          var cwd = $("sp_cwd").value.trim(), wrap = $("sp_docs_wrap");
          if (!wrap) return;
          if (cwd.length < 3) { wrap.style.display = "none"; docFiles = []; return; }
          fetch("/api/agentdocs?path=" + encodeURIComponent(cwd), { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
              if (j && j.data) j = j.data;
              docFiles = (j && j.files) || [];
              if (!docFiles.length) { wrap.style.display = "none"; return; }
              wrap.style.display = "";
              $("sp_docs_list").textContent = docFiles.map(function (f) { return f.rel; }).join(" · ");
            })
            .catch(function () { wrap.style.display = "none"; docFiles = []; });
        }
        $("sp_cwd").addEventListener("input", loadDocs);
        $("sp_cwd").addEventListener("change", loadDocs);
        wireRepoPicker("sp_cwd", loadDocs);
        if (prefill.cwd) loadDocs();
        $("sp_go").addEventListener("click", async function () {
          var cwd = $("sp_cwd").value;
          if (!cwd) { toast("Working directory required", "err"); return; }
          // auto-name if blank: derive from the repo folder so the user needn't type one
          var name = $("sp_name").value.trim();
          if (!name) name = (cwd.replace(/\/+$/, "").split("/").pop() || "agent") + "-" + Date.now().toString(36).slice(-4);
          name = name.replace(/[^A-Za-z0-9._-]+/g, "-");
          var prompt = $("sp_prompt").value;
          // opt-in: tell the agent to read + follow the repo's instruction files
          if (docFiles.length && $("sp_docs") && $("sp_docs").checked) {
            var pre = "Before doing anything else, read these repo instruction files and follow them for the rest of this session: " + docFiles.map(function (f) { return f.rel; }).join(", ") + ".";
            prompt = prompt.trim() ? pre + "\n\n" + prompt : pre;
          }
          var body = { name: name, cwd: cwd, agent: $("sp_agent").value, model: $("sp_model").value, prompt: prompt, worktree: $("sp_wt").checked };
          try {
            var r = await fetch("/api/spawn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            var d = await r.json(); if (d.data) d = d.data;
            if (!r.ok) { toast(d.error || d.message || "Launch failed", "err"); return; }
            toast("Agent launched — opening its session…", "ok");
            close();
            // jump to the new agent's session (selected once it appears in state)
            pendingSpawn = { cwd: body.cwd, worktree: d.worktree || "", since: now() };
            setView("operator");
            setTimeout(poll, 400);
          } catch (e) { toast("Launch failed", "err"); }
        });
      });
  }
  function createChain() {
    modal("New task chain",
      '<label class="set-field"><span class="set-k">Chain title</span><input class="set-in" id="ch_title" placeholder="ship feature X" /></label>' +
      '<label class="set-field"><span class="set-k">Working directory</span>' + repoField("ch_cwd", "search your repos by name…", "") + "</label>" +
      '<label class="set-field"><span class="set-k">Steps (one per line — each becomes a sequential agent)</span><textarea class="set-in" id="ch_steps" rows="5" placeholder="write failing tests\nimplement\nrun lint + fix"></textarea></label>' +
      '<label class="set-toggle"><input type="checkbox" id="ch_wt" checked /><span><b>Isolate in a git worktree</b></span></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn primary" id="ch_go">' + I.plus + "Create chain</button></div>",
      function (ov, close) {
        wireRepoPicker("ch_cwd");
        $("ch_go").addEventListener("click", async function () {
          var cwd = $("ch_cwd").value, steps = $("ch_steps").value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean).map(function (l, i) { return { name: "step" + (i + 1), prompt: l }; });
          if (!cwd || !steps.length) { toast("cwd and at least one step required", "err"); return; }
          try { var r = await fetch("/api/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: $("ch_title").value, cwd: cwd, worktree: $("ch_wt").checked, steps: steps }) }); if (!r.ok) throw 0; toast("Chain created", "ok"); close(); renderBoard(); }
          catch (e) { toast("Chain create failed", "err"); }
        });
      });
  }
  // Build a task GRAPH (DAG) — nodes with conditional edges + approval gates.
  // The structured builder lives in newGraph().
  function newGraph() {
    // structured node builder — real fields per node instead of pipe syntax
    var gnodes = [
      { name: "plan", type: "agent", verify: false, prompt: "draft a plan", deps: [] },
      { name: "approve", type: "approval", verify: false, prompt: "", deps: [{ node: "plan", on: "pass" }] },
      { name: "build", type: "agent", verify: false, prompt: "implement the plan", deps: [{ node: "approve", on: "pass" }] },
    ];
    var ON = ["pass", "fail", "done"];
    function opts(list, sel) { return list.map(function (o) { return '<option' + (o === sel ? " selected" : "") + ">" + esc(o) + "</option>"; }).join(""); }
    function nodeHTML(n, i) {
      var others = gnodes.filter(function (x, j) { return j !== i && x.name; });
      var chips = n.deps.map(function (d, di) {
        return '<span class="gb-dep"><b>' + esc(d.node) + '</b><select class="gb-depon" data-i="' + i + '" data-di="' + di + '">' + opts(ON, d.on) + '</select>' +
          '<button class="gb-depx" data-i="' + i + '" data-di="' + di + '" title="remove">×</button></span>';
      }).join("");
      var addDep = others.length ? '<select class="gb-addep" data-i="' + i + '"><option value="">+ depends on…</option>' +
        others.map(function (o) { return '<option value="' + esc(o.name) + '">' + esc(o.name) + "</option>"; }).join("") + "</select>" : "";
      return '<div class="gb-node">' +
        '<div class="gb-node-top">' +
          '<input class="gb-name" data-i="' + i + '" placeholder="node name" value="' + esc(n.name) + '" />' +
          '<select class="gb-type" data-i="' + i + '"><option value="agent"' + (n.type === "agent" ? " selected" : "") + '>agent</option><option value="approval"' + (n.type === "approval" ? " selected" : "") + '>approval — you approve</option></select>' +
          (n.type === "agent" ? '<label class="gb-verify" title="gate the next step on build/tests passing"><input type="checkbox" class="gb-vchk" data-i="' + i + '"' + (n.verify ? " checked" : "") + "/> verify</label>" : "") +
          (gnodes.length > 1 ? '<button class="gb-rm" data-i="' + i + '" title="remove node">' + I.x + "</button>" : "") +
        "</div>" +
        (n.type === "agent" ? '<textarea class="gb-prompt" data-i="' + i + '" rows="2" placeholder="what should this agent do?">' + esc(n.prompt) + "</textarea>" : "") +
        '<div class="gb-deps">' + (chips || addDep ? '<span class="gb-deps-lbl">runs after</span>' : "") + chips + addDep + "</div>" +
      "</div>";
    }
    function renderNodes() {
      var c = $("gb_nodes"); if (!c) return;
      c.innerHTML = gnodes.map(nodeHTML).join("") + '<button class="btn sm gb-add" id="gb_add">' + I.plus + "Add node</button>";
      wireNodes();
    }
    function wireNodes() {
      var c = $("gb_nodes"); if (!c) return;
      c.querySelectorAll(".gb-name").forEach(function (el) { el.addEventListener("input", function () { gnodes[+el.dataset.i].name = el.value; }); });
      c.querySelectorAll(".gb-prompt").forEach(function (el) { el.addEventListener("input", function () { gnodes[+el.dataset.i].prompt = el.value; }); });
      c.querySelectorAll(".gb-vchk").forEach(function (el) { el.addEventListener("change", function () { gnodes[+el.dataset.i].verify = el.checked; }); });
      c.querySelectorAll(".gb-type").forEach(function (el) { el.addEventListener("change", function () { gnodes[+el.dataset.i].type = el.value; renderNodes(); }); });
      c.querySelectorAll(".gb-depon").forEach(function (el) { el.addEventListener("change", function () { gnodes[+el.dataset.i].deps[+el.dataset.di].on = el.value; }); });
      c.querySelectorAll(".gb-depx").forEach(function (el) { el.addEventListener("click", function () { gnodes[+el.dataset.i].deps.splice(+el.dataset.di, 1); renderNodes(); }); });
      c.querySelectorAll(".gb-addep").forEach(function (el) { el.addEventListener("change", function () { if (el.value) { gnodes[+el.dataset.i].deps.push({ node: el.value, on: "pass" }); renderNodes(); } }); });
      c.querySelectorAll(".gb-rm").forEach(function (el) { el.addEventListener("click", function () { gnodes.splice(+el.dataset.i, 1); renderNodes(); }); });
      var add = $("gb_add"); if (add) add.addEventListener("click", function () { gnodes.push({ name: "", type: "agent", verify: false, prompt: "", deps: [] }); renderNodes(); });
    }
    modal("New task graph",
      '<label class="set-field"><span class="set-k">Graph title</span><input class="set-in" id="gr_title" placeholder="ship feature X safely" /></label>' +
      '<label class="set-field"><span class="set-k">Working directory</span>' + repoField("gr_cwd", "search your repos by name…", "") + "</label>" +
      '<div class="set-field"><span class="set-k">Nodes</span><div class="gb-nodes" id="gb_nodes"></div></div>' +
      '<div class="set-hint" style="margin:2px 0 8px"><b>agent</b> runs an AI task · <b>approval</b> waits for you · <b>verify</b> gates on build/tests · <b>runs after</b> sets dependencies with a pass/fail/done condition.</div>' +
      '<label class="set-toggle"><input type="checkbox" id="gr_wt" checked /><span><b>Isolate in a git worktree</b><span class="set-hint">agents change files only in the worktree, never your checkout</span></span></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn primary" id="gr_go">' + I.plus + "Create graph</button></div>",
      function (ov, close) {
        wireRepoPicker("gr_cwd");
        renderNodes();
        setTimeout(function () { $("gr_cwd").focus(); }, 30);
        $("gr_go").addEventListener("click", async function () {
          var cwd = $("gr_cwd").value.trim();
          var nodes = gnodes.filter(function (n) { return n.name.trim(); }).map(function (n) {
            return { id: n.name.trim(), name: n.name.trim(), type: n.type, verify: !!n.verify, prompt: (n.prompt || "").trim(), dependsOn: n.deps.map(function (d) { return { node: d.node, on: d.on }; }) };
          });
          if (!cwd || !nodes.length) { toast("Working directory and at least one node required", "err"); return; }
          try {
            var r = await fetch("/api/graph", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: $("gr_title").value, cwd: cwd, worktree: $("gr_wt").checked, nodes: nodes }) });
            var d = await r.json(); if (d && d.data) d = d.data;
            if (!r.ok) { toast((d && (d.error && (d.error.message || d.error) || d.message)) || "Create failed", "err"); return; }
            toast("Task graph started", "ok"); close(); setView("graph");
          } catch (e) { toast("Graph create failed", "err"); }
        });
      });
  }
  // launch an agent straight from a Linear/Jira/GitHub ticket — rook fetches the
  // ticket and builds the task prompt, so you paste an id, not write a brief.
  function newFromTicket() {
    modal("New agent from a ticket",
      '<label class="set-field"><span class="set-k">Source</span><select class="set-in" id="tk_src"><option value="github">GitHub issue</option><option value="linear">Linear</option><option value="jira">Jira</option></select></label>' +
      '<label class="set-field"><span class="set-k">Ticket</span><input class="set-in" id="tk_id" placeholder="owner/repo#123  ·  LIN-456  ·  PROJ-789" /></label>' +
      '<div class="set-hint">rook pulls the title + description and turns it into the agent\'s task.</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn primary" id="tk_go">' + I.plus + "Fetch &amp; launch</button></div>",
      function (ov, close) {
        $("tk_id").focus();
        $("tk_go").addEventListener("click", async function () {
          var src = $("tk_src").value, id = $("tk_id").value.trim();
          if (!id) { toast("Enter a ticket id", "err"); return; }
          toast("Fetching " + src + " " + id + "…", "");
          try {
            var r = await fetch("/api/tracker/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: src, id: id }) });
            var d = await r.json(); if (d.data) d = d.data;
            if (!r.ok) { toast((d && ((d.error && (d.error.message || d.error)) || d.message)) || "Couldn't fetch ticket", "err"); return; }
            close();
            var cwd = ""; var m = id.match(/^([\w.-]+\/[\w.-]+)#\d+/); if (m) cwd = resolveRepoPath(m[1]);
            newAgent({ title: "Launch from " + id, name: d.name, prompt: d.prompt, worktree: true, cwd: cwd });
          } catch (e) { toast("Couldn't fetch ticket", "err"); }
        });
      });
  }

  // Coerce anything handed to toast() into a readable string. Callers sometimes
  // pass a raw API error — GoFr's shape is {error:{message}} or {message} — which
  // would otherwise render as the useless "[object Object]".
  function msgText(m) {
    if (m == null) return "";
    if (typeof m === "string") return m;
    if (typeof m === "object") return m.message || (m.error && (m.error.message || m.error)) || JSON.stringify(m);
    return String(m);
  }
  function toast(msg, kind) {
    var host = $("opToasts"); if (!host) return;
    var t = el("div", "op-toast " + (kind || ""), (kind === "ok" ? I.review : kind === "err" ? I.alert : "") + "<span>" + esc(msgText(msg)) + "</span>");
    host.appendChild(t); setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 200); }, 2600);
  }

  // ---- command palette -----------------------------------------------------
  var paletteOpen = false, palQuery = "", palItems = [], palIdx = 0, palResumeOnly = false;
  function openPalette(resumeOnly) {
    paletteOpen = true; palResumeOnly = !!resumeOnly;
    $("opPalette").hidden = false; palQuery = ""; palIdx = 0;
    var i = $("palInput"); i.value = "";
    i.placeholder = resumeOnly ? "Search closed sessions to reopen…" : "Type to search agents or run a command…";
    i.focus(); fetchHistory(); renderPaletteList();
  }
  function closePalette() { paletteOpen = false; $("opPalette").hidden = true; }
  function paletteCommands() {
    return [
      { g: "Action", title: "Launch agent…", sub: "start a new agent", run: newAgent },
      { g: "Action", title: "New agent from a ticket…", sub: "Linear / Jira / GitHub issue", run: newFromTicket },
      { g: "Action", title: "New task chain…", sub: "sequential agents", run: createChain },
      { g: "Action", title: "New task graph…", sub: "DAG · conditional edges · approval gates", run: newGraph },
      { g: "Go", title: "Task graphs", sub: "DAG orchestration", key: "G T", run: function () { setView("graph"); } },
      { g: "Go", title: "Operator", sub: "workspace console", key: "G O", run: function () { setView("operator"); } },
      { g: "Go", title: "Insights", sub: "usage · cost · trends", key: "G I", run: function () { setView("insights"); } },
      { g: "Go", title: "Board", sub: "kanban by state", key: "G B", run: function () { setView("board"); } },
      { g: "Go", title: "GitHub", sub: "repos · issues · PRs", run: function () { setView("github"); } },
      { g: "Go", title: "Summaries", sub: "saved work summaries", run: function () { setView("summaries"); } },
      { g: "Go", title: "Dev servers", sub: "running dev servers", run: function () { setView("dev"); } },
      { g: "Go", title: "Audit", sub: "command trail", run: function () { setView("audit"); } },
      { g: "Go", title: "Workspace", sub: "worktrees · hooks", run: function () { setView("workspace"); } },
      { g: "Go", title: "Settings", sub: "config · hooks · integrations", run: function () { setView("settings"); } }
    ];
  }
  // fuzzyScore does a subsequence match of q against text, rewarding consecutive
  // hits and word-boundary starts. Returns {score, hit:[indices]} or null (no match).
  function fuzzyScore(q, text) {
    if (!q) return { score: 0, hit: [] };
    var t = text.toLowerCase(), ti = 0, score = 0, streak = 0, hit = [];
    for (var qi = 0; qi < q.length; qi++) {
      var found = -1;
      for (var k = ti; k < t.length; k++) { if (t[k] === q[qi]) { found = k; break; } }
      if (found === -1) return null;
      hit.push(found);
      if (found === ti && qi > 0) { streak++; score += 2 + streak; } else { streak = 0; score += 1; }
      if (found === 0 || /[\s\W_]/.test(t[found - 1])) score += 3; // word-boundary bonus
      ti = found + 1;
    }
    return { score: score, hit: hit };
  }
  // markHits wraps matched characters of text in <mark> (text is already trusted-escaped per char).
  function markHits(text, hit) {
    if (!hit || !hit.length) return esc(text);
    var out = "", last = 0;
    hit.forEach(function (idx) { out += esc(text.slice(last, idx)) + "<mark>" + esc(text[idx]) + "</mark>"; last = idx + 1; });
    return out + esc(text.slice(last));
  }

  function renderPaletteList() {
    var q = palQuery.toLowerCase();
    var agents = sessions().map(function (s) { return { g: "Agents", title: s.title || s.project || "session", sub: esc(s.project || "") + " · " + statusOf(s), st: statusOf(s), run: function () { setView("operator"); selectAgent(s.sessionId); }, _s: ((s.title || "") + " " + (s.project || "")).toLowerCase() }; });
    var cmds = paletteCommands().map(function (c) { c._s = (c.title + " " + c.sub).toLowerCase(); return c; });
    var aliveIds = {}; sessions().forEach(function (s) { aliveIds[s.sessionId] = true; });
    var resumes = closedSessions.filter(function (s) { return !aliveIds[s.sessionId]; }).slice(0, 20).map(function (s) {
      var when = s.updatedAt ? ago(s.updatedAt, now()) + " ago" : "";
      return { g: "Resume closed session", title: s.title || s.project || "session", sub: (s.project || "") + (when ? " · " + when : ""), run: function () { resumeSession(s.sessionId, s.title || s.project); }, _s: ((s.title || "") + " " + (s.project || "") + " " + (s.cwd || "") + " resume reopen closed session").toLowerCase() };
    });
    var all, grouped = true;
    if (palResumeOnly && !q) {
      all = resumes; // opened via the Resume button — show only closed sessions
    } else if (q) {
      // fuzzy-rank across everything; flat (ranked) order, so no group headers
      grouped = false;
      all = cmds.concat(agents).concat(resumes).map(function (it) {
        var m = fuzzyScore(q, it._s); if (!m) return null;
        var tm = fuzzyScore(q, (it.title || "").toLowerCase());
        it._thit = tm ? tm.hit : [];
        return { it: it, score: m.score };
      }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).map(function (x) { return x.it; });
    } else {
      all = cmds.concat(agents).concat(resumes);
    }
    palItems = all; if (palIdx >= all.length) palIdx = Math.max(0, all.length - 1);
    var list = $("palList"), html = "", lastG = null;
    all.forEach(function (it, i) {
      if (grouped && it.g !== lastG) { html += '<div class="pal-group">' + esc(it.g) + "</div>"; lastG = it.g; }
      var title = q ? markHits(it.title || "", it._thit) : esc(it.title || "");
      html += '<div class="pal-item ' + (i === palIdx ? "act" : "") + '" data-i="' + i + '">' +
        (it.st ? '<i class="dot ' + it.st + ' pi-dot"></i>' : (it.g === "Go" ? I.grid : it.g === "Resume closed session" ? I.resume : I.send)) +
        '<span class="pi-main"><span class="pi-title">' + title + '</span>' + (it.sub ? '<span class="pi-sub">' + esc(it.sub) + "</span>" : "") + "</span>" +
        (it.key ? '<span class="pi-key">' + esc(it.key) + "</span>" : "") + "</div>";
    });
    var emptyMsg = palResumeOnly ? (closedSessions.length ? "No closed sessions match" : "No closed sessions to reopen yet") : "No matches";
    list.innerHTML = html || '<div class="op-empty" style="padding:30px">' + emptyMsg + "</div>";
    list.querySelectorAll(".pal-item").forEach(function (n) { n.addEventListener("click", function () { runPalette(parseInt(n.dataset.i, 10)); }); });
    var act = list.querySelector(".pal-item.act"); if (act) act.scrollIntoView({ block: "nearest" });
  }
  function runPalette(i) { var it = palItems[i]; if (!it) return; closePalette(); it.run(); }

  // ---- keyboard ------------------------------------------------------------
  var gPending = false;
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); paletteOpen ? closePalette() : openPalette(); return; }
    if (paletteOpen) {
      if (e.key === "Escape") { closePalette(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); renderPaletteList(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); renderPaletteList(); }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(palIdx); }
      return;
    }
    var typing = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
    if (typing) return;
    if (e.key === "?") { e.preventDefault(); showShortcuts(); return; }
    if (e.key === "/") { e.preventDefault(); var s = $("opRosterSearch"); s && s.focus(); return; }
    if (e.key === "g" || e.key === "G") { gPending = true; setTimeout(function () { gPending = false; }, 600); return; }
    if (gPending) { gPending = false; var g = GO_KEYS[e.key]; if (g) setView(g); return; }
    if (activeView === "operator" && (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault(); moveSelection(e.key === "j" || e.key === "ArrowDown" ? 1 : -1); return;
    }
    if (e.key >= "1" && e.key <= "5" && activeView === "operator" && ws.id) { switchTab(TABS[parseInt(e.key, 10) - 1][0]); }
  });
  function moveSelection(dir) {
    var rows = [].slice.call(document.querySelectorAll(".op-agent")).map(function (b) { return b.dataset.id; });
    var i = rows.indexOf(selectedId); i = Math.max(0, Math.min(rows.length - 1, i + dir));
    if (rows[i]) { selectAgent(rows[i]); var b = document.querySelector('.op-agent[data-id="' + rows[i] + '"]'); b && b.scrollIntoView({ block: "nearest" }); }
  }
  // g-prefix jump targets (g o, g i, …) — one per view.
  var GO_KEYS = { o: "operator", i: "insights", b: "board", t: "graph", h: "github", s: "summaries", d: "dev", a: "audit", w: "workspace", ",": "settings" };
  var VIEW_LABELS = { operator: "Operator", insights: "Insights", board: "Board", graph: "Task graphs", github: "GitHub", summaries: "Summaries", dev: "Dev servers", audit: "Audit", workspace: "Workspace", settings: "Settings" };
  function showShortcuts() {
    // g-nav rows are generated from the keymap so the help can't drift from it
    var goRows = Object.keys(GO_KEYS).map(function (k) { return ["g " + k, "go to " + (VIEW_LABELS[GO_KEYS[k]] || GO_KEYS[k])]; });
    var rows = [
      ["⌘K", "command palette — search agents, jump, run a command"],
      ["?", "this shortcuts help"],
      ["/", "focus the agent filter"],
      ["j / k", "move down / up the roster"],
      ["↑ / ↓", "move down / up the roster"],
      ["1 – 5", "switch workspace tabs (Overview…Files)"]
    ].concat(goRows).concat([["esc", "close this / the palette"]]);
    modal("Keyboard shortcuts",
      '<div class="kbd-grid">' + rows.map(function (r) {
        return '<div class="kbd-row"><kbd>' + esc(r[0]) + "</kbd><span>" + esc(r[1]) + "</span></div>";
      }).join("") + "</div>");
  }

  // ---- boot ----------------------------------------------------------------
  // ---- theme (dark default, persisted; terminal stays dark by design) ------
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function currentTheme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("opTheme", t); } catch (e) {}
    var ic = $("opThemeIcon"); if (ic) ic.innerHTML = t === "light" ? MOON : SUN; // show the mode you'd switch TO
    var btn = $("opTheme"); if (btn) btn.setAttribute("data-tip", t === "light" ? "Switch to dark" : "Switch to light");
  }
  function boot() {
    document.querySelectorAll(".op-rail-btn[data-view]").forEach(function (b) { b.addEventListener("click", function () { setView(b.dataset.view); }); });
    applyTheme(currentTheme());
    $("opTheme") && $("opTheme").addEventListener("click", function () { applyTheme(currentTheme() === "light" ? "dark" : "light"); });
    $("opCmd") && $("opCmd").addEventListener("click", openPalette);
    $("palInput") && $("palInput").addEventListener("input", function (e) { palQuery = e.target.value; if (palQuery) palResumeOnly = false; palIdx = 0; renderPaletteList(); });
    $("opPalette") && $("opPalette").addEventListener("click", function (e) { if (e.target === $("opPalette")) closePalette(); });
    fetchRepos();
    setView(activeView);
    poll(); setInterval(poll, POLL_MS);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
