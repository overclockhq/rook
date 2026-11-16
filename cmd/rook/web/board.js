// board.js — the pull-request board.
//
// Two lanes, because they are two different jobs: pull requests you raised (is
// anything blocking them?) and pull requests waiting on your review (what is
// blocked on you?). Cards surface the things that decide whether you can act —
// CI, merge conflicts, unresolved threads, review size, how long it has waited —
// so you rarely have to open the PR to know what to do next.
//
// Exposes window.renderPRBoard(mountEl, ctx). Server does the bucketing
// (/api/prboard); this file only renders and wires actions.
(function () {
  "use strict";

  var LANES = [
    {
      key: "mine",
      label: "My pull requests",
      hint: "what is blocking my work from landing",
      cols: [
        { key: "waiting", label: "Waiting on review", tone: "busy" },
        { key: "changes", label: "Changes requested", tone: "danger" },
        { key: "approved", label: "Approved", tone: "ok" },
        { key: "draft", label: "Draft", tone: "idle" },
        { key: "merged", label: "Landed · 7d", tone: "idle" },
      ],
    },
    {
      key: "review",
      label: "Awaiting my review",
      hint: "what is blocked on me",
      cols: [
        { key: "requested", label: "Review requested", tone: "waiting" },
        { key: "commented", label: "I'm involved", tone: "idle" },
        { key: "approved_by_me", label: "I approved", tone: "ok" },
      ],
    },
  ];

  var state = {
    prs: [],
    login: "",
    org: "",
    repos: [],       // pinned "owner/name"
    orgs: [],
    repoOptions: [], // repos in the selected org, for the picker
    loading: false,
    error: "",
    fetchedAt: 0,
    repoQuery: "",
    pickerOpen: false,
    reposLoading: false,
    reposError: "",
    expanded: {},   // colKey -> true once you ask to see the whole column
  };

  // Rows shown per state group before the tail collapses, so one busy group
  // cannot push the other lane off the screen.
  var GROUP_LIMIT = 8;
  var mount = null, ctx = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function unwrap(d) { return d && d.data !== undefined ? d.data : d; }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ cache: "no-store" }, opts || {}));
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var d = unwrap(body) || {};
      throw new Error((d.error && (d.error.message || d.error)) || d.message || "request failed");
    }
    return unwrap(body);
  }

  // ---- formatting ---------------------------------------------------------
  function ago(iso) {
    if (!iso) return "";
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d";
    return Math.floor(d / 30) + "mo";
  }
  // staleDays drives the "this has been sitting too long" cue — the single most
  // useful signal on a review queue.
  function days(iso) {
    if (!iso) return 0;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }
  function num(n) {
    n = +n || 0;
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(n);
  }
  // A reviewer's first question is "how big is this?" — bucketing the churn into
  // a size class answers it faster than two raw numbers do.
  function sizeClass(pr) {
    var n = (+pr.additions || 0) + (+pr.deletions || 0);
    if (n < 30) return { k: "XS", n: n };
    if (n < 150) return { k: "S", n: n };
    if (n < 600) return { k: "M", n: n };
    if (n < 2000) return { k: "L", n: n };
    return { k: "XL", n: n };
  }

  // ---- rows ---------------------------------------------------------------
  // Every row is one line on a shared column grid, so the eye can run straight
  // down repo, size, blockers and age without re-finding them per item. Cards
  // of ragged height cannot do that, which is what made the first pass read as
  // a jumble.
  function sizeOf(pr) {
    var n = (+pr.additions || 0) + (+pr.deletions || 0);
    return n < 30 ? "XS" : n < 150 ? "S" : n < 600 ? "M" : n < 2000 ? "L" : "XL";
  }

  // One blocker per row, worst first. A row of five chips is noise; the single
  // reason this PR cannot move is signal.
  function blockerOf(pr) {
    if (pr.mergeable === "CONFLICTING") return { t: "conflicts", k: "bad" };
    if (pr.checks === "FAILURE" || pr.checks === "ERROR") return { t: "checks failed", k: "bad" };
    if (pr.unresolved > 0) return { t: pr.unresolved + " unresolved", k: "warn" };
    if (pr.checks === "PENDING") return { t: "checks running", k: "mute" };
    if (pr.isDraft) return { t: "draft", k: "mute" };
    return null;
  }

  // Who the row is waiting on. On your own PRs that is the reviewers and their
  // verdict; on someone else's it is simply the author.
  function peopleOf(pr) {
    if (!pr.mine) return { t: "@" + (pr.author || "?"), k: "" };
    if (pr.changesRequested) return { t: pr.changesRequested + " blocking", k: "bad" };
    if (pr.approvals) return { t: pr.approvals + " approved", k: "ok" };
    var r = pr.reviewers || [];
    if (r.length === 1) return { t: "@" + r[0], k: "" };
    if (r.length > 1) return { t: r.length + " reviewers", k: "" };
    return { t: "no reviewers", k: "mute" };
  }

  function row(pr) {
    var b = blockerOf(pr), who = peopleOf(pr), sz = sizeOf(pr);
    return '<div class="pr-row' + (pr.unread ? " unread" : "") + '" role="row"' +
      ' data-url="' + esc(pr.url) + '" data-repo="' + esc(pr.repo) + '" data-num="' + pr.number +
      '" data-head="' + esc(pr.headRef || "") + '" data-title="' + esc(pr.title) + '">' +
      '<span class="pr-dot s-' + esc(pr.col) + '" title="' + esc(colLabel(pr.col)) + '"></span>' +
      '<span class="pr-num">#' + pr.number + "</span>" +
      '<span class="pr-title" title="' + esc(pr.title) + '">' + esc(pr.title) + "</span>" +
      '<span class="pr-repo" title="' + esc(pr.repo) + " → " + esc(pr.baseRef || "") + '">' + esc(pr.repo) + "</span>" +
      '<span class="pr-size" title="' + num(pr.additions) + " added · " + num(pr.deletions) +
        " removed · " + (pr.changedFiles || 0) + ' files"><b class="sz s-' + sz + '">' + sz +
        '</b><i class="add">+' + num(pr.additions) + '</i><i class="del">−' + num(pr.deletions) + "</i></span>" +
      '<span class="pr-block">' + (b ? '<em class="bk ' + b.k + '">' + esc(b.t) + "</em>" : "") + "</span>" +
      '<span class="pr-who ' + who.k + '" title="' + esc(who.t) + '">' + esc(who.t) + "</span>" +
      '<span class="pr-age" title="updated ' + ago(pr.updatedAt) + ' ago">' + ago(pr.updatedAt) + "</span>" +
      '<span class="pr-acts">' +
        '<button class="pr-a" data-act="open">Open</button>' +
        (pr.state === "OPEN" ? '<button class="pr-a" data-act="review">Review</button>' : "") +
        (pr.headRef ? '<button class="pr-a" data-act="branch" title="Copy branch: ' + esc(pr.headRef) + '">Branch</button>' : "") +
      "</span></div>";
  }

  function colLabel(k) {
    var all = LANES[0].cols.concat(LANES[1].cols);
    for (var i = 0; i < all.length; i++) if (all[i].key === k) return all[i].label;
    return k;
  }

  function sortFor(colKey, list) {
    // A review queue is oldest-first — that is the thing you are late on. Your
    // own PRs are newest-first, because that is what you are working on.
    var oldestFirst = colKey === "requested" || colKey === "commented";
    return list.slice().sort(function (a, b) {
      var ta = new Date(a.updatedAt || 0).getTime(), tb = new Date(b.updatedAt || 0).getTime();
      return oldestFirst ? ta - tb : tb - ta;
    });
  }

  function laneHTML(lane) {
    var inLane = state.prs.filter(function (p) { return p.lane === lane.key; });
    if (!inLane.length) {
      return '<section class="pr-lane"><header class="pr-lane-head">' +
        "<h2>" + esc(lane.label) + '</h2><span class="pr-lane-hint">' + esc(lane.hint) + "</span>" +
        '<span class="pr-lane-n">0</span></header>' +
        '<p class="pr-lane-empty">' + esc(lane.key === "mine"
          ? "You have no open pull requests in this scope."
          : "Nothing is waiting on your review.") + "</p></section>";
    }

    // Only sections that actually hold something are drawn. Empty columns held
    // open at equal width were most of the dead space in the previous layout.
    var groups = lane.cols.map(function (c) {
      var list = sortFor(c.key, inLane.filter(function (p) { return p.col === c.key; }));
      if (!list.length) return "";
      var open = !!state.expanded[c.key];
      var shown = open ? list : list.slice(0, GROUP_LIMIT);
      var hidden = list.length - shown.length;
      return '<div class="pr-group">' +
        '<div class="pr-group-head"><span class="pr-dot s-' + c.key + '"></span>' +
          "<span>" + esc(c.label) + '</span><span class="pr-group-n">' + list.length + "</span></div>" +
        shown.map(row).join("") +
        (hidden > 0
          ? '<button class="pr-more" data-more="' + c.key + '">' + hidden + " more</button>"
          : open && list.length > GROUP_LIMIT
            ? '<button class="pr-more" data-more="' + c.key + '">Show less</button>' : "") +
        "</div>";
    }).join("");

    return '<section class="pr-lane">' +
      '<header class="pr-lane-head"><h2>' + esc(lane.label) + "</h2>" +
        '<span class="pr-lane-hint">' + esc(lane.hint) + "</span>" +
        '<span class="pr-lane-n">' + inLane.length + "</span></header>" +
      '<div class="pr-table">' +
        '<div class="pr-row pr-head" role="row"><span></span><span>PR</span><span>Title</span>' +
          "<span>Repository</span><span>Size</span><span>Blocked by</span><span>Waiting on</span>" +
          '<span class="pr-age">Age</span><span></span></div>' +
        groups +
      "</div></section>";
  }

  // ---- scope bar ----------------------------------------------------------
  // A one-line read of what actually needs you, so the board answers its own
  // question before you scan a single column.
  function tally() {
    var needMe = 0, blocked = 0;
    state.prs.forEach(function (p) {
      if (p.lane === "review" && p.col === "requested") needMe++;
      if (p.lane === "mine" && p.state === "OPEN" &&
        (p.col === "changes" || p.checks === "FAILURE" || p.mergeable === "CONFLICTING")) blocked++;
    });
    var bits = [];
    bits.push('<b class="' + (needMe ? "hot" : "") + '">' + needMe + "</b> need your review");
    bits.push('<b class="' + (blocked ? "hot" : "") + '">' + blocked + "</b> of yours blocked");
    return bits.join('<span class="pb-dot">·</span>');
  }

  // The drawer scopes the board. Organisation comes first because it decides
  // which repositories are even listed; one filter box drives both lists so you
  // never have to work out which field you are typing into.
  function pickerHTML() {
    var q = state.repoQuery.toLowerCase();
    var match = function (v) { return !q || v.toLowerCase().indexOf(q) !== -1; };

    var orgRows = [{ v: "", l: "All my repos", sub: "everything you can see" }]
      .concat(state.orgs.map(function (o) { return { v: o, l: o, sub: "" }; }))
      .filter(function (o) { return match(o.l); });

    var orgs = orgRows.length
      ? orgRows.map(function (o) {
          return '<button class="pb-picker-row' + (o.v === state.org ? " on" : "") + '" data-org="' + esc(o.v) + '">' +
            esc(o.l) + (o.sub ? ' <span class="pb-row-sub">' + esc(o.sub) + "</span>" : "") +
            (o.v === state.org ? '<span class="pb-row-tick">✓</span>' : "") + "</button>";
        }).join("")
      : '<p class="pb-picker-empty">No organisation matches.</p>';

    var repoRows = state.repoOptions
      .filter(match)
      .filter(function (r) { return state.repos.indexOf(r) === -1; })
      .slice(0, 60);
    var repos = state.reposLoading
      ? '<p class="pb-picker-empty">Loading repositories…</p>'
      : state.reposError
        ? '<p class="pb-picker-empty">' + esc(state.reposError) + "</p>"
        : state.repoOptions.length === 0
          ? '<p class="pb-picker-empty">No repositories found in ' + esc(state.org || state.login || "your account") + ".</p>"
          : repoRows.length
            ? repoRows.map(function (r) { return '<button class="pb-picker-row" data-pin="' + esc(r) + '">' + esc(r) + "</button>"; }).join("")
            : '<p class="pb-picker-empty">No repository matches.</p>';

    return '<div class="pb-picker">' +
      '<input class="pb-picker-in" id="pbRepoQ" placeholder="Filter organisations and repositories…" value="' +
        esc(state.repoQuery) + '" autocomplete="off" />' +
      '<div class="pb-picker-sec"><span class="pb-picker-h">Organisation</span>' +
        '<div class="pb-picker-list" id="pbOrgList">' + orgs + "</div></div>" +
      '<div class="pb-picker-sec"><span class="pb-picker-h">Pin repositories</span>' +
        '<div class="pb-picker-list" id="pbRepoList">' + repos + "</div></div>" +
      '<div class="pb-picker-foot"><button class="pb-btn" id="pbPickerDone">Done</button></div>' +
      "</div>";
  }

  function scopeHTML() {
    var chips = state.repos.map(function (r) {
      return '<span class="pb-pin" data-repo="' + esc(r) + '">' + esc(r.split("/").pop()) +
        '<button class="pb-unpin" data-repo="' + esc(r) + '" title="Unpin ' + esc(r) + '" aria-label="Unpin ' + esc(r) + '">×</button></span>';
    }).join("");

    var picker = state.pickerOpen ? pickerHTML() : "";

    return '<div class="pb-scope">' +
      '<div class="pb-scope-row">' +
        '<span class="pb-lbl">Scope</span>' +
        '<button class="pb-orgbtn' + (state.pickerOpen ? " on" : "") + '" id="pbAddPin" aria-expanded="' + (state.pickerOpen ? "true" : "false") + '">' +
          esc(state.org || "All my repos") + '<span class="pb-caret">▾</span></button>' +
        '<div class="pb-pins">' + chips + "</div>" +
        '<span class="pb-spacer"></span>' +
        '<span class="pb-tally">' + tally() + "</span>" +
        '<button class="pb-btn" id="pbRefresh"' + (state.loading ? " disabled" : "") + ">" +
          (state.loading ? "Refreshing…" : "Refresh") + "</button>" +
      "</div>" + picker +
      (state.repos.length
        ? '<p class="pb-scope-note">Showing ' + state.repos.length + " pinned " + (state.repos.length === 1 ? "repository" : "repositories") + " · pins override the organisation filter and are saved.</p>"
        : "") +
      "</div>";
  }

  // ---- render -------------------------------------------------------------
  function render() {
    if (!mount) return;
    var body;
    if (state.error) {
      body = '<div class="pb-msg"><b>Could not load pull requests</b><p>' + esc(state.error) + "</p>" +
        "<p class=\"dim\">The board reads GitHub through the <code>gh</code> CLI. Check <code>gh auth status</code>.</p></div>";
    } else if (state.loading && !state.prs.length) {
      body = '<div class="pb-msg">Loading pull requests…</div>';
    } else if (!state.prs.length) {
      body = '<div class="pb-msg"><b>No open pull requests in scope</b>' +
        "<p>Nothing you raised, and nothing waiting on your review" +
        (state.org || state.repos.length ? " in this scope" : "") + ".</p></div>";
    } else {
      body = LANES.map(laneHTML).join("");
    }
    mount.innerHTML = scopeHTML() + '<div class="pb-lanes">' + body + "</div>";
    wire();
  }

  function wire() {
    var add = mount.querySelector("#pbAddPin");
    if (add) add.addEventListener("click", function () {
      state.pickerOpen = !state.pickerOpen;
      render();
      var inp = mount.querySelector("#pbRepoQ");
      if (inp) inp.focus();
      if (state.pickerOpen && !state.repoOptions.length) loadRepoOptions();
    });

    var q = mount.querySelector("#pbRepoQ");
    if (q) {
      q.addEventListener("input", function () {
        state.repoQuery = q.value;
        // repaint only the two lists — re-rendering the whole drawer would
        // drop focus and the caret on every keystroke
        var wrap = mount.querySelector(".pb-picker");
        if (!wrap) return;
        var fresh = document.createElement("div");
        fresh.innerHTML = pickerHTML();
        var oldO = mount.querySelector("#pbOrgList"), newO = fresh.querySelector("#pbOrgList");
        var oldR = mount.querySelector("#pbRepoList"), newR = fresh.querySelector("#pbRepoList");
        if (oldO && newO) oldO.innerHTML = newO.innerHTML;
        if (oldR && newR) oldR.innerHTML = newR.innerHTML;
        wirePicker();
      });
      // the operator shell binds single-letter shortcuts (g o / g b / …) on the
      // document, so keys typed here must not escape the drawer
      q.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Escape") { state.pickerOpen = false; render(); }
      });
    }
    var done = mount.querySelector("#pbPickerDone");
    if (done) done.addEventListener("click", function () { state.pickerOpen = false; render(); });
    wirePicker();

    mount.querySelectorAll(".pb-unpin").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        state.repos = state.repos.filter(function (r) { return r !== b.dataset.repo; });
        persist(); render(); load();
      });
    });

    mount.querySelectorAll(".pr-more").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var k = b.dataset.more;
        state.expanded[k] = !state.expanded[k];
        render();
      });
    });

    var ref = mount.querySelector("#pbRefresh");
    if (ref) ref.addEventListener("click", function () { load(); });

    mount.querySelectorAll(".pr-row:not(.pr-head)").forEach(function (c) {
      c.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) { openURL(c.dataset.url); return; }
        e.stopPropagation();
        var act = btn.dataset.act;
        if (act === "open") openURL(c.dataset.url);
        else if (act === "review") reviewPR(c.dataset);
        else if (act === "branch") copyBranch(c.dataset.head);
      });
    });
  }

  function wirePicker() {
    mount.querySelectorAll(".pb-picker-row[data-pin]").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = b.dataset.pin;
        if (state.repos.indexOf(r) === -1) state.repos.push(r);
        state.repoQuery = "";
        persist(); render(); load();   // drawer stays open so you can pin several
      });
    });
    mount.querySelectorAll(".pb-picker-row[data-org]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.org === state.org) return;
        state.org = b.dataset.org;
        state.repos = [];        // pins belong to the org they came from
        state.repoOptions = [];
        state.repoQuery = "";
        persist(); render(); loadRepoOptions(); load();
      });
    });
  }

  // ---- actions ------------------------------------------------------------
  function openURL(u) { if (u) window.open(u, "_blank", "noopener"); }

  function copyBranch(b) {
    if (!b) return;
    navigator.clipboard.writeText(b).then(function () {
      if (ctx && ctx.toast) ctx.toast("Copied " + b, "ok");
    }, function () {
      if (ctx && ctx.toast) ctx.toast("Could not copy", "err");
    });
  }

  // Reuse the review task the GitHub view already builds, so a PR reviewed from
  // the board is the same session as one reviewed from anywhere else.
  function reviewPR(d) {
    if (!ctx || !ctx.launch) return;
    var num = d.num, repo = d.repo;
    ctx.launch({
      name: "review-pr-" + num,
      title: "Review PR #" + num,
      worktree: true,
      cwd: (ctx.resolveRepo && ctx.resolveRepo(repo)) || "",
      prompt: 'Review GitHub pull request #' + num + ' in ' + repo + ': "' + d.title + '".\n' + d.url + '\n\n' +
        'Check out the PR branch (gh pr checkout ' + num + '), read the diff, and review it for correctness, bugs, security, tests, and style. ' +
        'Also read the repo\'s contributor/agent docs (CONTRIBUTING.md, CLAUDE.md, AGENTS.md, SKILL.md, README.md, and any other .md guidelines present) and flag anywhere the change does NOT follow those conventions. ' +
        'Summarize findings with file:line references and concrete suggestions, citing the specific doc a violation breaks. Do not push changes unless asked.',
    });
  }

  // ---- data ---------------------------------------------------------------
  async function persist() {
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({}, state.cfg || {}, {
          boardOrg: state.org,
          boardRepos: state.repos,
        })),
      });
    } catch (e) { /* pins are a convenience — never block the board on saving them */ }
  }

  async function loadRepoOptions() {
    var owner = state.org || state.login;
    if (!owner) return;
    state.reposLoading = true; state.reposError = "";
    if (state.pickerOpen) render();
    try {
      var rows = await api("/api/github/repos?owner=" + encodeURIComponent(owner));
      state.repoOptions = (rows || []).map(function (r) { return r.nameWithOwner; }).filter(Boolean);
    } catch (e) {
      state.repoOptions = [];
      state.reposError = "Could not list repositories: " + (e.message || e);
    }
    state.reposLoading = false;
    if (state.pickerOpen) render();
  }

  async function load() {
    state.loading = true; state.error = "";
    render();
    try {
      var qs = [];
      if (state.org) qs.push("org=" + encodeURIComponent(state.org));
      if (state.repos.length) qs.push("repos=" + encodeURIComponent(state.repos.join(",")));
      var d = await api("/api/prboard" + (qs.length ? "?" + qs.join("&") : ""));
      state.prs = d.prs || [];
      state.login = d.login || state.login;
      state.fetchedAt = Date.now();
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.loading = false;
    render();
  }

  async function bootstrap() {
    try {
      var cfg = await api("/api/config");
      state.cfg = cfg || {};
      state.org = cfg.boardOrg || "";
      state.repos = cfg.boardRepos || [];
    } catch (e) { state.cfg = {}; }
    try {
      var o = await api("/api/github/orgs");
      state.login = o.login || "";
      state.orgs = o.orgs || [];
    } catch (e) { /* the board still works unscoped without the org list */ }
    render();
    await load();
    loadRepoOptions();
  }

  // GitHub data moves on its own clock, so the board refreshes on a slow timer
  // of its own rather than riding the operator's 2s agent poll — which used to
  // rebuild this DOM underneath an open drawer.
  var REFRESH_MS = 60000;
  var timer = null;
  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (!mount || !mount.isConnected) return;   // view was switched away
      if (state.pickerOpen || state.loading) return; // never yank the DOM mid-interaction
      load();
    }, REFRESH_MS);
  }

  window.renderPRBoard = function (mountEl, context) {
    mount = mountEl; ctx = context || {};
    if (!state.prs.length && !state.loading) bootstrap();
    else render();
    startTimer();
  };
  window.refreshPRBoard = function () { if (mount) load(); };
})();
