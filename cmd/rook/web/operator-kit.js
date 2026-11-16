/* operator-kit.js — Agents & Skills view (window.OP_VIEWS["kit"]).
   Read-only inventory of the user's Claude Code subagents and skills, global
   (~/.claude) and per repo (<repo>/.claude), with an on-demand skill audit.

   Server shapes (see kit.go):
     GET  /api/kit              -> {home, agents:[...], skills:[...], archived:[{name,scope}], repos:[{name,path}]}
     GET  /api/kit/file?path=   -> {path, resolved, size, mtime, content}
     GET  /api/kit/audit        -> {running, ranAt, seconds, header, summary, result, findings:[{skill,scope,thirdParty,level,message}], error}
     POST /api/kit/audit        -> same; starts a run in the background, poll GET until running=false */
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var K = {
    host: null, ctx: null, tab: "agents", inv: null, loading: false, error: null,
    selAgent: null, selSkill: null, files: {}, fileErr: {},
    q: "", scope: "", chips: { manual: false, fork: false, side: false, issues: false },
    audit: null, auditTimer: null
  };

  function unwrap(r) { return (r && r.data !== undefined && r.data !== null) ? r.data : r; }
  function getJSON(url, opts) {
    return fetch(url, Object.assign({ cache: "no-store" }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && (j.error && j.error.message || j.message)) || ("HTTP " + r.status));
        return unwrap(j);
      });
    });
  }

  function injectCSS() {
    if (document.getElementById("op-kit-css")) return;
    var s = document.createElement("style");
    s.id = "op-kit-css";
    s.textContent = [
      ".op-kit{display:flex;flex-direction:column;overflow:hidden;padding:0}",
      ".op-kit .kit-top{display:flex;align-items:flex-end;gap:12px;padding:12px 24px 0;border-bottom:1px solid var(--line);flex:none}",
      ".op-kit .kit-top .ws-tabs{border-bottom:none;padding:0}",
      ".op-kit .kit-top .meta{margin-left:auto;padding-bottom:9px;font-size:11.5px;color:var(--ink-4);font-family:var(--mono)}",
      ".op-kit .kit-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(340px,46%) 1fr;grid-template-rows:minmax(0,1fr);gap:16px;padding:16px 24px 20px}",
      "@media (max-width:900px){.op-kit .kit-body{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}",
      ".op-kit .pane{min-height:0;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);overflow:hidden}",
      ".op-kit .pane-scroll{flex:1;min-height:0;overflow:auto}",
      ".op-kit .bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);flex:none}",
      ".op-kit .search{flex:1;min-width:160px;display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg)}",
      ".op-kit .search svg{width:14px;height:14px;color:var(--ink-4);flex:none}",
      ".op-kit .search input{flex:1;min-width:0;background:none;border:none;outline:none;color:var(--ink);font-size:12.5px;font-family:var(--sans)}",
      ".op-kit .search input::placeholder{color:var(--ink-4)}",
      ".op-kit select{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink-2);font-size:12px;font-family:var(--sans);outline:none}",
      ".op-kit .fchip{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--ink-3);font-size:11.5px;cursor:pointer;font-family:var(--sans)}",
      ".op-kit .fchip:hover{color:var(--ink);border-color:var(--line-strong)}",
      ".op-kit .fchip.on{color:var(--coral);border-color:var(--coral-line);background:var(--coral-soft)}",
      ".op-kit .audit-line{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink-3);flex:none}",
      ".op-kit .audit-line .sum{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-kit .audit-line .err{color:var(--danger)}",
      ".op-kit .audit-line .btn{margin-left:auto;flex:none}",
      ".op-kit .tag{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:500;padding:2px 7px;border-radius:999px;background:var(--surface-3);color:var(--ink-3);white-space:nowrap;font-family:var(--sans)}",
      ".op-kit .tag.m-opus{color:var(--shell);background:color-mix(in srgb,var(--shell) 15%,transparent)}",
      ".op-kit .tag.m-sonnet{color:var(--busy);background:var(--busy-soft)}",
      ".op-kit .tag.m-haiku{color:var(--ok);background:var(--ok-soft)}",
      ".op-kit .tag.ro{color:var(--ok);background:var(--ok-soft)}",
      ".op-kit .tag.wr{color:var(--waiting);background:var(--waiting-soft)}",
      ".op-kit .tag.fail{color:var(--danger);background:var(--danger-soft)}",
      ".op-kit .tag.warn{color:var(--waiting);background:var(--waiting-soft)}",
      ".op-kit .tag.pass{color:var(--ok);background:var(--ok-soft)}",
      ".op-kit .tag.accent{color:var(--coral);background:var(--coral-soft)}",
      ".op-kit .acard{padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;flex-direction:column;gap:6px}",
      ".op-kit .acard:hover{background:var(--surface-2)}",
      ".op-kit .acard.sel{background:var(--surface-3)}",
      ".op-kit .acard .row1{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
      ".op-kit .acard .nm{font-weight:600;color:var(--ink);font-size:13px;margin-right:2px}",
      ".op-kit .cdot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--ink-4)}",
      ".op-kit .acard .ds{font-size:12px;color:var(--ink-3);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".op-kit table{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".op-kit thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;padding:9px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2);white-space:nowrap;z-index:1}",
      ".op-kit tbody td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-2)}",
      ".op-kit tbody tr{cursor:pointer}",
      ".op-kit tbody tr:hover{background:var(--surface-2)}",
      ".op-kit tbody tr.sel{background:var(--surface-3)}",
      ".op-kit td .nm{font-weight:500;color:var(--ink)}",
      ".op-kit td .sub{font-size:11.5px;color:var(--ink-4);margin-top:2px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-kit td .tags{display:flex;flex-wrap:wrap;gap:4px}",
      ".op-kit .num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}",
      ".op-kit details.arch{border-top:1px solid var(--line);padding:10px 12px;font-size:12px;color:var(--ink-3)}",
      ".op-kit details.arch summary{cursor:pointer;color:var(--ink-3)}",
      ".op-kit details.arch .names{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}",
      ".op-kit .det{padding:16px 18px;display:flex;flex-direction:column;gap:14px}",
      ".op-kit .det h2{margin:0;font-size:16px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".op-kit .det .lede{font-size:12.5px;color:var(--ink-2);line-height:1.55}",
      ".op-kit .facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:12px}",
      ".op-kit .facts dt{color:var(--ink-4)}",
      ".op-kit .facts dd{margin:0;color:var(--ink-2);min-width:0;overflow-wrap:anywhere}",
      ".op-kit .mono{font-family:var(--mono);font-size:11.5px}",
      ".op-kit .sec{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-4);font-weight:500;margin-bottom:-6px}",
      ".op-kit pre.body{margin:0;padding:12px 14px;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);font-family:var(--mono);font-size:11.5px;line-height:1.55;color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere}",
      ".op-kit .hook{font-size:11.5px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}",
      ".op-kit .find{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--ink-2);line-height:1.45}",
      ".op-kit details.mem{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface-2)}",
      ".op-kit details.mem summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--ink-2);display:flex;gap:10px}",
      ".op-kit details.mem summary .mono{color:var(--ink-4);margin-left:auto}",
      ".op-kit details.mem pre.body{border:none;border-top:1px solid var(--line);border-radius:0 0 var(--radius) var(--radius)}",
      ".op-kit .muted{color:var(--ink-4);font-size:12px}",
      ".op-kit .op-empty{padding:48px 20px}",
      ".op-kit .op-empty .h{font-family:var(--sans);max-width:380px;line-height:1.5}"
    ].join("");
    document.head.appendChild(s);
  }

  // ---- data ----------------------------------------------------------------
  function load() {
    if (K.loading) return;
    K.loading = true; paintTop();
    getJSON("/api/kit").then(function (inv) { K.inv = inv || {}; K.error = null; })
      .catch(function (e) { K.error = e.message || "load failed"; })
      .then(function () { K.loading = false; paintAll(); });
  }
  function loadFile(path) {
    if (!path || K.files[path] !== undefined) return;
    K.files[path] = null; // in flight
    getJSON("/api/kit/file?path=" + encodeURIComponent(path))
      .then(function (f) { K.files[path] = (f && f.content) || ""; })
      .catch(function (e) { K.files[path] = ""; K.fileErr[path] = e.message || "couldn't load"; })
      .then(paintDetail);
  }
  function loadAudit() {
    getJSON("/api/kit/audit").then(function (a) { K.audit = a; paintSkillsChrome(); paintList(); paintDetail(); if (a && a.running) pollAudit(); }).catch(function () {});
  }
  function pollAudit() {
    clearTimeout(K.auditTimer);
    K.auditTimer = setTimeout(function () {
      if (!K.host || !document.body.contains(K.host)) return;
      loadAudit();
    }, 1000);
  }
  function runAudit() {
    K.audit = Object.assign({}, K.audit || {}, { running: true });
    paintSkillsChrome();
    getJSON("/api/kit/audit", { method: "POST" }).then(function () { pollAudit(); })
      .catch(function (e) { K.audit = { running: false, error: e.message, findings: [] }; paintSkillsChrome(); });
  }

  // ---- helpers -------------------------------------------------------------
  function e(v) { return K.ctx.esc(v == null ? "" : String(v)); }
  function agents() { return (K.inv && K.inv.agents) || []; }
  function skills() { return (K.inv && K.inv.skills) || []; }
  function archived() { return (K.inv && K.inv.archived) || []; }
  function modelTag(m) {
    if (!m) return '<span class="tag">inherit</span>';
    var k = /opus/i.test(m) ? "m-opus" : /sonnet/i.test(m) ? "m-sonnet" : /haiku/i.test(m) ? "m-haiku" : "";
    return '<span class="tag ' + k + '">' + e(m) + "</span>";
  }
  var COLOR_TOKEN = { purple: "--shell", violet: "--shell", blue: "--busy", cyan: "--busy", green: "--ok", yellow: "--waiting", orange: "--waiting", red: "--danger", pink: "--coral" };
  function colorDot(c) {
    var t = COLOR_TOKEN[(c || "").toLowerCase()];
    return '<span class="cdot"' + (t ? ' style="background:var(' + t + ')"' : "") + (c ? ' title="' + e(c) + '"' : "") + "></span>";
  }
  function accessTag(a) {
    if (a.readOnly) return '<span class="tag ro">read-only</span>';
    return '<span class="tag wr"' + (a.writeScope ? ' title="writes limited by hook: ' + e(a.writeScope) + '"' : "") + ">" + (a.writeScope ? "scoped writes" : "writes") + "</span>";
  }
  function stripFront(text) {
    var m = String(text || "").match(/^---\r?\n[\s\S]*?\r?\n---[^\n]*\n?/);
    return m ? { front: m[0].replace(/^---\r?\n|\r?\n---[^\n]*\n?$/g, ""), body: text.slice(m[0].length) } : { front: "", body: text || "" };
  }
  function when(ms) { return ms ? K.ctx.ago(ms, K.ctx.now()) : "—"; }
  function kb(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB"; }

  // audit findings indexed to skills: audit names skills by folder, scoped
  // "user" (global) or "project" (any repo); cross-skill findings have no scope.
  function findingsFor(s) {
    var a = K.audit; if (!a || !a.findings) return [];
    return a.findings.filter(function (f) {
      if (f.skill !== s.dir) return false;
      if (f.scope === "user") return s.scope === "global";
      if (f.scope === "project") return s.scope !== "global";
      return true;
    });
  }
  function auditTag(s) {
    if (!K.audit || !K.audit.ranAt) return "";
    var fs = findingsFor(s);
    if (!fs.length) return '<span class="tag pass">ok</span>';
    var fail = fs.filter(function (f) { return f.level === "fail"; }).length;
    return fail ? '<span class="tag fail">' + fail + " fail</span>" : '<span class="tag warn">' + fs.length + " warn</span>";
  }

  function filteredSkills() {
    var q = K.q.toLowerCase();
    return skills().filter(function (s) {
      if (K.scope && s.scope !== K.scope) return false;
      if (K.chips.manual && !s.manualOnly) return false;
      if (K.chips.fork && s.context !== "fork") return false;
      if (K.chips.side && !s.sideEffects) return false;
      if (K.chips.issues && !findingsFor(s).length) return false;
      if (!q) return true;
      return (s.name + " " + s.dir + " " + (s.description || "") + " " + s.scope).toLowerCase().indexOf(q) !== -1;
    });
  }

  // ---- paint ---------------------------------------------------------------
  function paintAll() { paintTop(); paintBody(); }

  function paintTop() {
    var top = K.host && K.host.querySelector(".kit-top"); if (!top) return;
    var c = K.ctx, na = agents().length, ns = skills().length;
    top.innerHTML =
      '<div class="ws-tabs">' +
        '<button class="ws-tab' + (K.tab === "agents" ? " on" : "") + '" data-tab="agents">' + c.icon.terminal + 'Agents <span class="tab-badge">' + na + "</span></button>" +
        '<button class="ws-tab' + (K.tab === "skills" ? " on" : "") + '" data-tab="skills">' + c.icon.file + 'Skills <span class="tab-badge">' + ns + "</span></button>" +
      "</div>" +
      '<div class="meta">' + (K.loading ? "scanning…" : K.inv ? e(K.inv.home || "~/.claude") + (K.inv.repos && K.inv.repos.length ? " + " + K.inv.repos.length + " repo" + (K.inv.repos.length > 1 ? "s" : "") : "") : "") + "</div>";
    top.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { if (K.tab === b.dataset.tab) return; K.tab = b.dataset.tab; paintAll(); });
    });
  }

  function paintBody() {
    var body = K.host && K.host.querySelector(".kit-body"); if (!body) return;
    var c = K.ctx;
    if (K.error && !K.inv) {
      body.innerHTML = '<div class="op-empty" style="grid-column:1/-1">' + c.icon.alert + '<div class="t">Couldn\'t read your Claude setup</div><div class="h">' + e(K.error) + "</div></div>";
      return;
    }
    if (!K.inv) { body.innerHTML = '<div class="op-empty" style="grid-column:1/-1"><div class="t">Scanning ~/.claude…</div></div>'; return; }
    if (K.tab === "agents") {
      body.innerHTML = '<div class="pane"><div class="pane-scroll kit-list"></div></div><div class="pane"><div class="pane-scroll kit-det"></div></div>';
    } else {
      body.innerHTML = '<div class="pane"><div class="bar kit-bar"></div><div class="kit-audit"></div><div class="pane-scroll kit-list"></div></div><div class="pane"><div class="pane-scroll kit-det"></div></div>';
      buildSkillsBar();
      paintSkillsChrome();
    }
    paintList(); paintDetail();
  }

  function buildSkillsBar() {
    var bar = K.host.querySelector(".kit-bar"); if (!bar) return;
    var scopes = {}; skills().forEach(function (s) { scopes[s.scope] = 1; });
    var opts = '<option value="">All scopes</option>' + Object.keys(scopes).sort(function (a, b) { return a === "global" ? -1 : b === "global" ? 1 : a < b ? -1 : 1; })
      .map(function (s) { return '<option value="' + e(s) + '"' + (K.scope === s ? " selected" : "") + ">" + e(s) + "</option>"; }).join("");
    var chip = function (k, label) { return '<button class="fchip' + (K.chips[k] ? " on" : "") + '" data-chip="' + k + '">' + label + "</button>"; };
    bar.innerHTML = '<label class="search">' + K.ctx.icon.search + '<input type="text" placeholder="Search skills" value="' + e(K.q) + '"></label>' +
      '<select class="kit-scope">' + opts + "</select>" +
      chip("manual", "Manual-only") + chip("fork", "Fork") + chip("side", "Side effects") + chip("issues", "Audit issues");
    bar.querySelector("input").addEventListener("input", function (ev) { K.q = ev.target.value; paintList(); });
    bar.querySelector(".kit-scope").addEventListener("change", function (ev) { K.scope = ev.target.value; paintList(); });
    bar.querySelectorAll("[data-chip]").forEach(function (b) {
      b.addEventListener("click", function () { K.chips[b.dataset.chip] = !K.chips[b.dataset.chip]; b.classList.toggle("on", K.chips[b.dataset.chip]); paintList(); });
    });
  }

  function paintSkillsChrome() {
    var box = K.host && K.host.querySelector(".kit-audit"); if (!box) return;
    var a = K.audit || {}, txt;
    if (a.running) txt = '<span class="sum">Running skill audit…</span>';
    else if (a.error) txt = '<span class="sum err" title="' + e(a.error) + '">' + e(a.error) + "</span>";
    else if (a.ranAt) txt = '<span class="tag ' + (a.result === "FAIL" ? "fail" : "pass") + '">' + e(a.result || "done") + '</span><span class="sum" title="' + e(a.header) + '">' + e((a.summary || "").replace(/^RESULT:\s*\w+\s*/, "")) + " · " + when(a.ranAt) + "</span>";
    else txt = '<span class="sum">Check every skill against the skill standard (size, description, side effects).</span>';
    box.className = "kit-audit audit-line";
    box.innerHTML = txt + '<button class="btn sm"' + (a.running ? " disabled" : "") + ">" + K.ctx.icon.review + (a.running ? "Auditing…" : "Run skill audit") + "</button>";
    box.querySelector("button").addEventListener("click", function () { if (!(K.audit && K.audit.running)) runAudit(); });
  }

  function paintList() {
    var box = K.host && K.host.querySelector(".kit-list"); if (!box) return;
    var c = K.ctx, top = box.scrollTop;
    if (K.tab === "agents") {
      var list = agents();
      if (!list.length) {
        box.innerHTML = '<div class="op-empty">' + c.icon.terminal + '<div class="t">No subagents yet</div><div class="h">Subagents are Markdown files with YAML frontmatter in ~/.claude/agents/ (all projects) or &lt;repo&gt;/.claude/agents/ (one repo). Create one with /agents in Claude Code.</div></div>';
        return;
      }
      if (!K.selAgent || !list.some(function (a) { return a.path === K.selAgent; })) K.selAgent = list[0].path;
      box.innerHTML = list.map(function (a) {
        return '<div class="acard' + (a.path === K.selAgent ? " sel" : "") + '" data-path="' + e(a.path) + '">' +
          '<div class="row1">' + colorDot(a.color) + '<span class="nm">' + e(a.name) + "</span>" + modelTag(a.model) +
            (a.effort ? '<span class="tag">' + e(a.effort) + "</span>" : "") + accessTag(a) +
            '<span class="tag">' + e(a.scope) + "</span>" + (a.memory ? '<span class="tag accent">memory</span>' : "") + "</div>" +
          '<div class="ds">' + e(a.description || "No description") + "</div></div>";
      }).join("");
      box.querySelectorAll(".acard").forEach(function (el) {
        el.addEventListener("click", function () { K.selAgent = el.dataset.path; paintList(); paintDetail(); });
      });
    } else {
      var all = skills(), rows = filteredSkills(), arch = archived();
      var html;
      if (!all.length) {
        html = '<div class="op-empty">' + c.icon.file + '<div class="t">No skills installed</div><div class="h">A skill is a folder with a SKILL.md in ~/.claude/skills/&lt;name&gt;/ (all projects) or &lt;repo&gt;/.claude/skills/&lt;name&gt;/. Claude loads it when its description matches, or you run it as /&lt;name&gt;.</div></div>';
      } else if (!rows.length) {
        html = '<div class="op-empty">' + c.icon.search + '<div class="t">No skills match these filters</div></div>';
      } else {
        if (!K.selSkill || !rows.some(function (s) { return s.path === K.selSkill; })) K.selSkill = rows[0].path;
        html = "<table><thead><tr><th>Skill</th><th>Scope</th><th>Flags</th><th class=\"num\">Lines</th><th>Audit</th></tr></thead><tbody>" +
          rows.map(function (s) {
            var tags = (s.manualOnly ? '<span class="tag">manual</span>' : "") + (s.context === "fork" ? '<span class="tag accent">fork</span>' : "") +
              (s.sideEffects ? '<span class="tag wr">side effects</span>' : "") + (s.thirdParty ? '<span class="tag">3rd-party</span>' : "") +
              (s.symlink ? '<span class="tag" title="' + e(s.symlink) + '">link</span>' : "");
            return '<tr data-path="' + e(s.path) + '"' + (s.path === K.selSkill ? ' class="sel"' : "") + ">" +
              '<td><div class="nm">' + e(s.name) + '</div><div class="sub">' + e(s.description || "") + "</div></td>" +
              "<td>" + e(s.scope) + '</td><td><div class="tags">' + tags + "</div></td>" +
              '<td class="num">' + e(s.lines) + "</td><td>" + auditTag(s) + "</td></tr>";
          }).join("") + "</tbody></table>";
      }
      if (arch.length) {
        html += '<details class="arch"><summary>Archived · ' + arch.length + '</summary><div class="names">' +
          arch.map(function (x) { return '<span class="tag" title="' + e(x.scope) + '">' + e(x.name) + (x.scope !== "global" ? " · " + e(x.scope) : "") + "</span>"; }).join("") + "</div></details>";
      }
      var wasOpen = box.querySelector("details.arch") && box.querySelector("details.arch").open;
      box.innerHTML = html;
      if (wasOpen && box.querySelector("details.arch")) box.querySelector("details.arch").open = true;
      box.querySelectorAll("tbody tr").forEach(function (tr) {
        tr.addEventListener("click", function () { K.selSkill = tr.dataset.path; paintList(); paintDetail(); });
      });
    }
    box.scrollTop = top;
  }

  function bodyBlock(path) {
    loadFile(path);
    var f = K.files[path];
    if (f === null || f === undefined) return '<div class="muted">Loading…</div>';
    if (K.fileErr[path]) return '<div class="muted">' + e(K.fileErr[path]) + "</div>";
    var b = stripFront(f).body.replace(/^\s+/, "");
    return b ? '<pre class="body">' + e(b) + "</pre>" : '<div class="muted">Empty body.</div>';
  }

  function paintDetail() {
    var box = K.host && K.host.querySelector(".kit-det"); if (!box) return;
    var top = box.scrollTop, html = "";
    if (K.tab === "agents") {
      var a = agents().filter(function (x) { return x.path === K.selAgent; })[0];
      if (!a) { box.innerHTML = '<div class="op-empty"><div class="t">Select an agent</div></div>'; return; }
      var hooks = (a.hooks || []).map(function (h) {
        return '<div class="hook"><span class="tag">' + e(h.event) + (h.matcher ? " · " + e(h.matcher) : "") + '</span><span class="mono">' + e(h.command) + "</span></div>";
      }).join("");
      html = '<div class="det"><h2>' + colorDot(a.color) + e(a.name) + modelTag(a.model) + accessTag(a) + "</h2>" +
        '<div class="lede">' + e(a.description || "No description") + "</div>" +
        '<dl class="facts">' +
          "<dt>Scope</dt><dd>" + e(a.scope) + "</dd>" +
          "<dt>Effort</dt><dd>" + e(a.effort || "default") + "</dd>" +
          "<dt>Tools</dt><dd class=\"mono\">" + (a.tools && a.tools.length ? e(a.tools.join(", ")) : "all (inherited)") + "</dd>" +
          (a.disallowedTools && a.disallowedTools.length ? "<dt>Disallowed</dt><dd class=\"mono\">" + e(a.disallowedTools.join(", ")) + "</dd>" : "") +
          "<dt>Skills</dt><dd>" + (a.skills && a.skills.length ? e(a.skills.join(", ")) : "—") + "</dd>" +
          "<dt>Memory</dt><dd>" + (a.memory ? e(a.memory) + (a.memoryDir ? ' <span class="mono" style="color:var(--ink-4)">' + e(a.memoryDir) + "</span>" : "") : "—") + "</dd>" +
          "<dt>File</dt><dd class=\"mono\">" + e(a.path) + "</dd>" +
          "<dt>Modified</dt><dd>" + when(a.mtime) + "</dd>" +
        "</dl>" +
        (hooks ? '<div class="sec">Hooks</div>' + hooks : "") +
        '<div class="sec">Prompt</div>' + bodyBlock(a.path);
      if (a.memory) {
        html += '<div class="sec">Memory · ' + (a.memoryFiles || []).length + "</div>";
        html += (a.memoryFiles && a.memoryFiles.length) ? a.memoryFiles.map(function (m, i) {
          return '<details class="mem"' + (i === 0 ? " open" : "") + "><summary>" + e(m.name) + '<span class="mono">' + kb(m.size) + " · " + when(m.mtime) + "</span></summary>" +
            '<pre class="body">' + e(m.preview) + (m.size > m.preview.length ? "\n…" : "") + "</pre></details>";
        }).join("") : '<div class="muted">No lessons saved yet. The agent writes them to its memory folder after it runs.</div>';
      }
      html += "</div>";
    } else {
      var s = skills().filter(function (x) { return x.path === K.selSkill; })[0];
      if (!s) { box.innerHTML = '<div class="op-empty"><div class="t">' + (skills().length ? "Select a skill" : "Nothing to show") + "</div></div>"; return; }
      var fs = findingsFor(s);
      html = '<div class="det"><h2>' + e(s.name) + (s.manualOnly ? '<span class="tag">manual-only</span>' : "") + (s.context === "fork" ? '<span class="tag accent">fork' + (s.agent ? " · " + e(s.agent) : "") + "</span>" : "") + auditTag(s) + "</h2>" +
        '<div class="lede">' + e(s.description || "No description") + "</div>" +
        '<dl class="facts">' +
          "<dt>Scope</dt><dd>" + e(s.scope) + (s.thirdParty ? " · third-party" : "") + "</dd>" +
          (s.argumentHint ? "<dt>Arguments</dt><dd class=\"mono\">" + e(s.argumentHint) + "</dd>" : "") +
          "<dt>Allowed tools</dt><dd class=\"mono\">" + (s.allowedTools && s.allowedTools.length ? e(s.allowedTools.join(", ")) : "—") + "</dd>" +
          (s.sideEffects ? "<dt>Side effects</dt><dd>" + e(s.sideEffects) + "</dd>" : "") +
          "<dt>Size</dt><dd>" + e(s.lines) + " lines" + (s.hasScripts ? " · scripts/" : "") + (s.hasReferences ? " · references/" : "") + "</dd>" +
          "<dt>File</dt><dd class=\"mono\">" + e(s.path) + "</dd>" +
          (s.symlink ? "<dt>Links to</dt><dd class=\"mono\">" + e(s.symlink) + "</dd>" : "") +
          "<dt>Modified</dt><dd>" + when(s.mtime) + "</dd>" +
        "</dl>" +
        (fs.length ? '<div class="sec">Audit findings</div>' + fs.map(function (f) {
          return '<div class="find"><span class="tag ' + (f.level === "fail" ? "fail" : "warn") + '">' + e(f.level) + "</span><span>" + e(f.message) + "</span></div>";
        }).join("") : "") +
        '<div class="sec">SKILL.md</div>' + bodyBlock(s.path) + "</div>";
    }
    box.innerHTML = html;
    box.scrollTop = top;
  }

  window.OP_VIEWS["kit"] = {
    build: function (host, ctx) {
      injectCSS();
      K.ctx = ctx;
      host.innerHTML = '<div class="ins op-kit"><div class="kit-top"></div><div class="kit-body"></div></div>';
      K.host = host.firstChild;
      K.files = {}; K.fileErr = {}; // re-read bodies each time the page opens
      paintAll();
      load();
      loadAudit();
    },
    // static inventory: nothing to refresh on the 2s state poll
    render: function (state, ctx) { K.ctx = ctx || K.ctx; }
  };
})();
