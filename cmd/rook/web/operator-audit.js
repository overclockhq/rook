/* operator-audit.js — Operator "Audit" plug-in view (window.OP_VIEWS["audit"]).

   A dense, filterable command-audit TABLE served by GET /api/audit-history
   (Go: handleAuditHistory). That endpoint returns the persisted Bash/Shell
   commands every agent ran, newest first, capped at 500, optionally filtered
   server-side by ?q=<substring>. Records are AuditCmd:

     { "session": "<id>", "project": "<name>",
       "provider": "claude|…", "cmd": "<command>", "ts": <unix millis> }

   The response is a BARE JSON array; (j.data || j) is handled defensively in
   case a {data:…} envelope is ever added upstream. No cost/savings fields
   exist on this data — this is an audit TRAIL, not a cost dashboard.

   Layout mirrors operator-dev.js: a fixed-height flex column that never lets
   the page scroll — the header (stat tiles + filter bar) is flex:none and the
   table body scrolls in place under a sticky <thead>.

   Decision: search is server-side, provider/project filters are client-side.
   Context: the endpoint only accepts ?q= (a cmd LIKE match); provider/project
            are already present on every loaded row.
   Choice: debounce the search box into ?q= round-trips; filter provider/project
           over the loaded rows without refetching.
   Reason: instant provider/project filtering with no network cost, and one
           server-side text filter that matches the endpoint's only knob.

   Decision: render()'s 2s poll skips refetch while a filter control is focused.
   Context: operator.js calls build() once then render(state,ctx) every 2s.
   Choice: paint() only ever replaces the <tbody> (never the search input, the
           selects, or the scroll container), and the poll refetch is suppressed
           whenever focus is inside the filter bar.
   Reason: preserves the caret/value in the search box, an open <select>, and
           the table scroll position across the live refresh. */
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  // Danger heuristics — kept small and conservative. Each match tags a row as
  // "risky" and explains why in a title/tooltip. This is advisory only.
  var DANGER = [
    { re: /\brm\s+-\S*[rf]/, why: "recursive/forced delete (rm -rf)" },
    { re: /\bgit\s+push\b[\s\S]*--force/, why: "force push" },
    { re: /\bdrop\s+(table|database)\b/i, why: "SQL DROP" },
    { re: /\btruncate\b/i, why: "SQL/FS truncate" },
    { re: /:\s*>\s*\/dev\/sd/, why: "overwrite raw disk" },
    { re: /\bmkfs\b/, why: "format filesystem" },
    { re: /\bchmod\s+-R\s+777\b/, why: "world-writable recursive chmod" },
    { re: />\s*\/etc\//, why: "write into /etc" },
    { re: /\bkill(all)?\s+-9\b/, why: "force kill (-9)" }
  ];
  function riskOf(cmd) {
    var hits = [], s = cmd || "";
    for (var i = 0; i < DANGER.length; i++) if (DANGER[i].re.test(s)) hits.push(DANGER[i].why);
    return hits;
  }

  // View-local state (survives the 2s poll; the shell DOM is built once).
  var A = {
    ctx: null,
    root: null,      // .op-audit inner wrapper — presence test = still mounted
    statsEl: null,   // stat-tile row host
    searchEl: null,  // search <input> — created once, never rebuilt
    provSel: null,   // provider <select>
    projSel: null,   // project <select>
    countEl: null,   // "N of M" filter summary
    wrap: null,      // .tablewrap scroll container
    body: null,      // <tbody> — the only thing paint() rewrites
    msgEl: null,     // loading / empty / error overlay
    rows: [],        // latest rows from the endpoint (server ?q= applied)
    view: [],        // rows after client-side provider/project filter
    query: "",       // current server-side ?q filter
    filterSig: "",   // signature of the select option sets (rebuild guard)
    loadedOnce: false,
    errored: false,
    fetching: false
  };

  function injectCSS() {
    if (document.getElementById("op-audit-css")) return;
    var s = document.createElement("style");
    s.id = "op-audit-css";
    s.textContent = [
      ".op-audit{display:flex;flex-direction:column;overflow:hidden}",
      ".op-audit .aud-top{flex:none;display:flex;flex-direction:column;gap:12px;margin-bottom:12px}",
      ".op-audit .aud-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}",
      "@media(max-width:760px){.op-audit .aud-stats{grid-template-columns:repeat(2,1fr)}}",
      ".op-audit .aud-stats .ins-win{padding:10px 13px}",
      ".op-audit .aud-stats .ins-win-val{font-size:21px;margin:4px 0 1px}",
      ".op-audit .aud-stats .ins-win.risk .ins-win-val{color:var(--danger)}",
      ".op-audit .aud-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".op-audit .aud-search{display:flex;align-items:center;gap:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);height:32px;padding:0 11px;min-width:240px;flex:1 1 260px}",
      ".op-audit .aud-search:focus-within{border-color:var(--line-2)}",
      ".op-audit .aud-search svg{width:15px;height:15px;color:var(--ink-3);flex:none}",
      ".op-audit .aud-search input{background:transparent;border:0;outline:none;color:var(--ink);font:inherit;font-family:var(--sans);font-size:12.5px;width:100%}",
      ".op-audit .aud-search input::placeholder{color:var(--ink-4)}",
      ".op-audit select.aud-sel{height:32px;border-radius:var(--radius);border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);font-family:var(--sans);font-size:12.5px;padding:0 8px;outline:none;cursor:pointer}",
      ".op-audit select.aud-sel:hover{border-color:var(--line-2);color:var(--ink)}",
      ".op-audit .aud-count{margin-left:auto;font-size:12px;color:var(--ink-3);font-family:var(--mono);white-space:nowrap}",
      ".op-audit .tablewrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);position:relative}",
      ".op-audit table{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed}",
      ".op-audit thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2);white-space:nowrap;z-index:1}",
      ".op-audit tbody td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:middle;color:var(--ink-2)}",
      ".op-audit tbody tr:last-child td{border-bottom:none}",
      ".op-audit tbody tr{cursor:pointer;transition:background .12s}",
      ".op-audit tbody tr:hover{background:var(--surface-2)}",
      ".op-audit tbody tr.risky{box-shadow:inset 3px 0 0 var(--danger)}",
      ".op-audit .m{font-family:var(--mono);font-variant-numeric:tabular-nums}",
      ".op-audit th.flag,.op-audit td.flag{width:22px;text-align:center;padding-left:10px;padding-right:0}",
      ".op-audit .aud-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--danger)}",
      ".op-audit th.time,.op-audit td.time{width:74px;white-space:nowrap;color:var(--ink-3);font-size:11.5px}",
      ".op-audit th.agent,.op-audit td.agent{width:180px;white-space:nowrap}",
      ".op-audit td.agent .sess{margin-left:8px;font-family:var(--mono);font-size:10.5px;color:var(--ink-4)}",
      ".op-audit th.proj,.op-audit td.proj{width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)}",
      ".op-audit td.cmd{max-width:0;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-family:var(--mono);font-size:11.5px}",
      ".op-audit td.cmd .rf{color:var(--danger);font-weight:600;margin-right:6px}",
      ".op-audit td.cmd .aud-tool{color:var(--busy);border:1px solid currentColor;border-radius:4px;padding:0 4px;font-size:10px;font-weight:600}",
      ".op-audit th.act,.op-audit td.act{width:112px;text-align:right;white-space:nowrap}",
      ".op-audit td.act .row-act{display:inline-flex;gap:6px;justify-content:flex-end}",
      ".op-audit .aud-msg{position:absolute;inset:0;display:grid;place-items:center}"
    ].join("");
    document.head.appendChild(s);
  }

  function esc(v) { return A.ctx.esc(v == null ? "" : v); }
  function shortSess(s) { s = s || ""; return s.length > 8 ? s.slice(0, 8) : s; }

  // ---- fetch ---------------------------------------------------------------
  // The only network path. Guarded so overlapping 2s polls collapse into one
  // request; repaints on completion.
  function load() {
    if (A.fetching) return;
    A.fetching = true;
    var url = "/api/audit-history" + (A.query ? "?q=" + encodeURIComponent(A.query) : "");
    fetch(url, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) {
        var d = (j && j.data != null) ? j.data : j; // {data:…} or bare array
        A.rows = Array.isArray(d) ? d : [];
        A.errored = false;
      })
      .catch(function () { A.errored = true; })
      .then(function () { A.fetching = false; A.loadedOnce = true; paint(); });
  }

  // ---- derived data --------------------------------------------------------
  function distinctVals(field) {
    var seen = {}, out = [];
    for (var i = 0; i < A.rows.length; i++) {
      var v = A.rows[i][field];
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    out.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    return out;
  }
  function distinctCount(list, field) {
    var seen = {}, n = 0;
    for (var i = 0; i < list.length; i++) {
      var v = list[i][field];
      if (v && !seen[v]) { seen[v] = 1; n++; }
    }
    return n;
  }
  function computeView() {
    var p = A.provSel ? A.provSel.value : "";
    var pj = A.projSel ? A.projSel.value : "";
    A.view = A.rows.filter(function (r) {
      if (p && (r.provider || "") !== p) return false;
      if (pj && (r.project || "") !== pj) return false;
      return true;
    });
  }

  // ---- shell (built once) --------------------------------------------------
  function build(host, ctx) {
    A.ctx = ctx;
    injectCSS();
    host.innerHTML = '<div class="ins op-audit"></div>';
    A.root = host.firstChild;

    var top = ctx.el("div", "aud-top");
    A.statsEl = ctx.el("div", "aud-stats");

    var filters = ctx.el("div", "aud-filters");
    filters.innerHTML =
      '<label class="aud-search">' + ctx.icon.search +
        '<input type="text" id="audSearch" placeholder="Filter commands…" spellcheck="false" autocomplete="off" />' +
      "</label>" +
      '<select class="aud-sel" id="audProv"><option value="">All agents</option></select>' +
      '<select class="aud-sel" id="audProj"><option value="">All projects</option></select>' +
      '<span class="aud-count" id="audCount"></span>';

    top.appendChild(A.statsEl);
    top.appendChild(filters);
    A.root.appendChild(top);

    A.wrap = ctx.el("div", "tablewrap");
    A.wrap.innerHTML =
      "<table><thead><tr>" +
        '<th class="flag"></th>' +
        '<th class="time">Time</th>' +
        '<th class="agent">Agent</th>' +
        '<th class="proj">Project</th>' +
        "<th>Command</th>" +
        '<th class="act"></th>' +
      "</tr></thead><tbody></tbody></table>" +
      '<div class="aud-msg"></div>';
    A.root.appendChild(A.wrap);

    A.body = A.wrap.querySelector("tbody");
    A.msgEl = A.wrap.querySelector(".aud-msg");
    A.searchEl = filters.querySelector("#audSearch");
    A.provSel = filters.querySelector("#audProv");
    A.projSel = filters.querySelector("#audProj");
    A.countEl = filters.querySelector("#audCount");
    A.searchEl.value = A.query;

    var t = null;
    A.searchEl.addEventListener("input", function () {
      A.query = A.searchEl.value.trim();
      clearTimeout(t);
      t = setTimeout(load, 200); // debounce so each keystroke isn't a round-trip
    });
    A.provSel.addEventListener("change", paint); // client-side, no refetch
    A.projSel.addEventListener("change", paint);

    showMsg(ctx.icon.review, "Loading audit trail…", "");
  }

  function showMsg(icon, title, hint) {
    A.body.innerHTML = "";
    A.msgEl.style.display = "";
    A.msgEl.innerHTML = '<div class="op-empty">' + icon +
      '<div class="t">' + esc(title) + "</div>" +
      (hint ? '<div class="h">' + hint + "</div>" : "") + "</div>";
  }

  // ---- paint (idempotent; only rewrites <tbody> + header text) -------------
  function paint() {
    var ctx = A.ctx;
    if (!A.root || !document.body.contains(A.root)) return;

    if (A.errored && !A.rows.length) {
      A.statsEl.innerHTML = "";
      A.countEl.textContent = "";
      showMsg(ctx.icon.alert, "Couldn't load audit data", "GET /api/audit-history failed — retrying…");
      return;
    }
    if (!A.loadedOnce) return; // keep the build() loading overlay

    syncSelects();
    computeView();

    // stat tiles reflect the currently visible (filtered) set
    var v = A.view;
    var capped = A.rows.length >= 500 && !A.query;
    var risky = 0;
    for (var i = 0; i < v.length; i++) if (riskOf(v[i].cmd).length) risky++;
    A.statsEl.innerHTML =
      tile("Commands", v.length + (capped ? "+" : ""), A.query ? "matching filter" : "in trail", false) +
      tile("Agents", String(distinctCount(v, "session")), "distinct sessions", false) +
      tile("Projects", String(distinctCount(v, "project")), "touched", false) +
      tile("Risky", String(risky), risky ? "review these" : "none flagged", risky > 0);
    A.countEl.textContent = v.length === A.rows.length
      ? v.length + " command" + (v.length === 1 ? "" : "s")
      : v.length + " of " + A.rows.length;

    if (!v.length) {
      var anyFilter = A.query || (A.provSel && A.provSel.value) || (A.projSel && A.projSel.value);
      showMsg(ctx.icon.review, "No audit data",
        anyFilter ? "No commands match the current filters" : "Agent Bash/Shell commands will appear here");
      return;
    }

    A.msgEl.style.display = "none";
    A.msgEl.innerHTML = "";
    paintRows(v);
  }

  function tile(label, val, sub, isRisk) {
    return '<div class="ins-win' + (isRisk ? " risk" : "") + '">' +
      '<div class="ins-win-label">' + esc(label) + "</div>" +
      '<div class="ins-win-val">' + esc(val) + "</div>" +
      '<div class="ins-win-sub">' + esc(sub || "") + "</div></div>";
  }

  // Rebuild the provider/project option sets only when the distinct values
  // change — otherwise a poll would reset an open dropdown / the selection.
  function syncSelects() {
    var provs = distinctVals("provider");
    var projs = distinctVals("project");
    var sig = provs.join("") + "" + projs.join("");
    if (sig === A.filterSig) return;
    A.filterSig = sig;
    fillSelect(A.provSel, provs, "All agents");
    fillSelect(A.projSel, projs, "All projects");
  }
  function fillSelect(sel, vals, allLabel) {
    var cur = sel.value;
    var html = '<option value="">' + esc(allLabel) + "</option>";
    var keep = false;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] === cur) keep = true;
      html += '<option value="' + esc(vals[i]) + '">' + esc(vals[i]) + "</option>";
    }
    sel.innerHTML = html;
    sel.value = keep ? cur : ""; // drop a selection that no longer exists
  }

  function paintRows(v) {
    var now = A.ctx.now();
    var top = A.wrap.scrollTop; // preserve scroll across the repaint
    var html = "";
    for (var i = 0; i < v.length; i++) {
      var r = v[i];
      var prov = r.provider || "claude";
      var when = r.ts ? new Date(r.ts).toLocaleString() : "unknown time";
      var reasons = riskOf(r.cmd);
      var risky = reasons.length > 0;
      var cmd = r.cmd || "";
      html +=
        '<tr class="' + (risky ? "risky" : "") + '" data-idx="' + i + '">' +
          '<td class="flag">' + (risky
            ? '<span class="aud-dot" title="Risky: ' + esc(reasons.join("; ")) + '"></span>' : "") + "</td>" +
          '<td class="time m" title="' + esc(when) + '">' + esc(A.ctx.ago(r.ts, now)) + "</td>" +
          '<td class="agent"><span class="pill idle">' + esc(prov) + "</span>" +
            (r.session ? '<span class="sess" title="' + esc(r.session) + '">' + esc(shortSess(r.session)) + "</span>" : "") + "</td>" +
          '<td class="proj" title="' + esc(r.project || "") + '">' + esc(r.project || "—") + "</td>" +
          '<td class="cmd" title="' + esc(cmd) + '">' +
            (risky ? '<span class="rf" title="' + esc(reasons.join("; ")) + '">!</span>' : "") +
            (r.tool && r.tool !== "Bash" && r.tool !== "Shell" ? '<span class="aud-tool">' + esc(r.tool) + "</span> " : "") +
            esc(cmd) + "</td>" +
          '<td class="act"><span class="row-act">' +
            '<button class="btn sm" data-act="copy" data-idx="' + i + '">Copy</button>' +
            (r.session ? '<button class="btn sm" data-act="open" data-idx="' + i + '">' + A.ctx.icon.external + "Open</button>" : "") +
          "</span></td>" +
        "</tr>";
    }
    A.body.innerHTML = html;
    A.wrap.scrollTop = top;
    wireRows(v);
  }

  function wireRows(v) {
    A.body.querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function () {
        var r = v[+tr.dataset.idx];
        if (r && r.session) A.ctx.selectAgent(r.session);
      });
    });
    A.body.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var r = v[+b.dataset.idx];
        if (!r) return;
        if (b.dataset.act === "open") { if (r.session) A.ctx.selectAgent(r.session); return; }
        var txt = r.cmd || "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(
            function () { A.ctx.toast("Command copied", "ok"); },
            function () { A.ctx.toast("Copy failed", "err"); }
          );
        } else {
          A.ctx.toast("Copy unavailable", "err");
        }
      });
    });
  }

  function filterFocused() {
    var a = document.activeElement;
    return a && (a === A.searchEl || a === A.provSel || a === A.projSel);
  }

  window.OP_VIEWS["audit"] = {
    build: function (host, ctx) { build(host, ctx); },
    // render() runs on build and every 2s poll. It only kicks the guarded
    // fetch; the poll refetch is suppressed while a filter control is focused
    // so typing / an open <select> is never interrupted. paint() (invoked when
    // the fetch resolves) is idempotent and preserves scroll + UI state.
    render: function (state, ctx) {
      A.ctx = ctx || A.ctx;
      if (!A.root || !document.body.contains(A.root)) return;
      if (filterFocused()) return;
      load();
    }
  };
})();
