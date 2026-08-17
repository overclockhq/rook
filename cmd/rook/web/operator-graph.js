// operator-graph.js — Operator view for task graphs (DAGs).
// Registers window.OP_VIEWS["graph"]. Visualizes each graph's nodes in
// topological layers with conditional edges, live status, and approve/reject
// controls on approval-interrupt nodes. Server shapes: GET /api/graphs,
// POST /api/graph/approve {id,node,approved}, POST /api/graph/advance?id=.
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var host = null, ctxRef = null, graphs = [], openId = null, lastSig = "";

  function unwrap(r) { return (r && r.data !== undefined && r.data !== null) ? r.data : r; }

  // rank(node) = longest dependency path length → its column in the layout.
  function ranks(g) {
    var byId = {}; (g.nodes || []).forEach(function (n) { byId[n.id] = n; });
    var memo = {};
    function rank(id, seen) {
      if (memo[id] != null) return memo[id];
      var n = byId[id]; if (!n || !n.dependsOn || !n.dependsOn.length) { memo[id] = 0; return 0; }
      seen = seen || {}; if (seen[id]) return 0; seen[id] = true;
      var m = 0; n.dependsOn.forEach(function (d) { m = Math.max(m, rank(d.node, seen) + 1); });
      seen[id] = false; memo[id] = m; return m;
    }
    (g.nodes || []).forEach(function (n) { rank(n.id); });
    return memo;
  }

  function statusClass(n) {
    switch (n.status) {
      case "running": return "run";
      case "awaiting": return "await";
      case "failed": return "fail";
      case "skipped": return "skip";
      case "done": return n.result === "fail" ? "fail" : "pass";
      default: return "pend";
    }
  }
  function statusLabel(n) {
    if (n.status === "done") return n.result === "fail" ? "failed" : "passed";
    return n.status || "pending";
  }
  function edgeClass(on) { return on === "fail" ? "e-fail" : on === "done" ? "e-done" : "e-pass"; }

  var NW = 176, NH = 62, GX = 66, GY = 22;

  function graphProgress(g) {
    var done = (g.nodes || []).filter(function (n) { return n.status === "done" || n.status === "failed" || n.status === "skipped"; }).length;
    return done + "/" + (g.nodes || []).length;
  }

  function renderGraphCanvas(g) {
    var esc = ctxRef.esc;
    var rk = ranks(g);
    var layers = {};
    (g.nodes || []).forEach(function (n) { var r = rk[n.id] || 0; (layers[r] = layers[r] || []).push(n); });
    var pos = {}, maxRow = 0, maxCol = 0;
    Object.keys(layers).forEach(function (r) {
      var col = parseInt(r, 10);
      layers[r].forEach(function (n, i) {
        pos[n.id] = { x: col * (NW + GX), y: i * (NH + GY) };
        maxRow = Math.max(maxRow, i); maxCol = Math.max(maxCol, col);
      });
    });
    var W = (maxCol + 1) * (NW + GX), H = (maxRow + 1) * (NH + GY) + 6;

    // edges
    var edges = "";
    (g.nodes || []).forEach(function (n) {
      (n.dependsOn || []).forEach(function (d) {
        var a = pos[d.node], b = pos[n.id]; if (!a || !b) return;
        var x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
        var mx = (x1 + x2) / 2;
        edges += '<path class="op-g-edge ' + edgeClass(d.on) + '" d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 + '" marker-end="url(#op-g-arrow)"/>';
      });
    });

    // nodes
    var nodes = (g.nodes || []).map(function (n) {
      var p = pos[n.id];
      var appr = n.status === "awaiting"
        ? '<div class="op-g-appr"><button class="btn xs" data-appr="1" data-g="' + g.id + '" data-n="' + esc(n.id) + '">Approve</button><button class="btn xs danger" data-appr="0" data-g="' + g.id + '" data-n="' + esc(n.id) + '">Reject</button></div>'
        : "";
      var tag = n.type === "approval" ? '<span class="op-g-tag">approval</span>' : (n.verify ? '<span class="op-g-tag">verify</span>' : "");
      // agent nodes with a resolved session drill into the Operator view (transcript / diff / terminal)
      var view = (n.type === "agent" && n.sessionId) ? '<button class="op-g-view" data-sid="' + esc(n.sessionId) + '" title="Open this agent — transcript, diff, terminal">View →</button>' : "";
      return '<div class="op-g-node ' + statusClass(n) + '" style="left:' + p.x + 'px;top:' + p.y + 'px;width:' + NW + 'px">' +
        '<div class="op-g-node-top"><span class="op-g-name">' + esc(n.name || n.id) + "</span>" + tag + "</div>" +
        '<div class="op-g-node-meta"><span class="op-g-st ' + statusClass(n) + '">' + statusLabel(n) + "</span>" + view + "</div>" +
        appr + "</div>";
    }).join("");

    return '<div class="op-g-canvas-wrap"><div class="op-g-canvas" style="width:' + W + "px;height:" + H + 'px">' +
      '<svg class="op-g-edges" width="' + W + '" height="' + H + '"><defs><marker id="op-g-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker></defs>' + edges + "</svg>" +
      nodes + "</div></div>";
  }

  function render(state, ctx) {
    ctxRef = ctx;
    fetch("/api/graphs", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        graphs = (unwrap(j) || []).sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
        paint();
      })
      .catch(function () {});
  }

  function paint() {
    if (!host) return;
    var esc = ctxRef.esc;
    if (openId == null && graphs.length) openId = graphs[0].id;
    var g = graphs.filter(function (x) { return x.id === openId; })[0] || graphs[0];
    var sig = JSON.stringify(graphs.map(function (x) { return [x.id, x.done, (x.nodes || []).map(function (n) { return n.id + n.status + (n.result || ""); }).join(",")]; })) + "|" + openId;
    if (sig === lastSig) return;
    lastSig = sig;

    var tabs = graphs.map(function (x) {
      var run = (x.nodes || []).some(function (n) { return n.status === "running" || n.status === "awaiting"; });
      return '<button class="op-g-tab ' + (x.id === openId ? "on" : "") + (x.done ? " done" : "") + '" data-gid="' + x.id + '">' +
        (run ? '<i class="op-g-dot"></i>' : "") + esc(x.title || x.id) + '<span class="op-g-prog">' + graphProgress(x) + "</span></button>";
    }).join("");

    var body;
    if (!graphs.length) {
      body = '<div class="op-empty">' + ctxRef.icon.grid + '<div class="t">No task graphs yet</div><div class="h">Create one with “New task graph” (⌘K) — nodes with conditional edges and approval gates.</div></div>';
    } else {
      var awaiting = (g.nodes || []).some(function (n) { return n.status === "awaiting"; });
      var running = (g.nodes || []).some(function (n) { return n.status === "running"; });
      body =
        '<div class="op-g-head"><div class="op-g-title">' + esc(g.title || g.id) +
          '<span class="pill ' + (g.done ? "idle" : running ? "working" : awaiting ? "needs" : "idle") + '">' + (g.done ? "done" : running ? "running" : awaiting ? "needs you" : "idle") + "</span></div>" +
          '<div class="op-g-sub"><span class="mono">' + esc(g.cwd || "") + "</span>" +
            (running ? ' <button class="btn xs" id="opGAdvance" data-gid="' + g.id + '">Advance</button>' : "") +
            ' <button class="btn xs danger" id="opGDelete" data-gid="' + g.id + '">Delete</button>' + "</div>" +
        "</div>" + renderGraphCanvas(g);
    }
    host.innerHTML = '<div class="op-g-tabs">' + tabs + '<button class="btn sm op-g-new" id="opGNew">' + ctxRef.icon.plus + "New graph</button></div>" +
      '<div class="op-g-body">' + body + "</div>";

    host.querySelectorAll(".op-g-tab").forEach(function (b) { b.addEventListener("click", function () { openId = b.dataset.gid; lastSig = ""; paint(); }); });
    host.querySelectorAll(".op-g-view").forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); ctxRef.selectAgent && ctxRef.selectAgent(b.dataset.sid); }); });
    host.querySelectorAll("[data-appr]").forEach(function (b) {
      b.addEventListener("click", function () {
        fetch("/api/graph/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.g, node: b.dataset.n, approved: b.dataset.appr === "1" }) })
          .then(function () { ctxRef.toast(b.dataset.appr === "1" ? "Approved" : "Rejected", b.dataset.appr === "1" ? "ok" : ""); lastSig = ""; render(null, ctxRef); })
          .catch(function () { ctxRef.toast("Action failed", "err"); });
      });
    });
    var adv = host.querySelector("#opGAdvance");
    if (adv) adv.addEventListener("click", function () {
      fetch("/api/graph/advance?id=" + encodeURIComponent(adv.dataset.gid), { method: "POST" })
        .then(function () { ctxRef.toast("Advanced", "ok"); lastSig = ""; render(null, ctxRef); })
        .catch(function () {});
    });
    var del = host.querySelector("#opGDelete");
    if (del) del.addEventListener("click", function () {
      if (!confirm("Delete this task graph? Running agents keep going — stop them from the roster.")) return;
      fetch("/api/graph?id=" + encodeURIComponent(del.dataset.gid), { method: "DELETE" })
        .then(function () { openId = null; lastSig = ""; ctxRef.toast("Graph deleted", ""); render(null, ctxRef); })
        .catch(function () { ctxRef.toast("Delete failed", "err"); });
    });
    var nw = host.querySelector("#opGNew");
    if (nw) nw.addEventListener("click", function () { ctxRef.launchGraph && ctxRef.launchGraph(); });
  }

  function build(hostEl, ctx) {
    injectCSS();
    ctxRef = ctx; openId = null; lastSig = "";
    hostEl.innerHTML = '<div class="ins op-g"></div>';
    host = hostEl.firstChild;
    render(null, ctx);
  }

  function injectCSS() {
    if (document.getElementById("op-graph-css")) return;
    var st = document.createElement("style"); st.id = "op-graph-css";
    st.textContent =
      ".op-g { display:flex; flex-direction:column; height:100%; overflow:hidden; }" +
      ".op-g-tabs { display:flex; align-items:center; gap:8px; padding:14px 20px 10px; overflow-x:auto; flex:none; border-bottom:1px solid var(--line); }" +
      ".op-g-tab { display:flex; align-items:center; gap:7px; height:30px; padding:0 12px; border-radius:8px; border:1px solid var(--line); background:var(--surface); color:var(--ink-2); font-size:12.5px; white-space:nowrap; cursor:pointer; }" +
      ".op-g-tab.on { border-color:var(--coral-line); color:var(--ink); background:var(--coral-soft); }" +
      ".op-g-tab.done { opacity:.6; }" +
      ".op-g-prog { font-family:var(--mono); font-size:11px; color:var(--ink-4); }" +
      ".op-g-dot { width:7px;height:7px;border-radius:50%;background:var(--coral); }" +
      ".op-g-new { margin-left:auto; }" +
      ".op-g-body { flex:1; min-height:0; overflow:auto; }" +
      ".op-g-head { padding:16px 20px 4px; }" +
      ".op-g-title { display:flex; align-items:center; gap:10px; font-size:15px; font-weight:600; color:var(--ink); }" +
      ".op-g-sub { display:flex; align-items:center; gap:10px; font-size:11px; color:var(--ink-4); margin-top:4px; }" +
      ".op-g-canvas-wrap { padding:14px 20px 40px; overflow:auto; }" +
      ".op-g-canvas { position:relative; }" +
      ".op-g-edges { position:absolute; left:0; top:0; pointer-events:none; overflow:visible; }" +
      ".op-g-edge { fill:none; stroke-width:1.6; }" +
      ".op-g-edge.e-pass { stroke:var(--ok); color:var(--ok); }" +
      ".op-g-edge.e-fail { stroke:var(--danger); color:var(--danger); }" +
      ".op-g-edge.e-done { stroke:var(--line-2,var(--ink-4)); color:var(--ink-4); }" +
      ".op-g-node { position:absolute; box-sizing:border-box; border:1px solid var(--line); border-left:3px solid var(--ink-4); border-radius:9px; background:var(--surface); padding:8px 10px; box-shadow:var(--shadow-sm,0 1px 2px rgba(0,0,0,.05)); }" +
      ".op-g-node.run { border-left-color:var(--busy); }" +
      ".op-g-node.await { border-left-color:var(--coral); background:var(--coral-soft); }" +
      ".op-g-node.pass { border-left-color:var(--ok); }" +
      ".op-g-node.fail { border-left-color:var(--danger); }" +
      ".op-g-node.skip { border-left-color:var(--line-2,var(--ink-4)); opacity:.6; }" +
      ".op-g-node-top { display:flex; align-items:center; gap:6px; }" +
      ".op-g-name { font-size:12.5px; font-weight:600; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }" +
      ".op-g-tag { font-size:9px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-4); border:1px solid var(--line); border-radius:4px; padding:1px 4px; margin-left:auto; }" +
      ".op-g-node-meta { margin-top:3px; display:flex; align-items:center; gap:8px; }" +
      ".op-g-view { margin-left:auto; background:none; border:none; color:var(--accent); font-size:11px; cursor:pointer; padding:0; font-family:var(--mono); }" +
      ".op-g-view:hover { text-decoration:underline; }" +
      ".op-g-st { font-size:10px; text-transform:uppercase; letter-spacing:.04em; }" +
      ".op-g-st.run { color:var(--busy); } .op-g-st.await { color:var(--coral); } .op-g-st.pass { color:var(--ok); } .op-g-st.fail { color:var(--danger); } .op-g-st.skip,.op-g-st.pend { color:var(--ink-4); }" +
      ".op-g-appr { display:flex; gap:6px; margin-top:7px; }";
    document.head.appendChild(st);
  }

  window.OP_VIEWS["graph"] = { build: build, render: render };
})();
