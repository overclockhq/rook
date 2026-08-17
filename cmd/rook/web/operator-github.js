/* operator-github.js — GitHub browser for the Operator UI (window.OP_VIEWS["github"]).
   Pick an org -> list repos (Clone) -> a repo's open issues & PRs, each with
   "Work" / "Review" actions that hand the item to an agent with a task prompt
   (mirrors the classic page). Reuses operator.css primitives; scoped extras
   under .op-gh, injected once. */
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var gh = {
    host: null, ctx: null, loaded: false, login: "", orgs: [],
    owner: "", repos: null, repoErr: "", reposLoading: false,
    repo: "", filter: "", items: { issues: null, prs: null }, itemsErr: "", itemsLoading: false,
    allowWrite: false   // /api/config → gates the Merge button (disabled when off)
  };

  function injectCSS() {
    if (document.getElementById("op-github-css")) return;
    var s = document.createElement("style");
    s.id = "op-github-css";
    s.textContent = [
      /* fixed-height view — the panes scroll in place, the page never scrolls */
      ".op-gh{overflow:hidden;display:flex;flex-direction:column}",
      ".op-gh .gh-bar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;flex:none}",
      ".op-gh .gh-grid{flex:1;min-height:0;grid-template-rows:minmax(0,1fr);align-items:stretch}",
      ".op-gh .gh-repos-card{min-height:0;display:flex;flex-direction:column}",
      ".op-gh .gh-right .ins-card{min-height:0;display:flex;flex-direction:column;flex:1}",
      ".op-gh .gh-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);font-weight:500}",
      ".op-gh .gh-org-select{height:32px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);padding:0 10px;font-size:12.5px;font-family:var(--sans);cursor:pointer}",
      ".op-gh .gh-org-select:focus{border-color:var(--coral-line);outline:none}",
      ".op-gh .gh-repo-search{max-width:280px}",
      ".op-gh .gh-status{margin-left:auto;color:var(--ink-4);font-size:11px;font-family:var(--mono)}",
      /* cards size to content (align-items:start on .ins-grid) — no dead-space boxes */
      ".op-gh .gh-right{display:flex;flex-direction:column;gap:16px;min-width:0;min-height:0;overflow:hidden}",
      ".op-gh .ins-card{min-width:0}",
      ".op-gh .gh-repolist{flex:1;display:flex;flex-direction:column;gap:2px;min-height:0;overflow:auto;margin:2px -6px 0}",
      /* repo row */
      ".op-gh .gh-repo{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;cursor:pointer;border:1px solid transparent}",
      ".op-gh .gh-repo:hover{background:var(--surface-2)}",
      ".op-gh .gh-repo.sel{background:var(--surface-3);border-color:var(--line-2)}",
      ".op-gh .gh-repo-main{min-width:0;flex:1}",
      ".op-gh .gh-repo-name{font-size:13px;font-weight:500;color:var(--ink);display:flex;align-items:center;gap:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-gh .gh-tag{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-4);border:1px solid var(--line-2);border-radius:5px;padding:1px 5px;flex:none}",
      ".op-gh .gh-tag.arc{color:var(--waiting);border-color:var(--waiting-soft)}",
      ".op-gh .gh-repo-desc{font-size:12px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}",
      ".op-gh .gh-repo-meta{font-size:11px;color:var(--ink-4);font-family:var(--mono);margin-top:2px}",
      ".op-gh .gh-repo-act{flex:none;opacity:0;transition:opacity .12s}",
      ".op-gh .gh-repo:hover .gh-repo-act,.op-gh .gh-repo.sel .gh-repo-act{opacity:1}",
      /* issue/PR item */
      ".op-gh .gh-list{flex:1;min-height:0;display:flex;flex-direction:column;gap:2px;margin:2px -6px 0;overflow:auto}",
      ".op-gh .gh-item{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:9px}",
      ".op-gh .gh-item:hover{background:var(--surface-2)}",
      ".op-gh .gh-item-main{min-width:0;flex:1}",
      ".op-gh .gh-item-top{display:flex;align-items:center;gap:8px;min-width:0}",
      ".op-gh .gh-item .num{font-family:var(--mono);color:var(--ink-4);font-size:11px;flex:none}",
      ".op-gh .gh-item .ttl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:13px}",
      ".op-gh .gh-item-sub{font-family:var(--mono);font-size:11px;color:var(--ink-4);margin-top:3px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
      ".op-gh .gh-item-act{flex:none;display:flex;gap:6px;opacity:0;transition:opacity .12s}",
      ".op-gh .gh-item:hover .gh-item-act{opacity:1}",
      ".op-gh .gh-icon-btn{width:28px;height:28px;padding:0;justify-content:center}",
      ".op-gh .btn[disabled]{opacity:.4;cursor:not-allowed}",
      ".op-gh .btn[disabled]:hover{color:var(--ink-2);border-color:var(--line);background:var(--surface-2)}",
      ".op-gh .gh-empty{color:var(--ink-4);font-size:12px;font-family:var(--mono);padding:12px 4px}"
    ].join("");
    document.head.appendChild(s);
  }

  function unwrap(j) { return j && j.data !== undefined ? j.data : j; }
  async function api(path) {
    var res = await fetch(path, { cache: "no-store" });
    if (!res.ok) {
      var msg = "HTTP " + res.status;
      try { var t = await res.text(); try { var e = JSON.parse(t); msg = (e && e.error && (e.error.message || e.error)) || (e && e.message) || t || msg; } catch (_) { if (t) msg = t; } } catch (_) {}
      throw new Error(String(msg).slice(0, 160));
    }
    return unwrap(await res.json());
  }
  function q(sel) { return gh.host ? gh.host.querySelector(sel) : null; }
  function empty(icon, main, hint) {
    var c = gh.ctx;
    return '<div class="op-empty" style="padding:26px 16px">' + (icon || "") + '<div class="t">' + c.esc(main) + "</div>" + (hint ? '<div class="h">' + c.esc(hint) + "</div>" : "") + "</div>";
  }

  // ---- turn an issue/PR into an agent task --------------------------------
  function repoPathFor(repo) { try { return localStorage.getItem("opRepoPath:" + (repo || "").split("/").pop()) || ""; } catch (e) { return ""; } }
  function rememberRepoPath(repo, p) { try { localStorage.setItem("opRepoPath:" + (repo || "").split("/").pop(), p); } catch (e) {} }
  function buildWork(it, kind, mode) {
    var num = it.number, repo = gh.repo, name, prompt, title;
    if (mode === "review") {
      name = "review-pr-" + num; title = "Review PR #" + num;
      prompt = 'Review GitHub pull request #' + num + ' in ' + repo + ': "' + it.title + '".\n' + it.url + '\n\n' +
        'Check out the PR branch (gh pr checkout ' + num + '), read the diff, and review it for correctness, bugs, security, tests, and style. ' +
        'Also read the repo\'s contributor/agent docs (CONTRIBUTING.md, CLAUDE.md, AGENTS.md, SKILL.md, README.md, and any other .md guidelines present) and flag anywhere the change does NOT follow those conventions — style, structure, testing, commit/PR, or workflow rules. ' +
        'Summarize findings with file:line references and concrete suggestions, citing the specific doc a violation breaks. Do not push changes unless asked.';
    } else if (kind === "prs") {
      name = "pr-" + num; title = "Work on PR #" + num;
      prompt = 'Continue work on GitHub pull request #' + num + ' in ' + repo + ': "' + it.title + '".\n' + it.url + '\n\n' +
        'First read the repo\'s contributor/agent docs (CONTRIBUTING.md, CLAUDE.md, AGENTS.md, SKILL.md, README.md, and any other .md guidelines) and follow those conventions. ' +
        'Check out the PR branch (gh pr checkout ' + num + '), address review comments and failing checks, run tests, and push the fixes.';
    } else {
      name = "issue-" + num; title = "Work on issue #" + num;
      prompt = 'Work on GitHub issue #' + num + ' in ' + repo + ': "' + it.title + '".\n' + it.url + '\n\n' +
        'First read the repo\'s contributor/agent docs (CONTRIBUTING.md, CLAUDE.md, AGENTS.md, SKILL.md, README.md, and any other .md guidelines) and follow those conventions. ' +
        'Then implement the change on a new branch off the default branch, run tests, and open a PR when done.';
    }
    var cwd = (gh.ctx.resolveRepo && gh.ctx.resolveRepo(repo)) || repoPathFor(repo);
    return { name: name, prompt: prompt, worktree: true, cwd: cwd, title: title };
  }
  function handToAgent(it, kind, mode) { gh.ctx.launch(buildWork(it, kind, mode)); }

  async function loadConfig() {
    try { var cfg = await api("/api/config"); gh.allowWrite = !!(cfg && cfg.allowWrite); if (gh.repo) renderItems(); }
    catch (e) { /* leave Merge disabled */ }
  }

  async function mergePR(it) {
    if (!window.confirm("Squash-merge PR #" + it.number + " in " + gh.repo + "?")) return;
    gh.ctx.toast("Merging #" + it.number + "…", "");
    try {
      var res = await fetch("/api/pr/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: gh.repo, number: it.number, method: "squash" }) });
      var d = unwrap(await res.json());
      if (!res.ok) { gh.ctx.toast((d && ((d.error && (d.error.message || d.error)) || d.message)) || "Merge failed — enable Allow write actions in Settings", "err"); return; }
      gh.ctx.toast("PR #" + it.number + " merged", "ok");
      selectRepo(gh.repo);
    } catch (e) { gh.ctx.toast("Merge failed", "err"); }
  }

  function commonParentOf(repos) {
    var counts = {}, best = "", bestN = 0;
    (repos || []).forEach(function (r) { if (!r.path) return; var p = r.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/"); counts[p] = (counts[p] || 0) + 1; if (counts[p] > bestN) { bestN = counts[p]; best = p; } });
    return best;
  }
  async function cloneRepo(repo) {
    var def = "";
    try { def = localStorage.getItem("opCloneParent") || ""; } catch (e) {}
    if (!def) def = commonParentOf(gh.ctx.getRepos && gh.ctx.getRepos()); // default to where your repos already live
    var parent = window.prompt("Clone " + repo + " into which parent directory?", def || "");
    if (!parent) return;
    parent = parent.trim();
    try { localStorage.setItem("opCloneParent", parent); } catch (e) {}
    gh.ctx.toast("Cloning " + repo + "…", "");
    try {
      var res = await fetch("/api/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repo, dir: parent.trim() }) });
      var d = unwrap(await res.json());
      if (!res.ok) { gh.ctx.toast((d && (d.error || d.message)) || "Clone failed", "err"); return; }
      if (d && d.path) { rememberRepoPath(repo, d.path); if (gh.ctx.rememberRepo) gh.ctx.rememberRepo(repo, d.path); gh.ctx.toast(d.reused ? "Already cloned" : "Cloned to " + d.path, "ok"); }
      else gh.ctx.toast("Cloned", "ok");
    } catch (e) { gh.ctx.toast("Clone failed", "err"); }
  }

  // ---- rendering -----------------------------------------------------------
  function populateOrgSelect() {
    var sel = q(".gh-org-select"); if (!sel) return; var c = gh.ctx;
    var owners = []; if (gh.login) owners.push(gh.login);
    (gh.orgs || []).forEach(function (o) { if (o !== gh.login) owners.push(o); });
    sel.innerHTML = owners.map(function (o) { return '<option value="' + c.esc(o) + '">' + c.esc(o) + (o === gh.login ? " (you)" : "") + "</option>"; }).join("");
    if (gh.owner) sel.value = gh.owner;
  }

  function renderRepos() {
    var host = q(".gh-repolist"), count = q(".gh-repo-count"); if (!host) return; var c = gh.ctx;
    if (gh.reposLoading) { host.innerHTML = '<div class="gh-empty">Loading repositories…</div>'; if (count) count.textContent = ""; return; }
    if (gh.repoErr) { host.innerHTML = empty(c.icon.alert, "Could not load repositories", gh.repoErr); if (count) count.textContent = ""; return; }
    if (gh.repos === null) { host.innerHTML = empty(c.icon.search, "Pick an org", "Choose an owner above to list its repositories."); if (count) count.textContent = ""; return; }
    var f = gh.filter.toLowerCase().trim();
    var list = gh.repos.filter(function (r) { return !f || ((r.name || "") + " " + (r.description || "")).toLowerCase().indexOf(f) !== -1; });
    if (count) count.textContent = list.length + (f ? " / " + gh.repos.length : "");
    if (!list.length) { host.innerHTML = empty(c.icon.search, gh.repos.length ? "No repositories match" : "No repositories", ""); return; }
    host.innerHTML = list.map(function (r) {
      var ts = Date.parse(r.updatedAt), lang = (r.primaryLanguage && r.primaryLanguage.name) || "", stars = r.stargazerCount ? " · ★ " + r.stargazerCount : "";
      return '<div class="gh-repo' + (r.nameWithOwner === gh.repo ? " sel" : "") + '" data-repo="' + c.esc(r.nameWithOwner) + '">' +
        '<div class="gh-repo-main">' +
          '<div class="gh-repo-name">' + c.esc(r.name) + (r.isPrivate ? '<span class="gh-tag">private</span>' : "") + (r.isArchived ? '<span class="gh-tag arc">archived</span>' : "") + "</div>" +
          '<div class="gh-repo-desc">' + c.esc(r.description || "—") + "</div>" +
          '<div class="gh-repo-meta">' + c.esc(lang) + c.esc(stars) + (ts ? ' · <span class="gh-ago" data-ts="' + ts + '">' + c.esc(c.ago(ts, c.now())) + "</span>" : "") + "</div>" +
        "</div>" +
        '<button class="btn sm gh-repo-act" data-clone="' + c.esc(r.nameWithOwner) + '">' + c.icon.plus + "Clone</button>" +
      "</div>";
    }).join("");
    host.querySelectorAll(".gh-repo").forEach(function (row) { row.addEventListener("click", function () { selectRepo(row.dataset.repo); }); });
    host.querySelectorAll(".gh-repo-act").forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); cloneRepo(b.dataset.clone); }); });
  }

  function prPill(it) {
    if (it.isDraft) return '<span class="pill idle">draft</span>';
    if (it.reviewDecision === "APPROVED") return '<span class="pill done">approved</span>';
    if (it.reviewDecision === "CHANGES_REQUESTED") return '<span class="pill dead">changes</span>';
    return '<span class="pill busy">open</span>';
  }
  function itemRow(it, kind) {
    var c = gh.ctx, ts = Date.parse(it.updatedAt), author = (it.author && it.author.login) || "";
    var pill, extra;
    var nComments = Array.isArray(it.comments) ? it.comments.length : (typeof it.comments === "number" ? it.comments : 0);
    if (kind === "prs") { pill = prPill(it); var churn = (it.additions != null ? "+" + it.additions : "") + (it.deletions != null ? " −" + it.deletions : ""); extra = churn.trim(); }
    else { pill = '<span class="pill waiting">open</span>'; extra = nComments ? nComments + (nComments === 1 ? " comment" : " comments") : ""; }
    var sub = pill + (author ? '<span>@' + c.esc(author) + "</span>" : "") + (extra ? "<span>" + c.esc(extra) + "</span>" : "") + (ts ? '<span class="gh-ago" data-ts="' + ts + '">' + c.esc(c.ago(ts, c.now())) + "</span>" : "");
    var acts = "";
    if (kind === "prs") {
      acts += '<button class="btn sm" data-act="review">' + c.icon.review + 'Review</button>' + '<button class="btn sm" data-act="work">Work</button>';
      acts += gh.allowWrite
        ? '<button class="btn sm" data-act="merge" title="Squash-merge #' + c.esc(it.number) + '">Merge</button>'
        : '<button class="btn sm" data-act="merge" disabled title="Turn on ‘Allow write actions’ in Settings to merge">Merge</button>';
    }
    else acts += '<button class="btn sm" data-act="work">' + c.icon.plus + "Work</button>";
    acts += '<button class="btn sm gh-icon-btn" data-act="open" title="Open on GitHub">' + c.icon.external + "</button>";
    return '<div class="gh-item" data-num="' + c.esc(it.number) + '">' +
      '<div class="gh-item-main"><div class="gh-item-top"><span class="num">#' + c.esc(it.number) + '</span><span class="ttl">' + c.esc(it.title || "") + "</span></div>" +
      '<div class="gh-item-sub">' + sub + "</div></div>" +
      '<div class="gh-item-act">' + acts + "</div>" +
    "</div>";
  }
  function renderColumn(sel, kind, metaSel) {
    var host = q(sel); if (!host) return; var c = gh.ctx; var meta = metaSel ? q(metaSel) : null;
    if (!gh.repo) { host.innerHTML = '<div class="gh-empty">Select a repository to see its open ' + (kind === "prs" ? "PRs" : "issues") + ".</div>"; if (meta) meta.textContent = ""; return; }
    if (gh.itemsLoading) { host.innerHTML = '<div class="gh-empty">Loading…</div>'; if (meta) meta.textContent = ""; return; }
    if (gh.itemsErr) { host.innerHTML = empty(c.icon.alert, "Could not load " + (kind === "prs" ? "PRs" : "issues"), gh.itemsErr); if (meta) meta.textContent = ""; return; }
    var data = gh.items[kind];
    if (data == null) { host.innerHTML = '<div class="gh-empty">Loading…</div>'; if (meta) meta.textContent = ""; return; }
    if (meta) meta.textContent = data.length;
    if (!data.length) { host.innerHTML = '<div class="gh-empty">No open ' + (kind === "prs" ? "pull requests" : "issues") + " 🎉</div>"; return; }
    host.innerHTML = data.map(function (it) { return itemRow(it, kind); }).join("");
    host.querySelectorAll(".gh-item").forEach(function (row) {
      var num = row.dataset.num, it = data.filter(function (x) { return String(x.number) === String(num); })[0];
      row.querySelectorAll("[data-act]").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var a = b.dataset.act;
          if (a === "open") { if (it && it.url) window.open(it.url, "_blank"); }
          else if (a === "review") handToAgent(it, kind, "review");
          else if (a === "merge") mergePR(it);
          else handToAgent(it, kind, "work");
        });
      });
    });
  }
  function renderItems() { renderColumn(".gh-issuelist", "issues", ".gh-issue-count"); renderColumn(".gh-prlist", "prs", ".gh-pr-count"); }

  // ---- data flow -----------------------------------------------------------
  async function loadOrgs() {
    var status = q(".gh-status"); if (status) status.textContent = "loading orgs…";
    try {
      var d = await api("/api/github/orgs");
      gh.login = (d && d.login) || ""; gh.orgs = (d && d.orgs) || []; gh.loaded = true;
      if (status) status.textContent = "";
      if (!gh.login && !gh.orgs.length) { var host = q(".gh-repolist"); if (host) host.innerHTML = empty(gh.ctx.icon.alert, "No GitHub accounts", "gh CLI not configured — run `gh auth login`."); populateOrgSelect(); return; }
      populateOrgSelect(); selectOwner(gh.owner || gh.login || gh.orgs[0]);
    } catch (e) {
      gh.loaded = true; if (status) status.textContent = "";
      var h = q(".gh-repolist"); if (h) h.innerHTML = empty(gh.ctx.icon.alert, "GitHub unavailable", String(e.message || e) + " — is the gh CLI installed and authed?");
    }
  }
  async function selectOwner(owner) {
    if (!owner) return;
    gh.owner = owner; gh.repo = ""; gh.repos = null; gh.repoErr = ""; gh.items = { issues: null, prs: null }; gh.itemsErr = "";
    var sel = q(".gh-org-select"); if (sel && sel.value !== owner) sel.value = owner;
    gh.reposLoading = true; renderRepos(); renderItems();
    try {
      var repos = await api("/api/github/repos?owner=" + encodeURIComponent(owner));
      if (gh.owner !== owner) return;
      repos = repos || []; repos.sort(function (a, b) { return (b.updatedAt || "").localeCompare(a.updatedAt || ""); }); gh.repos = repos;
    } catch (e) { if (gh.owner !== owner) return; gh.repoErr = String(e.message || e); }
    finally { if (gh.owner === owner) { gh.reposLoading = false; renderRepos(); } }
  }
  async function selectRepo(repo) {
    if (!repo) return;
    gh.repo = repo; gh.items = { issues: null, prs: null }; gh.itemsErr = ""; gh.itemsLoading = true;
    renderRepos(); renderItems();
    try {
      var res = await Promise.all([api("/api/github/issues?repo=" + encodeURIComponent(repo)), api("/api/github/prs?repo=" + encodeURIComponent(repo))]);
      if (gh.repo !== repo) return; gh.items = { issues: res[0] || [], prs: res[1] || [] };
    } catch (e) { if (gh.repo !== repo) return; gh.itemsErr = String(e.message || e); }
    finally { if (gh.repo === repo) { gh.itemsLoading = false; renderItems(); } }
  }

  window.OP_VIEWS["github"] = {
    build: function (host, ctx) {
      injectCSS(); gh.host = host; gh.ctx = ctx;
      host.innerHTML =
        '<div class="ins op-gh">' +
          '<div class="gh-bar"><span class="gh-lbl">Org</span><select class="gh-org-select"></select>' +
          '<input class="op-roster-search gh-repo-search" placeholder="Filter repositories…" /><span class="gh-status"></span></div>' +
          '<div class="ins-grid gh-grid">' +
            '<div class="ins-card gh-repos-card"><div class="ins-card-head"><div class="ins-card-title">Repositories</div><div class="ins-card-meta gh-repo-count"></div></div><div class="gh-repolist"></div></div>' +
            '<div class="gh-right">' +
              '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Open Issues</div><div class="ins-card-meta gh-issue-count"></div></div><div class="gh-issuelist gh-list"></div></div>' +
              '<div class="ins-card"><div class="ins-card-head"><div class="ins-card-title">Open Pull Requests</div><div class="ins-card-meta gh-pr-count"></div></div><div class="gh-prlist gh-list"></div></div>' +
            "</div>" +
          "</div>" +
        "</div>";
      var sel = q(".gh-org-select"); if (sel) sel.addEventListener("change", function () { selectOwner(sel.value); });
      var search = q(".gh-repo-search"); if (search) { search.value = gh.filter; search.addEventListener("input", function () { gh.filter = search.value; renderRepos(); }); }
      loadConfig();
      if (gh.loaded) { populateOrgSelect(); renderRepos(); renderItems(); } else { loadOrgs(); }
    },
    render: function (state, ctx) {
      if (!gh.host) return; var c = ctx || gh.ctx; if (!c) return; var now = c.now();
      gh.host.querySelectorAll(".gh-ago[data-ts]").forEach(function (n) { var ts = parseInt(n.getAttribute("data-ts"), 10); if (ts) n.textContent = c.ago(ts, now); });
    }
  };
})();
