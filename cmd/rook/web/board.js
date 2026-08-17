// board.js — live status board for rook. Cards reflect each agent's derived
// state; you act from a card, you don't drag to force a state.
// Self-contained: exposes window.renderBoardV2(mountEl, {sessions, chains}, cb).
// No dependency on app.js internals; the caller wires cb.* to its own handlers.
(function () {
  "use strict";

  // Fixed columns. "Worktrees" is honest — the column holds agents running in an
  // isolated worktree, which isn't the same as "in review".
  var COLS = [
    { key: "queued", label: "Queued" },
    { key: "working", label: "Working" },
    { key: "needs", label: "Needs you" },
    { key: "review", label: "Worktrees" },
    { key: "done", label: "Idle / Done" },
  ];
  // Which columns get a "+ New task" affordance at the top.
  var NEW_TASK_COLS = { queued: true, working: true };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTokens(n) {
    if (n == null) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  function statusOf(s) {
    return s.alive ? (s.status || "idle") : "dead";
  }

  // columnFor auto-places a session by its live state.
  function columnFor(s) {
    var st = statusOf(s);
    if (st === "waiting" || (s.health && s.health.level === "alert")) return "needs";
    if (s.alive && (st === "busy" || st === "shell")) return "working";
    if ((s.cwd || "").indexOf("/.rook/worktrees/") !== -1) return "review";
    return "done";
  }

  function iconBtn(label, cls) {
    return '<button type="button" class="bv-btn ' + cls + '">' + esc(label) + "</button>";
  }

  // buildSessionCard returns a card element for one session.
  function buildSessionCard(s, colKey, cb) {
    var st = statusOf(s);
    var waiting = st === "waiting";
    var card = document.createElement("div");
    card.className = "bv-card";
    card.dataset.id = s.sessionId;
    card.dataset.col = colKey;

    var tokens = s.tokens7d != null ? s.tokens7d : s.tokensTotal;
    var health = "";
    if (s.health) {
      var glyph = s.health.level === "alert" ? "⚠" : "●";
      health =
        '<span class="bv-chip bv-health h-' +
        esc(s.health.level) +
        '" title="' +
        esc(s.health.reason || "") +
        '">' +
        glyph +
        " " +
        esc(s.health.reason || s.health.level) +
        "</span>";
    }
    var prov = s.provider || "claude";

    var acts = "";
    if (waiting) {
      acts += iconBtn("Allow", "bv-allow");
      acts += iconBtn("Deny", "bv-deny bv-danger");
    }
    if (s.controllable || s.tmuxPane) acts += iconBtn("Terminal", "bv-term");
    if (s.cwd) acts += iconBtn("Diff", "bv-diff");
    if (s.cwd) acts += iconBtn("Review", "bv-review");

    card.innerHTML =
      '<div class="bv-card-top">' +
      '<span class="bv-dot s-' + esc(st) + '"></span>' +
      '<span class="bv-title" title="' + esc(s.title || s.project || "session") + '">' +
      esc(s.title || s.project || "session") +
      "</span>" +
      "</div>" +
      '<div class="bv-meta">' +
      '<span class="bv-chip bv-prov">' + esc(prov) + "</span>" +
      (s.project ? '<span class="bv-proj">' + esc(s.project) + "</span>" : "") +
      health +
      (tokens != null ? '<span class="bv-tok">' + esc(fmtTokens(tokens)) + " tok</span>" : "") +
      "</div>" +
      (acts ? '<div class="bv-acts">' + acts + "</div>" : "");

    // Card body click -> open (buttons stopPropagation).
    card.addEventListener("click", function () {
      if (cb.onOpen) cb.onOpen(s.sessionId);
    });
    function wire(sel, fn) {
      var b = card.querySelector(sel);
      if (b && fn) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          fn(s.sessionId);
        });
      }
    }
    wire(".bv-allow", cb.onAllow);
    wire(".bv-deny", cb.onDeny);
    wire(".bv-term", cb.onTerminal);
    wire(".bv-diff", cb.onDiff);
    wire(".bv-review", cb.onReview);
    // Board columns reflect each agent's real, derived state (busy/waiting/
    // idle/…) — you can't force a state by dragging, so cards are not
    // draggable. It's a live status board: click to open, act from the card.
    return card;
  }

  // buildQueuedCard renders a pending chain step (no session, not draggable).
  function buildQueuedCard(q) {
    var card = document.createElement("div");
    card.className = "bv-card bv-card-queued";
    card.innerHTML =
      '<div class="bv-card-top">' +
      '<span class="bv-dot s-idle"></span>' +
      '<span class="bv-title" title="' + esc(q.step.name) + '">' + esc(q.step.name) + "</span>" +
      "</div>" +
      '<div class="bv-meta">' +
      '<span class="bv-proj">' + esc(q.chain || "chain") + "</span>" +
      (q.step.prompt ? '<span class="bv-tok">' + esc(q.step.prompt) + "</span>" : "") +
      "</div>";
    return card;
  }

  function buildColumn(col, cb) {
    var wrap = document.createElement("div");
    wrap.className = "bv-col bv-col-" + col.key;

    var head = document.createElement("div");
    head.className = "bv-col-head";
    head.innerHTML =
      '<span class="bv-col-label">' + esc(col.label) + "</span>" +
      '<span class="bv-col-n">0</span>';
    wrap.appendChild(head);

    if (NEW_TASK_COLS[col.key]) {
      var add = document.createElement("button");
      add.type = "button";
      add.className = "bv-newtask";
      add.textContent = "+ New task";
      add.addEventListener("click", function () {
        if (cb.onNewTask) cb.onNewTask(col.key);
      });
      wrap.appendChild(add);
    }

    var body = document.createElement("div");
    body.className = "bv-col-body";
    body.dataset.col = col.key;
    wrap.appendChild(body);

    return { wrap: wrap, body: body, headN: head.querySelector(".bv-col-n") };
  }

  // updateCounts refreshes each column header count + empty placeholder.
  function updateCounts(mount) {
    var cols = mount.querySelectorAll(".bv-col");
    for (var i = 0; i < cols.length; i++) {
      var body = cols[i].querySelector(".bv-col-body");
      var n = body.querySelectorAll(".bv-card").length;
      var nEl = cols[i].querySelector(".bv-col-n");
      if (nEl) nEl.textContent = String(n);
      var ph = body.querySelector(".bv-empty");
      if (n === 0 && !ph) {
        var p = document.createElement("p");
        p.className = "bv-empty";
        p.textContent = "—";
        body.appendChild(p);
      } else if (n > 0 && ph) {
        ph.parentNode.removeChild(ph);
      }
    }
  }

  function renderBoardV2(mount, data, cb) {
    if (!mount) return;
    cb = cb || {};
    var sessions = (data && data.sessions) || [];
    var chains = (data && data.chains) || [];

    var buckets = { queued: [], working: [], needs: [], review: [], done: [] };
    sessions.forEach(function (s) {
      buckets[columnFor(s)].push(s);
    });
    // Rank "Needs you" by urgency: watchdog alerts first, then longest-waiting
    // (oldest update) — so the agent most in need of you is at the top.
    buckets.needs.sort(function (a, b) {
      var aa = a.health && a.health.level === "alert" ? 1 : 0;
      var ba = b.health && b.health.level === "alert" ? 1 : 0;
      if (aa !== ba) return ba - aa;
      return (a.updatedAt || 0) - (b.updatedAt || 0);
    });
    var queued = [];
    chains.forEach(function (c) {
      (c.steps || []).forEach(function (step) {
        if (step.status === "pending") queued.push({ chain: c.title || c.id, step: step });
      });
    });

    // Drop the legacy ".board" grid class: this mount keeps its id="board"
    // but the V2 layout is flex-based, and the old .board grid rules
    // (repeat(5, minmax(180px,1fr))) fight the flex columns and cause overlap.
    mount.classList.remove("board");
    mount.classList.add("board-v2");
    mount.innerHTML = "";

    COLS.forEach(function (col) {
      var built = buildColumn(col, cb);
      if (col.key === "queued") {
        queued.forEach(function (q) {
          built.body.appendChild(buildQueuedCard(q));
        });
      } else {
        buckets[col.key].forEach(function (s) {
          built.body.appendChild(buildSessionCard(s, col.key, cb));
        });
      }
      mount.appendChild(built.wrap);
    });

    updateCounts(mount);
  }

  window.renderBoardV2 = renderBoardV2;
})();
