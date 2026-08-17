/* operator-dev.js — Dev servers view (window.OP_VIEWS["dev"]).
   Dense table of running dev servers (from the polled state.devServers), with
   per-row multi-select + a "Stop selected" bulk action. Open in browser or
   stop individually. Reuses operator.css primitives; scoped extras under .op-dev. */
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var dv = { host: null, ctx: null, selected: {}, stopping: {} };
  function selSet() { return dv.selected; }

  function injectCSS() {
    if (document.getElementById("op-dev-css")) return;
    var s = document.createElement("style");
    s.id = "op-dev-css";
    s.textContent = [
      ".op-dev{display:flex;flex-direction:column;overflow:hidden}",
      ".op-dev .dev-head{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex:none;min-height:30px}",
      ".op-dev .dev-bulk{margin-left:auto;display:flex;align-items:center;gap:10px}",
      ".op-dev .dev-bulk .cnt{font-size:12px;color:var(--ink-3);font-family:var(--mono)}",
      ".op-dev .dev-tablewrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}",
      ".op-dev table{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".op-dev thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2);white-space:nowrap;z-index:1}",
      ".op-dev tbody td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap;color:var(--ink-2)}",
      ".op-dev tbody tr:last-child td{border-bottom:none}",
      ".op-dev tbody tr:hover{background:var(--surface-2)}",
      ".op-dev tbody tr.sel{background:color-mix(in srgb, var(--coral) 7%, transparent)}",
      ".op-dev .m{font-family:var(--mono);font-variant-numeric:tabular-nums}",
      ".op-dev .dev-name{font-weight:500;color:var(--ink);display:flex;align-items:center;gap:8px}",
      ".op-dev .dev-name .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none;box-shadow:0 0 0 3px var(--ok-soft)}",
      ".op-dev .dev-name .dot.stopping{background:var(--waiting);box-shadow:0 0 0 3px var(--waiting-soft)}",
      ".op-dev .dev-dir{max-width:260px;overflow:hidden;text-overflow:ellipsis;color:var(--ink-3);font-family:var(--mono);font-size:11.5px;display:inline-block;vertical-align:bottom}",
      ".op-dev td.cb,.op-dev th.cb{width:36px;text-align:center;padding-left:14px}",
      ".op-dev input[type=checkbox]{accent-color:var(--coral);width:15px;height:15px;cursor:pointer;vertical-align:middle}",
      ".op-dev td.act{text-align:right}",
      ".op-dev td.act .row-act{display:inline-flex;gap:6px;justify-content:flex-end}"
    ].join("");
    document.head.appendChild(s);
  }

  function servers(state) { return (state && state.devServers) || []; }
  function esc2(c, v) { return c.esc(v == null ? "" : v); }
  var lastState = null;

  function stopOne(pid) {
    dv.stopping[pid] = Date.now();
    return fetch("/api/devserver/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: pid }) })
      .then(function (r) { return r.ok; }).catch(function () { return false; });
  }
  function stopSingle(s) {
    if (!window.confirm("Stop " + (s.project || s.command || ("port " + s.port)) + " (pid " + s.pid + ")?")) return;
    dv.ctx.toast("Stopping pid " + s.pid + "…", "");
    paint(lastState);
    stopOne(s.pid).then(function (ok) { dv.ctx.toast(ok ? "Stopped pid " + s.pid : "Stop failed", ok ? "ok" : "err"); paint(lastState); });
  }
  function stopSelected() {
    var sel = selSet(); var pids = Object.keys(sel).filter(function (p) { return sel[p]; });
    if (!pids.length) return;
    if (!window.confirm("Stop " + pids.length + " dev server" + (pids.length > 1 ? "s" : "") + "?")) return;
    dv.ctx.toast("Stopping " + pids.length + "…", "");
    paint(lastState);
    Promise.all(pids.map(function (p) { return stopOne(parseInt(p, 10)); })).then(function (res) {
      var ok = res.filter(Boolean).length;
      dv.ctx.toast(ok + " stopped" + (ok < pids.length ? ", " + (pids.length - ok) + " failed" : ""), ok ? "ok" : "err");
      dv.selected = {}; paint(lastState);
    });
  }

  function paint(state) {
    lastState = state;
    var host = dv.host; if (!host) return; var c = dv.ctx;
    var list = servers(state).slice().sort(function (a, b) { return (a.port || 0) - (b.port || 0); });
    var sel = selSet();
    var live = {}; list.forEach(function (s) { live[s.pid] = 1; });
    Object.keys(sel).forEach(function (p) { if (!live[p]) delete sel[p]; });
    Object.keys(dv.stopping).forEach(function (p) { if (!live[p] || Date.now() - dv.stopping[p] > 8000) delete dv.stopping[p]; });
    var selCount = Object.keys(sel).filter(function (p) { return sel[p]; }).length;

    if (!list.length) {
      host.innerHTML = '<div class="op-empty">' + c.icon.terminal + '<div class="t">No dev servers running</div><div class="h">rook detects local dev servers your agents start (node, vite, etc.)</div></div>';
      return;
    }
    var rows = list.map(function (s) {
      var isStopping = !!dv.stopping[s.pid];
      return '<tr class="' + (sel[s.pid] ? "sel" : "") + '" data-pid="' + c.esc(s.pid) + '">' +
        '<td class="cb"><input type="checkbox" data-pid="' + c.esc(s.pid) + '"' + (sel[s.pid] ? " checked" : "") + " /></td>" +
        '<td><span class="dev-name"><span class="dot' + (isStopping ? " stopping" : "") + '"></span>' + esc2(c, s.project || s.command || "server") + "</span></td>" +
        '<td class="m">' + esc2(c, s.port) + "</td>" +
        '<td class="m">' + esc2(c, s.pid) + "</td>" +
        "<td>" + esc2(c, s.command || "—") + "</td>" +
        "<td>" + esc2(c, s.runtime || "—") + "</td>" +
        '<td class="m">' + esc2(c, s.addr || "—") + "</td>" +
        '<td><span class="dev-dir" title="' + esc2(c, s.cwd) + '">' + esc2(c, s.cwd || "—") + "</span></td>" +
        '<td class="act"><span class="row-act">' +
          (s.port ? '<button class="btn sm" data-act="open" data-port="' + c.esc(s.port) + '">' + c.icon.external + "Open</button>" : "") +
          '<button class="btn sm danger" data-act="stop" data-pid="' + c.esc(s.pid) + '">' + (isStopping ? "Stopping…" : "Stop") + "</button>" +
        "</span></td>" +
      "</tr>";
    }).join("");
    var allChecked = list.length && list.every(function (s) { return sel[s.pid]; });
    // preserve scroll across the 2s repaint — rebuilding innerHTML otherwise
    // collapses the scroll container and snaps you back to the top
    var prevWrap = host.querySelector(".dev-tablewrap");
    var savedTop = prevWrap ? prevWrap.scrollTop : 0;
    host.innerHTML =
      '<div class="dev-head"><div class="ov-sec-label" style="margin:0">Dev servers · ' + list.length + "</div>" +
        '<div class="dev-bulk">' + (selCount ? '<span class="cnt">' + selCount + " selected</span>" + '<button class="btn sm danger" id="dev-stopsel">' + c.icon.stop + "Stop selected</button>" : "") + "</div>" +
      "</div>" +
      '<div class="dev-tablewrap"><table>' +
        '<thead><tr><th class="cb"><input type="checkbox" id="dev-all"' + (allChecked ? " checked" : "") + " /></th>" +
          "<th>Name</th><th>Port</th><th>PID</th><th>Command</th><th>Runtime</th><th>Address</th><th>Directory</th><th></th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table></div>";
    var newWrap = host.querySelector(".dev-tablewrap");
    if (newWrap && savedTop) newWrap.scrollTop = savedTop;

    var all = host.querySelector("#dev-all");
    if (all) all.addEventListener("change", function () { list.forEach(function (s) { sel[s.pid] = all.checked; }); paint(lastState); });
    host.querySelectorAll("tbody input[type=checkbox]").forEach(function (cbx) {
      cbx.addEventListener("change", function (e) { e.stopPropagation(); sel[cbx.dataset.pid] = cbx.checked; paint(lastState); });
    });
    var ss = host.querySelector("#dev-stopsel"); if (ss) ss.addEventListener("click", stopSelected);
    host.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (b.dataset.act === "open") { window.open("http://localhost:" + b.dataset.port, "_blank"); return; }
        var s = list.filter(function (x) { return String(x.pid) === String(b.dataset.pid); })[0];
        if (s) stopSingle(s);
      });
    });
  }

  window.OP_VIEWS["dev"] = {
    build: function (host, ctx) { injectCSS(); dv.ctx = ctx; host.innerHTML = '<div class="ins op-dev"></div>'; dv.host = host.firstChild; paint(lastState); },
    render: function (state, ctx) { dv.ctx = ctx || dv.ctx; paint(state); }
  };
})();
