/* operator-system.js — System view (window.OP_VIEWS["system"]).

   Activity Monitor already shows numbers. The numbers are what failed: a load
   average of 223 with nothing above 90% CPU reads as a contradiction until you
   notice swap is full. So this leads with a verdict in plain words and keeps the
   figures underneath as evidence.

   Server does the diagnosis (/api/system); this file renders it. */
(function () {
  "use strict";

  var S = { host: null, ctx: null, data: null, error: "", tab: "cpu", timer: null };

  function style() {
    if (document.getElementById("opSysStyle")) return;
    var el = document.createElement("style");
    el.id = "opSysStyle";
    el.textContent = [
      ".op-sys{display:flex;flex-direction:column;overflow:hidden;gap:16px;padding:20px 24px}",
      ".op-sys .sy-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px}",

      /* verdict — the one thing worth reading first */
      ".op-sys .sy-verdict{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:18px 20px}",
      ".op-sys .sy-vhead{display:flex;align-items:center;gap:10px}",
      ".op-sys .sy-dot{width:9px;height:9px;border-radius:50%;flex:none}",
      ".op-sys .sy-vsum{font-size:15px;font-weight:600;color:var(--ink)}",
      ".op-sys .sy-vage{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--ink-4)}",
      ".op-sys .sy-reason{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start;padding:13px 0;border-top:1px solid var(--line)}",
      ".op-sys .sy-reason:first-of-type{margin-top:12px}",
      ".op-sys .sy-rh{font-size:13.5px;font-weight:600;color:var(--ink)}",
      ".op-sys .sy-rd{font-size:12.5px;color:var(--ink-2);margin-top:3px;line-height:1.5}",
      ".op-sys .sy-ra{font-size:12px;color:var(--ink-4);margin-top:4px}",
      ".op-sys .sy-kill{border:1px solid var(--line);background:var(--surface-2);color:var(--danger);font:inherit;font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}",
      ".op-sys .sy-kill:hover{border-color:var(--danger)}",
      ".op-sys .sy-ok{font-size:13px;color:var(--ink-3);margin-top:10px}",

      /* gauges */
      ".op-sys .sy-gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}",
      ".op-sys .sy-g{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:14px 16px}",
      ".op-sys .sy-gk{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-4);font-weight:600}",
      ".op-sys .sy-gv{font-size:20px;font-weight:600;color:var(--ink);margin-top:5px;font-variant-numeric:tabular-nums}",
      ".op-sys .sy-gs{font-size:11.5px;color:var(--ink-4);font-family:var(--mono);margin-top:2px}",
      ".op-sys .sy-bar{height:4px;border-radius:3px;background:var(--surface-3);margin-top:9px;overflow:hidden}",
      ".op-sys .sy-bar i{display:block;height:100%;border-radius:3px;background:var(--ok)}",
      ".op-sys .sy-bar i.warn{background:var(--waiting)}",
      ".op-sys .sy-bar i.crit{background:var(--danger)}",

      /* process table — same row grammar as the pull-request board */
      ".op-sys .sy-tabs{display:flex;gap:6px}",
      ".op-sys .sy-tab{border:1px solid var(--line);background:transparent;color:var(--ink-3);font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer}",
      ".op-sys .sy-tab.on{background:var(--coral-soft);border-color:var(--coral-line);color:var(--coral)}",
      ".op-sys .sy-table{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);overflow:hidden}",
      ".op-sys .sy-row{display:grid;grid-template-columns:1fr 72px 92px 70px 64px 72px;align-items:center;gap:12px;padding:0 14px;height:34px;font-size:12.5px;color:var(--ink-2)}",
      ".op-sys .sy-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-sys .sy-row.head{height:30px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-4);font-weight:600;background:var(--surface-2);border-bottom:1px solid var(--line)}",
      ".op-sys .sy-row+.sy-row:not(.head){border-top:1px solid var(--line)}",
      ".op-sys .sy-row:not(.head):hover{background:var(--surface-2)}",
      ".op-sys .sy-name{color:var(--ink);display:flex;align-items:center;gap:7px;min-width:0}",
      ".op-sys .sy-cmd{color:var(--ink-4);font-family:var(--mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-sys .sy-tag{font-size:9px;font-weight:700;letter-spacing:.06em;padding:1px 5px;border-radius:4px;color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);border:1px solid color-mix(in srgb,var(--accent) 34%,transparent);flex:none}",
      ".op-sys .sy-n{font-family:var(--mono);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-3)}",
      ".op-sys .sy-n.hot{color:var(--danger)}",
      ".op-sys .sy-act{display:flex;justify-content:flex-end}",
      ".op-sys .sy-x{border:1px solid transparent;background:none;color:var(--ink-4);font:inherit;font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer}",
      ".op-sys .sy-row:hover .sy-x{border-color:var(--line);color:var(--ink-2)}",
      ".op-sys .sy-x:hover{color:var(--danger);border-color:var(--danger)}",
      ".op-sys .sy-sec{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-4);font-weight:600}"
    ].join("");
    document.head.appendChild(el);
  }

  function esc(v) { return S.ctx.esc(v == null ? "" : v); }

  function bytes(b) {
    b = +b || 0;
    if (b < 1024) return b + " B";
    var u = ["KB", "MB", "GB", "TB"], i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < 3);
    return b.toFixed(b >= 10 ? 0 : 1) + " " + u[i];
  }

  function dur(sec) {
    sec = +sec || 0;
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
  }

  var TONE = { ok: "var(--ok)", strained: "var(--busy)", slow: "var(--waiting)", critical: "var(--danger)" };

  function gauge(label, value, sub, pct) {
    var cls = pct >= 0.9 ? "crit" : pct >= 0.7 ? "warn" : "";
    return '<div class="sy-g"><div class="sy-gk">' + esc(label) + "</div>" +
      '<div class="sy-gv">' + esc(value) + "</div>" +
      '<div class="sy-gs">' + esc(sub) + "</div>" +
      (pct == null ? "" :
        '<div class="sy-bar"><i class="' + cls + '" style="width:' +
        Math.max(2, Math.min(100, pct * 100)).toFixed(0) + '%"></i></div>') +
      "</div>";
  }

  function verdictHTML(d) {
    var v = d.verdict || { level: "ok", summary: "", reasons: [] };
    var rows = (v.reasons || []).map(function (r) {
      return '<div class="sy-reason"><div>' +
        '<div class="sy-rh">' + esc(r.headline) + "</div>" +
        '<div class="sy-rd">' + esc(r.detail) + "</div>" +
        '<div class="sy-ra">' + esc(r.action) + "</div></div>" +
        (r.pids && r.pids.length
          ? '<button class="sy-kill" data-kill="' + r.pids.join(",") + '">Stop ' +
            (r.pids.length === 1 ? "it" : "them") + "</button>"
          : "<span></span>") +
        "</div>";
    }).join("");

    return '<section class="sy-verdict">' +
      '<div class="sy-vhead"><span class="sy-dot" style="background:' + (TONE[v.level] || TONE.ok) + '"></span>' +
      '<span class="sy-vsum">' + esc(v.summary) + "</span>" +
      '<span class="sy-vage" id="sysAge"></span></div>' +
      (rows || '<p class="sy-ok">Nothing is holding this machine back right now.</p>') +
      "</section>";
  }

  function gaugesHTML(d) {
    var loadPer = d.cores ? d.load1 / d.cores : 0;
    var memUsed = d.memTotal ? 1 - d.memFree / d.memTotal : 0;
    var swapUsed = d.swapTotal ? d.swapUsed / d.swapTotal : 0;
    return '<div class="sy-gauges">' +
      gauge("Load", (d.load1 || 0).toFixed(2),
            d.cores + " cores · " + (d.load5 || 0).toFixed(1) + " / " + (d.load15 || 0).toFixed(1) + " avg",
            loadPer / 3) +
      gauge("Memory free", bytes(d.memFree), "of " + bytes(d.memTotal), memUsed) +
      // Swap gets its own gauge because it is the figure that actually predicts
      // "this feels slow", and the one people never think to check.
      gauge("Swap used", bytes(d.swapUsed), "of " + bytes(d.swapTotal), swapUsed) +
      gauge("Agent sessions", String(d.agentCount || 0),
            bytes(d.agentRss) + (d.agentOldest ? " · oldest " + dur(d.agentOldest) : ""), null) +
      "</div>";
  }

  function procRows(d) {
    var list = (d.procs || []).slice();
    if (S.tab === "mem") list.sort(function (a, b) { return b.rss - a.rss; });
    else if (S.tab === "agents") list = list.filter(function (p) { return p.agent; });
    else list.sort(function (a, b) { return b.cpu - a.cpu; });

    if (!list.length) {
      return '<div class="sy-row"><span class="sy-cmd">Nothing to show.</span></div>';
    }
    return list.slice(0, 40).map(function (p) {
      return '<div class="sy-row">' +
        '<span class="sy-name">' + esc(p.name) +
          (p.agent ? '<span class="sy-tag">AGENT</span>' : "") +
          '<span class="sy-cmd">' + esc(p.command || "") + "</span></span>" +
        '<span class="sy-n' + (p.cpu >= 80 ? " hot" : "") + '">' + (p.cpu || 0).toFixed(0) + "%</span>" +
        '<span class="sy-n">' + bytes(p.rss) + "</span>" +
        '<span class="sy-n">' + dur(p.elapsed) + "</span>" +
        '<span class="sy-n">' + p.pid + "</span>" +
        '<span class="sy-act"><button class="sy-x" data-kill="' + p.pid + '">Stop</button></span>' +
        "</div>";
    }).join("");
  }

  function render() {
    if (!S.host) return;
    if (S.error) {
      S.host.innerHTML = '<div class="op-empty">Could not read system state: ' + esc(S.error) + "</div>";
      return;
    }
    var d = S.data;
    if (!d) { S.host.innerHTML = '<div class="op-empty">Reading system state…</div>'; return; }

    S.host.innerHTML =
      '<div class="sy-scroll">' +
        verdictHTML(d) +
        gaugesHTML(d) +
        '<div class="sy-tabs">' +
          ['cpu:By CPU', 'mem:By memory', 'agents:Agent sessions'].map(function (t) {
            var k = t.split(":")[0];
            return '<button class="sy-tab' + (S.tab === k ? " on" : "") + '" data-tab="' + k + '">' +
              esc(t.split(":")[1]) + "</button>";
          }).join("") +
        "</div>" +
        '<div class="sy-table">' +
          '<div class="sy-row head"><span>Process</span><span>CPU</span><span>Memory</span>' +
            "<span>Uptime</span><span>PID</span><span></span></div>" +
          procRows(d) +
        "</div>" +
      "</div>";
    wire();
  }

  function wire() {
    S.host.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { S.tab = b.dataset.tab; render(); });
    });
    S.host.querySelectorAll("[data-kill]").forEach(function (b) {
      b.addEventListener("click", function () { confirmKill(b.dataset.kill.split(",").map(Number)); });
    });
  }

  // Stopping something is destructive and unrecoverable, so it always names what
  // it is about to kill rather than just asking "are you sure?".
  function confirmKill(pids) {
    var procs = (S.data.procs || []).filter(function (p) { return pids.indexOf(p.pid) !== -1; });
    var what = procs.length
      ? procs.map(function (p) { return p.name + " (" + p.pid + ", " + p.cpu.toFixed(0) + "% CPU, up " + dur(p.elapsed) + ")"; }).join("\n")
      : pids.join(", ");
    if (!window.confirm("Stop:\n\n" + what + "\n\nAnything unsaved in these is lost.")) return;

    fetch("/api/system/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pids: pids })
    }).then(function (r) { return r.json(); }).then(function (res) {
      var d = res && res.data !== undefined ? res.data : res;
      S.ctx.toast((d && d.stopped ? d.stopped : 0) + " stopped", "ok");
      load();
    }).catch(function () { S.ctx.toast("Could not stop", "err"); });
  }

  async function load() {
    try {
      var r = await fetch("/api/system", { cache: "no-store" });
      var j = await r.json();
      S.data = j && j.data !== undefined ? j.data : j;
      S.error = "";
    } catch (e) {
      S.error = e.message || String(e);
    }
    render();
  }

  window.OP_VIEWS = window.OP_VIEWS || {};
  window.OP_VIEWS.system = {
    build: function (host, ctx) {
      style();
      S.ctx = ctx;
      var root = ctx.el("div", "op-sys");
      root.innerHTML = '<div class="op-empty">Reading system state…</div>';
      host.appendChild(root);
      S.host = root;
      load();
      // The sample costs a few hundred milliseconds of `ps`, so it refreshes on
      // its own slow beat rather than riding the operator's 2s agent poll.
      if (S.timer) clearInterval(S.timer);
      S.timer = setInterval(function () {
        if (S.host && S.host.isConnected) load(); else clearInterval(S.timer);
      }, 5000);
    },
    render: function () { /* driven by its own timer */ }
  };
})();
