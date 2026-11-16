/* operator-loops.js — Loops view (window.OP_VIEWS["loops"]).
   Every unattended Claude loop on this Mac (<repo>/.loop/<name>/, made by the
   /loop-spec skill): a list on the left, the selected loop's goal, tasks, stats,
   progress and runner log on the right, plus Start/Stop of its runner. A second
   tab lists the most recent passes across all loops.

   Server shapes (see loops.go):
     GET  /api/loops            -> {loops:[loopInfo], recent:[pass], tmuxAvailable, runnerInstalled}
     GET  /api/loops/log?repo=&name= -> {log, exists}
     POST /api/loops/start {repo,name} / POST /api/loops/stop {repo,name} -> {ok, session} */
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var POLL_MS = 5000;
  var lv = {
    host: null, ctx: null, data: null, error: null, loading: false, lastFetch: 0,
    sel: null, tab: "loops", log: "", logKey: null, logExists: false, busy: {},
    sigList: null, sigDetail: null, sigRecent: null
  };

  function unwrap(r) { return (r && r.data !== undefined && r.data !== null) ? r.data : r; }
  function keyOf(l) { return l.repo + "\u0000" + l.name; }
  function selected() {
    var ls = (lv.data && lv.data.loops) || [];
    for (var i = 0; i < ls.length; i++) if (keyOf(ls[i]) === lv.sel) return ls[i];
    return null;
  }

  function injectCSS() {
    if (document.getElementById("op-loops-css")) return;
    var s = document.createElement("style");
    s.id = "op-loops-css";
    s.textContent = [
      ".op-loops{display:flex;flex-direction:column;overflow:hidden}",
      ".op-loops .lp-head{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex:none;min-height:30px}",
      ".op-loops .lp-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}",
      ".op-loops .lp-tab{height:26px;padding:0 12px;border-radius:var(--radius-sm);font-size:12px;color:var(--ink-3);background:none;border:none;cursor:pointer}",
      ".op-loops .lp-tab.on{background:var(--surface-3);color:var(--ink)}",
      ".op-loops .lp-head .meta{margin-left:auto;font-size:12px;color:var(--ink-3);font-family:var(--mono)}",
      ".op-loops .lp-body{flex:1;min-height:0;display:grid;grid-template-columns:320px minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:16px}",
      ".op-loops .lp-list{overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}",
      ".op-loops .lp-item{display:block;width:100%;text-align:left;padding:12px 14px;border:none;border-bottom:1px solid var(--line);background:none;cursor:pointer;color:var(--ink-2)}",
      ".op-loops .lp-item:last-child{border-bottom:none}",
      ".op-loops .lp-item:hover{background:var(--surface-2)}",
      ".op-loops .lp-item.on{background:var(--coral-soft)}",
      ".op-loops .lp-item .r1{display:flex;align-items:center;gap:8px;font-weight:500;color:var(--ink);font-size:13px}",
      ".op-loops .lp-item .r1 .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-loops .lp-item .r1 .ago{margin-left:auto;font-size:11px;color:var(--ink-4);font-family:var(--mono);font-weight:400;flex:none}",
      ".op-loops .lp-item .r2{font-size:11.5px;color:var(--ink-3);font-family:var(--mono);margin:3px 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-loops .lp-item .r3{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ink-3);font-family:var(--mono)}",
      ".op-loops .dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--ink-4)}",
      ".op-loops .dot.running{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}",
      ".op-loops .dot.done{background:var(--ok)}",
      ".op-loops .dot.needs-you{background:var(--waiting)}",
      ".op-loops .bar{flex:1;height:5px;border-radius:999px;background:var(--surface-3);overflow:hidden}",
      ".op-loops .bar i{display:block;height:100%;background:var(--ok);border-radius:999px}",
      ".op-loops .lp-detail{overflow:auto;min-width:0;padding-right:4px}",
      ".op-loops .lp-dh{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}",
      ".op-loops .lp-dh h2{font-size:18px;font-weight:600;color:var(--ink);margin:0 0 4px}",
      ".op-loops .lp-dh .sub{font-size:12px;color:var(--ink-3);font-family:var(--mono);word-break:break-all}",
      ".op-loops .lp-dh .act{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}",
      ".op-loops .lp-dh .act .why{font-size:11px;color:var(--ink-4);max-width:260px;text-align:right}",
      ".op-loops .lp-goal{font-size:13.5px;line-height:1.55;color:var(--ink-2);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);padding:12px 14px;margin-bottom:14px}",
      ".op-loops .lp-warn{font-size:12px;color:var(--waiting);background:var(--waiting-soft);border-radius:var(--radius);padding:8px 12px;margin-bottom:12px}",
      ".op-loops .lp-err{color:var(--danger);background:var(--danger-soft)}",
      ".op-loops .lp-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:14px}",
      ".op-loops .lp-stats > div{background:var(--surface);padding:10px 12px;min-width:0}",
      ".op-loops .lp-stats .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4)}",
      ".op-loops .lp-stats .v{font-size:17px;font-weight:600;color:var(--ink);font-family:var(--mono);font-variant-numeric:tabular-nums;margin-top:3px}",
      ".op-loops .lp-stats .n{font-size:10.5px;color:var(--ink-4);margin-top:2px}",
      ".op-loops .tw{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);overflow:auto;margin-bottom:14px}",
      ".op-loops .tw.fill{flex:1;min-height:0;margin-bottom:0}",
      ".op-loops table{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".op-loops thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;padding:9px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2);white-space:nowrap;z-index:1}",
      ".op-loops tbody td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-2)}",
      ".op-loops tbody tr:last-child td{border-bottom:none}",
      ".op-loops .m{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".op-loops .note{display:block;font-size:11.5px;color:var(--waiting);margin-top:3px}",
      ".op-loops .lp-panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}",
      ".op-loops .lp-pane .ov-sec-label{margin-top:0}",
      ".op-loops pre{margin:0;font-family:var(--mono);font-size:11.5px;line-height:1.5;color:var(--ink-2);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);padding:10px 12px;height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word}",
      ".op-loops pre.empty{color:var(--ink-4)}",
      ".op-loops .lp-recent{display:flex;flex-direction:column;flex:1;min-height:0}",
      ".op-loops .ok{color:var(--ok)}",
      ".op-loops .bad{color:var(--danger)}",
      ".op-loops .op-empty .h{max-width:520px;line-height:1.6;font-family:var(--sans)}",
      ".op-loops .op-empty code{font-family:var(--mono);color:var(--ink-2)}",
      "@media (max-width:1100px){.op-loops .lp-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.op-loops .lp-panes{grid-template-columns:minmax(0,1fr)}}"
    ].join("");
    document.head.appendChild(s);
  }

  // ---- data ------------------------------------------------------------------
  function fetchLoops(force) {
    if (lv.loading) return;
    if (!force && Date.now() - lv.lastFetch < POLL_MS) return;
    lv.loading = true; lv.lastFetch = Date.now();
    fetch("/api/loops", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (r) {
        lv.data = unwrap(r) || { loops: [], recent: [] };
        lv.error = null;
        var ls = lv.data.loops || [];
        if (!selected() && ls.length) {
          var pick = ls.filter(function (l) { return l.running; })[0] || ls.slice().sort(function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); })[0];
          lv.sel = keyOf(pick);
        }
        fetchLog();
      })
      .catch(function (e) { lv.error = (e && e.message) || "load failed"; })
      .then(function () { lv.loading = false; paint(); });
  }

  function fetchLog() {
    var l = selected(); if (!l) return;
    var k = keyOf(l);
    fetch("/api/loops/log?repo=" + encodeURIComponent(l.repo) + "&name=" + encodeURIComponent(l.name), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (r) {
        if (lv.sel !== k) return;
        var j = unwrap(r) || {};
        lv.log = j.log || ""; lv.logExists = !!j.exists; lv.logKey = k;
        paintDetail();
      })
      .catch(function () { if (lv.sel === k) { lv.log = ""; lv.logExists = false; lv.logKey = k; paintDetail(); } });
  }

  function post(path, l) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: l.repo, name: l.name }) })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = {}; try { j = JSON.parse(t); } catch (e) {}
          if (!r.ok) {
            var msg = (j.error && (j.error.message || j.error)) || j.message || t || ("HTTP " + r.status);
            throw new Error(typeof msg === "string" ? msg : "HTTP " + r.status);
          }
          return unwrap(j);
        });
      });
  }

  function startLoop(l) {
    var msg = "Start loop \"" + l.name + "\"?\n\n" +
      "Repo: " + l.repoName + " (" + l.repo + ")\nBranch: " + l.branch + "\n\n" +
      "This runs Claude unattended — one fresh `claude -p` session per task — until every task passes, the budget runs out, or 3 passes in a row make no progress. " +
      "Each passing task is committed locally on " + l.branch + ". It never pushes.";
    if (!window.confirm(msg)) return;
    var k = keyOf(l); lv.busy[k] = "starting"; paintDetail();
    post("/api/loops/start", l)
      .then(function () { lv.ctx.toast("Loop " + l.name + " started", "ok"); })
      .catch(function (e) { lv.ctx.toast("Start failed: " + e.message, "err"); })
      .then(function () { delete lv.busy[k]; fetchLoops(true); });
  }

  function stopLoop(l) {
    if (!window.confirm("Stop the runner for loop \"" + l.name + "\" in " + l.repoName + "?\n\nThe pass in progress is killed; work it already committed stays.")) return;
    var k = keyOf(l); lv.busy[k] = "stopping"; paintDetail();
    post("/api/loops/stop", l)
      .then(function () { lv.ctx.toast("Loop " + l.name + " stopped", "ok"); })
      .catch(function (e) { lv.ctx.toast("Stop failed: " + e.message, "err"); })
      .then(function () { delete lv.busy[k]; fetchLoops(true); });
  }

  // ---- paint -------------------------------------------------------------------
  function paint() {
    var host = lv.host, c = lv.ctx; if (!host || !c) return;
    var d = lv.data;
    if (!d) {
      host.innerHTML = '<div class="op-empty">' + c.icon.loop + '<div class="t">' + (lv.error ? "Couldn't load loops" : "Looking for loops…") + '</div>' + (lv.error ? '<div class="h">' + c.esc(lv.error) + "</div>" : "") + "</div>";
      lv.sigList = lv.sigDetail = lv.sigRecent = null;
      return;
    }
    if (!host.querySelector(".lp-head")) {
      host.innerHTML =
        '<div class="lp-head">' +
          '<div class="lp-tabs"><button class="lp-tab" data-tab="loops">Loops</button><button class="lp-tab" data-tab="recent">Recent passes</button></div>' +
          '<span class="meta"></span>' +
        "</div>" +
        '<div class="lp-main" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';
      host.querySelectorAll(".lp-tab").forEach(function (b) {
        b.addEventListener("click", function () { lv.tab = b.dataset.tab; lv.sigList = lv.sigDetail = lv.sigRecent = null; paint(); });
      });
    }
    host.querySelectorAll(".lp-tab").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === lv.tab); });
    var ls = d.loops || [];
    var running = ls.filter(function (l) { return l.running; }).length;
    host.querySelector(".lp-head .meta").textContent = ls.length + " loop" + (ls.length === 1 ? "" : "s") + (running ? " · " + running + " running" : "") + (lv.error ? " · refresh failed" : "");

    var main = host.querySelector(".lp-main");
    if (lv.tab === "recent") { paintRecent(main); return; }
    if (!ls.length) {
      lv.sigList = lv.sigDetail = lv.sigRecent = null;
      main.innerHTML = '<div class="op-empty">' + c.icon.loop +
        '<div class="t">No loops on this Mac yet</div>' +
        '<div class="h">A loop is a task list Claude works through unattended: one fresh session per task, gate before each task is marked passed, a local commit after each. ' +
        "Run <code>/loop-spec &lt;name&gt; &lt;goal&gt;</code> in a Claude session inside a repo on a feature branch — it writes <code>.loop/&lt;name&gt;/</code> (spec, tasks, budget, progress) and the loop shows up here, ready to start." +
        (d.runnerInstalled ? "" : "<br><br>The loop runner script isn't installed (<code>~/.claude/skills/loop-spec/scripts/loop-run.sh</code>).") +
        "</div></div>";
      return;
    }
    if (!main.querySelector(".lp-body")) {
      main.innerHTML = '<div class="lp-body"><div class="lp-list"></div><div class="lp-detail"></div></div>';
      lv.sigList = lv.sigDetail = null;
    }
    paintList();
    paintDetail();
  }

  function paintList() {
    var c = lv.ctx, box = lv.host && lv.host.querySelector(".lp-list"); if (!box) return;
    var ls = (lv.data && lv.data.loops) || [];
    var sig = JSON.stringify([lv.sel, Math.floor(c.now() / 30000), ls.map(function (l) { return [l.repo, l.name, l.branch, l.passing, l.total, l.status, l.lastActivity]; })]);
    if (sig === lv.sigList) return;
    lv.sigList = sig;
    var top = box.scrollTop;
    box.innerHTML = ls.map(function (l) {
      var pct = l.total ? Math.round(100 * l.passing / l.total) : 0;
      return '<button class="lp-item' + (keyOf(l) === lv.sel ? " on" : "") + '" data-k="' + c.esc(keyOf(l)) + '">' +
        '<div class="r1"><span class="dot ' + c.esc(l.status) + '" title="' + c.esc(l.status) + '"></span><span class="nm">' + c.esc(l.name) + '</span><span class="ago">' + (l.lastActivity ? c.esc(c.ago(l.lastActivity, c.now())) + " ago" : "—") + "</span></div>" +
        '<div class="r2" title="' + c.esc(l.repo) + '">' + c.esc(l.repoName) + " · " + c.esc(l.branch || "detached") + "</div>" +
        '<div class="r3"><span class="bar"><i style="width:' + pct + '%"></i></span><span>' + l.passing + "/" + l.total + "</span></div>" +
      "</button>";
    }).join("");
    box.scrollTop = top;
    box.querySelectorAll(".lp-item").forEach(function (b) {
      b.addEventListener("click", function () {
        if (lv.sel === b.dataset.k) return;
        lv.sel = b.dataset.k; lv.log = ""; lv.logKey = null;
        var det = lv.host.querySelector(".lp-detail"); if (det) det.scrollTop = 0;
        paintList(); paintDetail(); fetchLog();
      });
    });
  }

  function chip(t) {
    if (t.passes) return '<span class="pill done">passed</span>';
    if (t.needsUser) return '<span class="pill waiting">needs you</span>';
    return '<span class="pill idle">open</span>';
  }

  function fmtMin(m) { if (!m) return "0m"; if (m < 60) return Math.round(m) + "m"; return Math.floor(m / 60) + "h " + Math.round(m % 60) + "m"; }

  function paintDetail() {
    var c = lv.ctx, box = lv.host && lv.host.querySelector(".lp-detail"); if (!box) return;
    var l = selected();
    if (!l) { box.innerHTML = '<div class="op-empty"><div class="t">Select a loop</div></div>'; lv.sigDetail = null; return; }
    var k = keyOf(l);
    var tmuxOK = lv.data.tmuxAvailable, runnerOK = lv.data.runnerInstalled;
    var busy = lv.busy[k];
    var sig = JSON.stringify([l, lv.logKey === k ? lv.log : null, busy, tmuxOK, runnerOK]);
    if (sig === lv.sigDetail) return;
    lv.sigDetail = sig;

    // keep scroll positions across the poll repaint
    var keep = { d: box.scrollTop };
    box.querySelectorAll("pre[data-p]").forEach(function (p) {
      keep[p.dataset.p] = { top: p.scrollTop, atEnd: p.scrollTop + p.clientHeight >= p.scrollHeight - 4 };
    });

    var act = "", why = "";
    if (l.running && l.runner === "rook") {
      act = '<button class="btn sm danger" data-act="stop"' + (busy ? " disabled" : "") + ">" + c.icon.stop + (busy === "stopping" ? "Stopping…" : "Stop") + "</button>";
    } else if (l.running) {
      act = '<button class="btn sm" disabled>' + c.icon.stop + "Stop</button>";
      why = "Running outside rook — stop it where it was started.";
    } else {
      var block = !tmuxOK ? "tmux isn't installed." : !runnerOK ? "The loop runner script isn't installed." :
        l.protectedBranch ? "On " + (l.branch || "a detached HEAD") + " — switch to a feature/ or fix/ branch to run it." :
        !l.total ? "tasks.json has no tasks." : "";
      act = '<button class="btn sm primary" data-act="start"' + (block || busy ? " disabled" : "") + ">" + c.icon.resume + (busy === "starting" ? "Starting…" : "Start") + "</button>";
      why = block;
    }
    var statusLabel = { running: "running", done: "done", "needs-you": "needs you", idle: "idle" }[l.status] || l.status;
    var pillCls = { running: "busy", done: "done", "needs-you": "waiting", idle: "idle" }[l.status] || "idle";

    var m = l.metrics || {};
    var stats = [
      ["Passes", m.passes || 0, m.tasksPassed ? m.tasksPassed + " task" + (m.tasksPassed === 1 ? "" : "s") + " passed" : ""],
      ["First-try", m.tried ? Math.round(100 * m.firstTryRate) + "%" : "—", m.tried ? m.firstTry + " of " + m.tried + " tasks" : ""],
      ["Wasted", m.wasted || 0, "passes, no progress"],
      ["Denials", m.denials || 0, (m.errors ? m.errors + " error" + (m.errors === 1 ? "" : "s") : "permission")],
      ["Time", fmtMin(m.minutes), ""],
      ["Notional cost", c.fmtUSD(m.costUsd || 0), "plan usage, not billed"]
    ].map(function (s) { return '<div><div class="k">' + s[0] + '</div><div class="v">' + c.esc(s[1]) + '</div><div class="n">' + c.esc(s[2]) + "</div></div>"; }).join("");

    var budget = "";
    if (l.budget) {
      var b = l.budget;
      var parts = [];
      // budget.json comes from the repo as-is: only finite numbers are shown.
      var num = function (v) { var n = Number(v); return isFinite(n) && v !== null && v !== "" ? String(n) : null; };
      if (num(b.max_iters) != null) parts.push(num(b.max_iters) + " passes");
      if (num(b.max_minutes) != null) parts.push(num(b.max_minutes) + " min");
      if (num(b.max_attempts) != null) parts.push(num(b.max_attempts) + " attempts/task");
      if (parts.length) budget = " · budget " + parts.join(", ");
    }

    var tasks = (l.tasks || []).map(function (t) {
      return "<tr><td class=\"m\">" + c.esc(t.id) + "</td><td>" + c.esc(t.desc) + (t.needsUser && t.needsUser !== "yes" ? '<span class="note">' + c.esc(t.needsUser) + "</span>" : "") + "</td><td>" + chip(t) + '</td><td class="m">' + (t.attempts || 0) + "</td></tr>";
    }).join("");

    var logText = lv.logKey === k ? lv.log : null;
    box.innerHTML =
      '<div class="lp-dh"><div style="min-width:0">' +
        '<h2>' + c.esc(l.name) + ' <span class="pill ' + pillCls + '" style="vertical-align:middle">' + c.esc(statusLabel) + "</span></h2>" +
        '<div class="sub">' + c.esc(l.repo) + " · " + c.esc(l.branch || "detached HEAD") + budget + "</div>" +
      '</div><div class="act">' + act + (why ? '<div class="why">' + c.esc(why) + "</div>" : "") + "</div></div>" +
      (l.error ? '<div class="lp-warn lp-err">' + c.esc(l.error) + "</div>" : "") +
      (l.exited ? '<div class="lp-warn">Runner finished (exit ' + c.esc(l.exitCode) + ")" + (l.runnerOutput ? ": " + c.esc(lastLine(l.runnerOutput)) : "") + "</div>" : "") +
      '<div class="lp-goal">' + (l.goal ? c.esc(l.goal) : '<span style="color:var(--ink-4)">No goal found under “## Goal” in spec.md.</span>') + "</div>" +
      '<div class="lp-stats">' + stats + "</div>" +
      '<div class="ov-sec-label" style="margin-top:0">Tasks · ' + l.passing + "/" + l.total + " passing" + (l.needsUser ? " · " + l.needsUser + " need you" : "") + "</div>" +
      (tasks ? '<div class="tw"><table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Attempts</th></tr></thead><tbody>' + tasks + "</tbody></table></div>"
             : '<div class="lp-goal" style="color:var(--ink-4)">tasks.json has no tasks.</div>') +
      '<div class="lp-panes">' +
        '<div class="lp-pane"><div class="ov-sec-label">progress.md · last 40 lines</div><pre data-p="progress"' + (l.progressTail ? "" : ' class="empty"') + ">" + c.esc(l.progressTail || "No progress logged yet.") + "</pre></div>" +
        '<div class="lp-pane"><div class="ov-sec-label">runner.log · last 200 lines</div><pre data-p="log"' + (logText ? "" : ' class="empty"') + ">" +
          c.esc(logText == null ? "Loading…" : (logText || (lv.logExists ? "runner.log is empty." : "The runner hasn't run yet."))) + "</pre></div>" +
      "</div>";

    box.scrollTop = keep.d;
    box.querySelectorAll("pre[data-p]").forEach(function (p) {
      var s = keep[p.dataset.p];
      p.scrollTop = (!s || s.atEnd) ? p.scrollHeight : s.top;
    });
    var bs = box.querySelector('[data-act="start"]'); if (bs) bs.addEventListener("click", function () { startLoop(l); });
    var bt = box.querySelector('[data-act="stop"]'); if (bt) bt.addEventListener("click", function () { stopLoop(l); });
  }

  function lastLine(s) { var a = String(s).trim().split("\n"); return a[a.length - 1]; }

  function paintRecent(main) {
    var c = lv.ctx, rs = (lv.data && lv.data.recent) || [];
    var sig = JSON.stringify(rs.length ? [rs[0].at, rs.length, Math.floor(c.now() / 30000)] : []);
    if (sig === lv.sigRecent && main.querySelector(".lp-recent, .op-empty")) return;
    lv.sigRecent = sig; lv.sigList = lv.sigDetail = null;
    if (!rs.length) {
      main.innerHTML = '<div class="op-empty">' + c.icon.loop + '<div class="t">No loop passes logged yet</div><div class="h">Each pass of a running loop appends a line to <code>~/.claude/state/loops.jsonl</code>; the last 50 show here.</div></div>';
      return;
    }
    var rows = rs.map(function (p) {
      var t = Date.parse(p.at);
      var prog = p.passing_after > p.passing_before;
      var bad = p.is_error || p.exit_code !== 0;
      return "<tr><td class=\"m\" title=\"" + c.esc(p.at) + "\">" + (isNaN(t) ? c.esc(p.at || "—") : c.esc(c.ago(t, c.now())) + " ago") + "</td>" +
        "<td>" + c.esc(p.loop) + '</td><td class="m" title="' + c.esc(p.repo) + '">' + c.esc(String(p.repo || "").split("/").pop()) + "</td>" +
        '<td class="m">' + c.esc(p.branch || "—") + '</td><td class="m">' + c.esc(p.pass) + '</td><td class="m">' + c.esc(p.task || "—") + "</td>" +
        '<td class="m ' + (prog ? "ok" : "") + '">' + c.esc(p.passing_before) + "→" + c.esc(p.passing_after) + "/" + c.esc(p.total) + "</td>" +
        '<td class="m">' + fmtMin((p.seconds || 0) / 60) + '</td><td class="m">' + c.esc(p.turns || 0) + '</td><td class="m">' + c.esc(p.permission_denials || 0) + "</td>" +
        '<td class="m">' + c.fmtUSD(p.cost_usd || 0) + '</td><td class="m ' + (bad ? "bad" : "") + '">' + (bad ? "error" + (p.exit_code ? " (" + c.esc(p.exit_code) + ")" : "") : "ok") + "</td></tr>";
    }).join("");
    var prev = main.querySelector(".tw"); var top = prev ? prev.scrollTop : 0;
    main.innerHTML = '<div class="lp-recent"><div class="tw fill"><table><thead><tr><th>When</th><th>Loop</th><th>Repo</th><th>Branch</th><th>Pass</th><th>Task</th><th>Passing</th><th>Time</th><th>Turns</th><th>Denials</th><th>Cost*</th><th>Result</th></tr></thead><tbody>' + rows +
      '</tbody></table></div><div style="font-size:11px;color:var(--ink-4);margin-top:8px;flex:none">* notional cost: plan usage, not billed.</div></div>';
    var w = main.querySelector(".tw"); if (w) w.scrollTop = top;
  }

  window.OP_VIEWS["loops"] = {
    build: function (host, ctx) {
      injectCSS(); lv.ctx = ctx;
      host.innerHTML = '<div class="ins op-loops"></div>'; lv.host = host.firstChild;
      lv.sigList = lv.sigDetail = lv.sigRecent = null;
      paint(); fetchLoops(true);
    },
    render: function (state, ctx) {
      lv.ctx = ctx || lv.ctx;
      if (!lv.host || !lv.host.isConnected) return;
      fetchLoops(false);
      paint();
    }
  };
})();
