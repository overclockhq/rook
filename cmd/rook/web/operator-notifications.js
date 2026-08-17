/* operator-notifications.js — Notification history view (window.OP_VIEWS["notifications"]).
   Native banners and phone pushes are ephemeral; rook records every alert it fires
   (waiting / alert / finished / agent / blocked / verify) to disk and shows the
   searchable history here as a dense table. Rows with a session click through. */
(function () {
  var KIND = {
    waiting:  { label: "Waiting",  col: "var(--waiting)" },
    alert:    { label: "Alert",    col: "var(--danger)"  },
    finished: { label: "Finished", col: "var(--ok)"      },
    hook:     { label: "Agent",    col: "var(--accent)"  },
    blocked:  { label: "Blocked",  col: "var(--danger)"  },
    verify:   { label: "Verify",   col: "var(--coral)"   }
  };
  var PER = 20;
  var items = [];       // last fetched, newest first
  var filter = "all";
  var page = 1;
  var lastFetch = 0;
  var hostEl = null, ctxRef = null;

  function style() {
    if (document.getElementById("opNotifStyle")) return;
    var s = document.createElement("style");
    s.id = "opNotifStyle";
    s.textContent = [
      ".nf-wrap{max-width:1180px;margin:0 auto;padding:18px 24px 0;width:100%;overflow-y:auto;}",
      ".nf-head{display:flex;align-items:center;gap:12px;margin-bottom:14px;}",
      ".nf-head h2{font-size:15px;font-weight:600;margin:0;color:var(--ink);}",
      ".nf-count{color:var(--ink-3);font-size:12px;}",
      ".nf-spacer{flex:1;}",
      ".nf-btn{border:1px solid var(--line);background:var(--surface);color:var(--ink-2);font:inherit;font-size:12px;padding:5px 10px;border-radius:var(--radius-sm);cursor:pointer;}",
      ".nf-btn:hover{border-color:var(--line-strong);color:var(--ink);}",
      ".nf-btn:disabled{opacity:.4;cursor:default;}",
      ".nf-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}",
      ".nf-chip{border:1px solid var(--line);background:transparent;color:var(--ink-3);font:inherit;font-size:12px;padding:4px 11px;border-radius:999px;cursor:pointer;}",
      ".nf-chip:hover{color:var(--ink);}",
      ".nf-chip.on{background:var(--coral-soft);border-color:var(--coral-line);color:var(--coral);}",
      ".nf-tablewrap{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;}",
      ".nf-table{width:100%;border-collapse:collapse;table-layout:fixed;}",
      ".nf-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-4);font-weight:600;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--panel-2,var(--surface-2));}",
      ".nf-table td{padding:9px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink-2);vertical-align:top;}",
      ".nf-table tbody tr:last-child td{border-bottom:0;}",
      ".nf-table tbody tr.click{cursor:pointer;}",
      ".nf-table tbody tr:hover td{background:var(--surface-2);}",
      ".nf-t-time{width:64px;white-space:nowrap;color:var(--ink-4);font-size:11px;font-variant-numeric:tabular-nums;}",
      ".nf-t-kind{width:104px;}",
      ".nf-t-proj{width:150px;}",
      ".nf-t-ch{width:130px;}",
      ".nf-kbadge{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;white-space:nowrap;}",
      ".nf-kdot{width:7px;height:7px;border-radius:50%;flex:none;}",
      ".nf-proj{font-family:var(--mono);font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;}",
      ".nf-msg-t{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".nf-msg-b{color:var(--ink-3);font-size:11.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".nf-ch{display:inline-block;font-size:10px;color:var(--ink-4);border:1px solid var(--line);border-radius:4px;padding:0 5px;margin:0 3px 3px 0;font-family:var(--mono);}",
      ".nf-pager{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--ink-3);position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 2px;margin-top:4px;}",
      ".nf-pager .pg{display:flex;gap:8px;align-items:center;}",
      ".nf-empty{text-align:center;color:var(--ink-3);padding:48px 0;font-size:13px;}"
    ].join("");
    document.head.appendChild(s);
  }

  function fetchNotifs(cb) {
    fetch("/api/notifications?limit=500")
      .then(function (r) { return r.json(); })
      .then(function (j) { items = (j && j.data) || []; lastFetch = Date.now(); cb && cb(); })
      .catch(function () { cb && cb(); });
  }

  function render() {
    if (!hostEl) return;
    var ctx = ctxRef, esc = ctx.esc, now = Date.now();
    var shown = items.filter(function (n) { return filter === "all" || n.kind === filter; });
    var total = shown.length;
    var pages = Math.max(1, Math.ceil(total / PER));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    var start = (page - 1) * PER;
    var pageItems = shown.slice(start, start + PER);

    var cnt = hostEl.querySelector(".nf-count");
    if (cnt) cnt.textContent = items.length ? (total + (filter === "all" ? "" : " " + filter) + " · " + items.length + " total") : "";
    var clearBtn = hostEl.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.disabled = !items.length;
    hostEl.querySelectorAll(".nf-chip").forEach(function (ch) { ch.classList.toggle("on", ch.dataset.k === filter); });

    var body = hostEl.querySelector(".nf-body-slot");
    if (!body) return;
    if (!total) {
      body.innerHTML = '<div class="nf-empty">' +
        (items.length ? "No notifications of this kind." : "No notifications yet. Every alert rook fires shows up here.") + "</div>";
      return;
    }
    var rows = pageItems.map(function (n) {
      var k = KIND[n.kind] || { label: n.kind, col: "var(--ink-3)" };
      var clickable = !!n.sessionId;
      var chans = (n.channels || []).map(function (c) { return '<span class="nf-ch">' + esc(c) + "</span>"; }).join("");
      var titleAttr = esc((n.title || "") + (n.body ? " — " + n.body : ""));
      return '<tr' + (clickable ? ' class="click" data-sid="' + esc(n.sessionId) + '"' : "") + ' title="' + titleAttr + '">' +
        '<td class="nf-t-time">' + ctx.ago(n.ts, now) + "</td>" +
        '<td class="nf-t-kind"><span class="nf-kbadge" style="color:' + k.col + '"><span class="nf-kdot" style="background:' + k.col + '"></span>' + esc(k.label) + "</span></td>" +
        '<td class="nf-t-proj"><span class="nf-proj">' + esc(n.project || "—") + "</span></td>" +
        '<td><div class="nf-msg-t">' + esc(n.title || "") + "</div>" + (n.body ? '<div class="nf-msg-b">' + esc(n.body) + "</div>" : "") + "</td>" +
        '<td class="nf-t-ch">' + (chans || '<span style="color:var(--ink-4)">—</span>') + "</td>" +
      "</tr>";
    }).join("");
    body.innerHTML =
      '<div class="nf-tablewrap"><table class="nf-table"><thead><tr>' +
        '<th class="nf-t-time">When</th><th class="nf-t-kind">Kind</th><th class="nf-t-proj">Project</th><th>Message</th><th class="nf-t-ch">Channels</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<div class="nf-pager"><span>' + (start + 1) + "–" + (start + pageItems.length) + " of " + total + "</span>" +
        '<span class="pg"><button class="nf-btn" data-pg="prev"' + (page <= 1 ? " disabled" : "") + ">‹ Prev</button>" +
        "<span>Page " + page + " / " + pages + "</span>" +
        '<button class="nf-btn" data-pg="next"' + (page >= pages ? " disabled" : "") + ">Next ›</button></span></div>";

    body.querySelectorAll("tr.click").forEach(function (tr) {
      tr.addEventListener("click", function () { ctx.selectAgent(tr.dataset.sid); });
    });
    var prev = body.querySelector('[data-pg="prev"]'), next = body.querySelector('[data-pg="next"]');
    if (prev) prev.addEventListener("click", function () { if (page > 1) { page--; render(); } });
    if (next) next.addEventListener("click", function () { if (page < pages) { page++; render(); } });
  }

  function build(host, ctx) {
    style();
    hostEl = host; ctxRef = ctx; page = 1;
    var wrap = ctx.el("div", "nf-wrap");
    var kinds = ["all", "waiting", "alert", "finished", "hook", "blocked", "verify"];
    wrap.innerHTML =
      '<div class="nf-head"><h2>Notifications</h2><span class="nf-count"></span>' +
        '<span class="nf-spacer"></span>' +
        '<button class="nf-btn" data-act="refresh">Refresh</button>' +
        '<button class="nf-btn" data-act="clear">Clear history</button>' +
      "</div>" +
      '<div class="nf-filters">' + kinds.map(function (k) {
        var lbl = k === "all" ? "All" : (KIND[k] ? KIND[k].label : k);
        return '<button class="nf-chip" data-k="' + k + '">' + lbl + "</button>";
      }).join("") + "</div>" +
      '<div class="nf-body-slot"></div>';
    host.appendChild(wrap);

    wrap.querySelectorAll(".nf-chip").forEach(function (ch) {
      ch.addEventListener("click", function () { filter = ch.dataset.k; page = 1; render(); });
    });
    wrap.querySelector('[data-act="refresh"]').addEventListener("click", function () { fetchNotifs(render); });
    wrap.querySelector('[data-act="clear"]').addEventListener("click", function () {
      if (!items.length) return;
      fetch("/api/notifications/clear", { method: "POST" }).then(function () {
        items = []; page = 1;
        ctx.toast && ctx.toast("Notification history cleared");
        render();
      });
    });

    fetchNotifs(render);
  }

  // Refresh from the API at most every 5s; between ticks leave the table alone so
  // pagination/hover aren't disrupted.
  function renderTick() {
    if (Date.now() - lastFetch > 5000) fetchNotifs(render);
  }

  window.OP_VIEWS = window.OP_VIEWS || {};
  window.OP_VIEWS["notifications"] = { build: build, render: renderTick };
})();
