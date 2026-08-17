/* operator-notifications.js — Notification history view (window.OP_VIEWS["notifications"]).
   Native banners and phone pushes are ephemeral; rook records every alert it
   fires (waiting / alert / finished / agent / blocked / verify) to disk and shows
   the searchable history here. Rows with a session link click through to the agent. */
(function () {
  var KIND = {
    waiting:  { label: "Waiting",  col: "var(--waiting)" },
    alert:    { label: "Alert",    col: "var(--danger)"  },
    finished: { label: "Finished", col: "var(--ok)"      },
    hook:     { label: "Agent",    col: "var(--accent)"  },
    blocked:  { label: "Blocked",  col: "var(--danger)"  },
    verify:   { label: "Verify",   col: "var(--coral)"   }
  };
  var items = [];       // last fetched, newest first
  var filter = "all";   // active kind filter
  var lastFetch = 0;
  var hostEl = null, ctxRef = null;

  function style() {
    if (document.getElementById("opNotifStyle")) return;
    var s = document.createElement("style");
    s.id = "opNotifStyle";
    s.textContent = [
      ".nf-wrap{max-width:920px;margin:0 auto;padding:20px 24px 60px;}",
      ".nf-head{display:flex;align-items:center;gap:12px;margin-bottom:14px;}",
      ".nf-head h2{font-size:15px;font-weight:600;margin:0;color:var(--ink);}",
      ".nf-count{color:var(--ink-3);font-size:12px;}",
      ".nf-spacer{flex:1;}",
      ".nf-btn{border:1px solid var(--line);background:var(--surface);color:var(--ink-2);font:inherit;font-size:12px;padding:5px 10px;border-radius:var(--radius-sm);cursor:pointer;}",
      ".nf-btn:hover{border-color:var(--line-strong);color:var(--ink);}",
      ".nf-btn:disabled{opacity:.45;cursor:default;}",
      ".nf-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}",
      ".nf-chip{border:1px solid var(--line);background:transparent;color:var(--ink-3);font:inherit;font-size:12px;padding:4px 11px;border-radius:999px;cursor:pointer;}",
      ".nf-chip:hover{color:var(--ink);}",
      ".nf-chip.on{background:var(--coral-soft);border-color:var(--coral-line);color:var(--coral);}",
      ".nf-list{display:flex;flex-direction:column;gap:8px;}",
      ".nf-row{display:flex;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);}",
      ".nf-row.click{cursor:pointer;}",
      ".nf-row.click:hover{border-color:var(--line-strong);background:var(--surface);}",
      ".nf-dot{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;}",
      ".nf-main{flex:1;min-width:0;}",
      ".nf-title{font-size:13px;color:var(--ink);font-weight:500;overflow-wrap:anywhere;}",
      ".nf-body{font-size:12px;color:var(--ink-3);margin-top:3px;overflow-wrap:anywhere;}",
      ".nf-meta{display:flex;gap:8px;align-items:center;margin-top:7px;flex-wrap:wrap;}",
      ".nf-kind{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;}",
      ".nf-proj{font-size:11px;color:var(--ink-3);font-family:var(--mono);}",
      ".nf-ch{font-size:10px;color:var(--ink-4);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-family:var(--mono);}",
      ".nf-time{font-size:11px;color:var(--ink-4);white-space:nowrap;flex:none;}",
      ".nf-empty{text-align:center;color:var(--ink-3);padding:56px 0;font-size:13px;}"
    ].join("");
    document.head.appendChild(s);
  }

  function fetchNotifs(cb) {
    fetch("/api/notifications?limit=300")
      .then(function (r) { return r.json(); })
      .then(function (j) { items = (j && j.data) || []; lastFetch = Date.now(); cb && cb(); })
      .catch(function () { cb && cb(); });
  }

  function render() {
    if (!hostEl) return;
    var ctx = ctxRef, esc = ctx.esc, now = Date.now();
    var shown = items.filter(function (n) { return filter === "all" || n.kind === filter; });

    var cnt = hostEl.querySelector(".nf-count");
    if (cnt) cnt.textContent = items.length ? (shown.length + " of " + items.length) : "";
    var clearBtn = hostEl.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.disabled = !items.length;
    hostEl.querySelectorAll(".nf-chip").forEach(function (ch) { ch.classList.toggle("on", ch.dataset.k === filter); });

    var list = hostEl.querySelector(".nf-list");
    if (!list) return;
    if (!shown.length) {
      list.innerHTML = '<div class="nf-empty">' +
        (items.length ? "No notifications of this kind." : "No notifications yet. Every alert rook fires shows up here.") +
        "</div>";
      return;
    }
    list.innerHTML = shown.map(function (n) {
      var k = KIND[n.kind] || { label: n.kind, col: "var(--ink-3)" };
      var clickable = !!n.sessionId;
      var chans = (n.channels || []).map(function (c) { return '<span class="nf-ch">' + esc(c) + "</span>"; }).join("");
      return '<div class="nf-row' + (clickable ? " click" : "") + '"' + (clickable ? ' data-sid="' + esc(n.sessionId) + '"' : "") + ">" +
        '<span class="nf-dot" style="background:' + k.col + '"></span>' +
        '<div class="nf-main">' +
          '<div class="nf-title">' + esc(n.title || "") + "</div>" +
          (n.body ? '<div class="nf-body">' + esc(n.body) + "</div>" : "") +
          '<div class="nf-meta">' +
            '<span class="nf-kind" style="color:' + k.col + '">' + esc(k.label) + "</span>" +
            (n.project ? '<span class="nf-proj">' + esc(n.project) + "</span>" : "") +
            chans +
          "</div>" +
        "</div>" +
        '<span class="nf-time">' + ctx.ago(n.ts, now) + "</span>" +
      "</div>";
    }).join("");
    list.querySelectorAll(".nf-row.click").forEach(function (row) {
      row.addEventListener("click", function () { ctx.selectAgent(row.dataset.sid); });
    });
  }

  function build(host, ctx) {
    style();
    hostEl = host; ctxRef = ctx;
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
      '<div class="nf-list"></div>';
    host.appendChild(wrap);

    wrap.querySelectorAll(".nf-chip").forEach(function (ch) {
      ch.addEventListener("click", function () { filter = ch.dataset.k; render(); });
    });
    wrap.querySelector('[data-act="refresh"]').addEventListener("click", function () { fetchNotifs(render); });
    wrap.querySelector('[data-act="clear"]').addEventListener("click", function () {
      if (!items.length) return;
      fetch("/api/notifications/clear", { method: "POST" }).then(function () {
        items = [];
        ctx.toast && ctx.toast("Notification history cleared");
        render();
      });
    });

    fetchNotifs(render);
  }

  // render() runs on every state poll; refresh from the API at most every 5s so
  // new alerts appear without hammering the endpoint.
  function renderTick() {
    if (Date.now() - lastFetch > 5000) fetchNotifs(render);
    else render();
  }

  window.OP_VIEWS = window.OP_VIEWS || {};
  window.OP_VIEWS["notifications"] = { build: build, render: renderTick };
})();
