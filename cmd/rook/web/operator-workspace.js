// Operator "workspace" view — git worktrees (dense table, multi-select delete)
// + Claude Code hooks management. Unlike the "dev" view, this data isn't in the
// shared polled state, so this view fetches its own endpoints (/api/worktrees,
// /api/hooks/*). render() runs on build and every 2s poll and MUST be
// idempotent: it must not wipe checkbox selections, an in-progress delete, or a
// mid-action gate toggle. View-local UI state lives in the module closure below
// (selection Set + in-flight guards) rather than being re-derived from the DOM,
// so a poll refetch/repaint never clobbers the user's selection or a running
// batch delete.
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var view = {
    host: null, // the inner .ins.op-ws wrapper (never host itself)
    ctx: null,
    sessions: [], // latest state.sessions, to link a worktree → its live agent
    // worktrees
    wtSecEl: null,
    wts: null, // null = not loaded yet; [] = loaded empty
    wtErr: false,
    wtInFlight: false,
    deleting: false, // a single or bulk delete is in flight/settling
    selected: null, // Set of worktree paths (survives polls)
    // hooks
    hkSecEl: null,
    hooks: null,
    events: [],
    hkErr: false,
    hkInFlight: false,
    hkBusy: false, // install/uninstall/gate POST in flight
  };

  function injectCSS() {
    if (document.getElementById("op-workspace-css")) return;
    var s = document.createElement("style");
    s.id = "op-workspace-css";
    s.textContent = [
      // fixed-height view; the page never scrolls, each table scrolls itself
      ".op-ws{display:flex;flex-direction:column;overflow:hidden;gap:18px}",
      ".op-ws .ws-sec{display:flex;flex-direction:column;min-height:0;flex:1 1 0}",
      ".op-ws .ws-shead{display:flex;align-items:center;gap:12px;margin-bottom:10px;flex:none;min-height:28px}",
      ".op-ws .ws-shead .ov-sec-label{margin:0}",
      ".op-ws .ws-summary{font-size:12px;color:var(--ink-3);font-family:var(--mono);font-variant-numeric:tabular-nums}",
      ".op-ws .ws-bulk{margin-left:auto;display:flex;align-items:center;gap:10px}",
      ".op-ws .ws-bulk .cnt{font-size:12px;color:var(--ink-3);font-family:var(--mono)}",
      // dense table (mirrors operator-dev density)
      ".op-ws .ws-tablewrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}",
      ".op-ws table{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".op-ws thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2);white-space:nowrap;z-index:1}",
      ".op-ws tbody td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap;color:var(--ink-2)}",
      ".op-ws tbody tr:last-child td{border-bottom:none}",
      ".op-ws tbody tr:hover{background:var(--surface-2)}",
      ".op-ws tbody tr.sel{background:color-mix(in srgb, var(--coral) 7%, transparent)}",
      ".op-ws td.cb,.op-ws th.cb{width:36px;text-align:center;padding-left:14px}",
      ".op-ws input[type=checkbox]{accent-color:var(--coral);width:15px;height:15px;cursor:pointer;vertical-align:middle;margin:0}",
      ".op-ws .m{font-family:var(--mono);font-variant-numeric:tabular-nums}",
      ".op-ws .wt-name{font-weight:500;color:var(--ink);display:inline-flex;align-items:center;gap:8px}",
      ".op-ws .wt-name .pill{text-transform:none}",
      ".op-ws .wt-mono{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);max-width:220px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}",
      ".op-ws .wt-agent{color:var(--coral);cursor:pointer;background:none;border:none;padding:0;font-size:12.5px;font-family:var(--sans);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}",
      ".op-ws .wt-agent:hover{text-decoration:underline}",
      ".op-ws .wt-none{color:var(--ink-4)}",
      ".op-ws td.act{text-align:right}",
      ".op-ws td.act .row-act{display:inline-flex;gap:6px;justify-content:flex-end}",
      // hooks status card
      ".op-ws .hk-card{flex:none;margin-bottom:12px}",
      ".op-ws .hk-rows{display:flex;flex-direction:column;gap:12px}",
      ".op-ws .hk-paths{display:flex;flex-wrap:wrap;gap:10px 22px}",
      ".op-ws .hk-path{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".op-ws .hk-path .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4)}",
      ".op-ws .hk-path .v{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:440px}",
      ".op-ws .hk-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".op-ws .hk-toggle{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-2);cursor:pointer;margin-left:auto}",
      ".op-ws .hk-toggle.disabled{opacity:.5;cursor:default}",
      // pill flavors not present in operator.css
      ".op-ws .pill.ok{background:var(--ok-soft);color:var(--ok)}",
      ".op-ws .pill.blocked{background:var(--danger-soft);color:var(--danger);text-transform:none;font-size:10px;padding:2px 8px}",
      ".op-ws .op-loading{color:var(--ink-4);font-family:var(--mono);font-size:12.5px;padding:16px 4px}",
      ".op-ws .op-err{color:var(--danger);font-family:var(--mono);font-size:12.5px;padding:16px 4px}",
    ].join("");
    document.head.appendChild(s);
  }

  // Responses may be wrapped as {data:...}. Unwrap while preserving falsy-but-
  // present payloads (empty arrays/objects). Arrays have no .data key so they
  // pass through unchanged.
  function unwrap(j) {
    if (j && typeof j === "object" && !Array.isArray(j) && "data" in j) return j.data;
    return j;
  }

  function sessionForPath(p) {
    var ss = view.sessions || [];
    for (var i = 0; i < ss.length; i++) {
      if (ss[i] && ss[i].cwd === p) return ss[i];
    }
    return null;
  }

  // ---- worktrees -----------------------------------------------------------

  function refreshWorktrees() {
    if (view.deleting || view.wtInFlight) return; // don't repaint mid-action
    view.wtInFlight = true;
    fetch("/api/worktrees", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) {
        view.wts = unwrap(j) || [];
        view.wtErr = false;
        drawWorktrees();
      })
      .catch(function () {
        view.wtErr = true;
        drawWorktrees();
      })
      .finally(function () {
        view.wtInFlight = false;
      });
  }

  function drawWorktrees() {
    var ctx = view.ctx;
    var sec = view.wtSecEl;
    if (!ctx || !sec) return;

    var wts = view.wts;
    var inUse = 0;
    if (Array.isArray(wts)) wts.forEach(function (w) { if (w.inUse) inUse++; });

    // Prune stale selections: only removable (loaded, still present, not in use)
    // worktrees can stay selected. An in-use worktree has no checkbox.
    var removable = {};
    if (Array.isArray(wts)) wts.forEach(function (w) { if (!w.inUse) removable[w.path] = true; });
    Array.from(view.selected).forEach(function (p) {
      if (!removable[p]) view.selected.delete(p);
    });
    var selCount = view.selected.size;

    var summary = wts === null || view.wtErr
      ? ""
      : wts.length + " worktree" + (wts.length === 1 ? "" : "s") + " · " + inUse + " in use";

    var bulk = "";
    if (selCount) {
      bulk =
        '<span class="cnt">' + selCount + " selected</span>" +
        '<button class="btn sm danger" id="wt-delsel"' + (view.deleting ? " disabled" : "") + ">" +
        ctx.icon.stop + (view.deleting ? "Removing…" : "Delete selected (" + selCount + ")") + "</button>" +
        '<button class="btn sm" id="wt-clear"' + (view.deleting ? " disabled" : "") + ">Clear</button>";
    }

    var head =
      '<div class="ws-shead">' +
        '<div class="ov-sec-label">Git Worktrees</div>' +
        '<div class="ws-summary">' + ctx.esc(summary) + "</div>" +
        '<div class="ws-bulk">' + bulk + "</div>" +
      "</div>";

    var body;
    if (view.wtErr) {
      body = '<div class="op-err">couldn\'t load worktrees</div>';
    } else if (wts === null) {
      body = '<div class="op-loading">Loading worktrees…</div>';
    } else if (!wts.length) {
      body =
        '<div class="op-empty">' + ctx.icon.grid +
        '<div class="t">No agent worktrees</div>' +
        '<div class="h">review/work handoffs create isolated worktrees under ~/.rook/worktrees</div>' +
        "</div>";
    } else {
      body = worktreeTable(wts, removable);
    }

    sec.innerHTML = head + body;
    wireWorktrees(wts, removable);
  }

  function worktreeTable(wts, removable) {
    var ctx = view.ctx, now = ctx.now();
    var removList = wts.filter(function (w) { return !w.inUse; });
    var allChecked =
      removList.length > 0 &&
      removList.every(function (w) { return view.selected.has(w.path); });

    var rows = wts.map(function (w) {
      var checked = view.selected.has(w.path);
      var cb = w.inUse
        ? '<td class="cb"></td>'
        : '<td class="cb"><input type="checkbox" data-path="' + ctx.esc(w.path) + '"' + (checked ? " checked" : "") + " /></td>";

      var namePill = w.inUse ? '<span class="pill busy">in use</span>' : "";
      var name = '<td><span class="wt-name">' + ctx.esc(w.name || "—") + namePill + "</span></td>";

      var repo = '<td><span class="wt-mono" title="' + ctx.esc(w.repo || "") + '">' + ctx.esc(w.repo || "—") + "</span></td>";
      var branch = '<td><span class="wt-mono" title="' + ctx.esc(w.branch || "") + '">' + ctx.esc(w.branch || "—") + "</span></td>";
      var age = '<td class="m">' + ctx.esc(w.created ? ctx.ago(w.created, now) : "—") + "</td>";

      var sess = sessionForPath(w.path);
      var agent = sess
        ? '<td><button class="wt-agent" data-sid="' + ctx.esc(sess.sessionId) + '" title="' + ctx.esc(sess.title || sess.project || "") + '">' + ctx.esc(sess.title || sess.project || "session") + "</button></td>"
        : '<td><span class="wt-none">—</span></td>';

      var removeBtn = w.inUse
        ? '<button class="btn sm danger" disabled title="stop the agent first">Remove</button>'
        : '<button class="btn sm danger" data-act="remove" data-path="' + ctx.esc(w.path) + '">Remove</button>';
      var actions =
        '<td class="act"><span class="row-act">' +
          '<button class="btn sm" data-act="open" data-path="' + ctx.esc(w.path) + '">' + ctx.icon.external + "Open in editor</button>" +
          removeBtn +
        "</span></td>";

      return '<tr class="' + (checked ? "sel" : "") + '">' + cb + name + repo + branch + age + agent + actions + "</tr>";
    }).join("");

    return (
      '<div class="ws-tablewrap"><table>' +
        '<thead><tr>' +
          '<th class="cb"><input type="checkbox" id="wt-all"' + (allChecked ? " checked" : "") + (removList.length ? "" : " disabled") + " /></th>" +
          "<th>Name</th><th>Repo</th><th>Branch</th><th>Age</th><th>Agent</th><th></th>" +
        "</tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table></div>"
    );
  }

  function wireWorktrees(wts, removable) {
    var sec = view.wtSecEl;
    if (!sec) return;

    var all = sec.querySelector("#wt-all");
    if (all) {
      all.addEventListener("change", function () {
        wts.forEach(function (w) {
          if (w.inUse) return;
          if (all.checked) view.selected.add(w.path);
          else view.selected.delete(w.path);
        });
        drawWorktrees();
      });
    }

    sec.querySelectorAll("tbody input[type=checkbox][data-path]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var p = cb.getAttribute("data-path");
        if (cb.checked) view.selected.add(p);
        else view.selected.delete(p);
        drawWorktrees();
      });
    });

    var del = sec.querySelector("#wt-delsel");
    if (del) del.addEventListener("click", function () { deleteWorktrees(Array.from(view.selected)); });
    var clear = sec.querySelector("#wt-clear");
    if (clear) clear.addEventListener("click", function () { view.selected.clear(); drawWorktrees(); });

    sec.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = b.getAttribute("data-path");
        if (b.getAttribute("data-act") === "open") openEditor(p);
        else deleteWorktrees([p]);
      });
    });

    sec.querySelectorAll(".wt-agent[data-sid]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (view.ctx && view.ctx.selectAgent) view.ctx.selectAgent(b.getAttribute("data-sid"));
      });
    });
  }

  // deleteWorktrees removes one or many worktrees. The Go handler takes a single
  // ?path= query param per call and no JSON body, so a multi-select delete loops
  // one DELETE per path. confirm() is synchronous and blocks the poll timer, so
  // no repaint lands mid-dialog; once accepted, view.deleting suppresses repaints
  // until the batch settles.
  function deleteWorktrees(paths) {
    if (view.deleting) return;
    paths = (paths || []).filter(Boolean);
    if (!paths.length) return;
    var msg = paths.length === 1
      ? "Remove this worktree?\n" + paths[0]
      : "Remove " + paths.length + " worktrees? This can't be undone.";
    if (!window.confirm(msg)) return;

    view.deleting = true;
    drawWorktrees();

    (async function () {
      async function del(p, force) {
        try {
          var r = await fetch("/api/worktrees?path=" + encodeURIComponent(p) + (force ? "&force=1" : ""), { method: "DELETE" });
          if (r.ok) return "ok";
          if (r.status === 409) return "dirty"; // uncommitted changes
          return "failed";
        } catch (e) { return "failed"; }
      }
      var ok = 0, failed = 0, dirty = [];
      for (var i = 0; i < paths.length; i++) {
        var res = await del(paths[i], false);
        if (res === "ok") ok++;
        else if (res === "dirty") dirty.push(paths[i]);
        else failed++;
      }
      // worktrees with uncommitted work aren't deleted silently — confirm first
      if (dirty.length && window.confirm(dirty.length + " worktree" + (dirty.length === 1 ? " has" : "s have") + " uncommitted changes. Delete anyway and discard that work?")) {
        for (var k = 0; k < dirty.length; k++) {
          if (await del(dirty[k], true) === "ok") ok++; else failed++;
        }
        dirty = [];
      }
      paths.forEach(function (p) { view.selected.delete(p); });
      view.deleting = false;
      var parts = ["Removed " + ok];
      if (failed) parts.push(failed + " failed");
      if (dirty.length) parts.push(dirty.length + " kept (uncommitted)");
      view.ctx.toast(parts.join(" · "), (failed || dirty.length) ? "err" : "ok");
      refreshWorktrees();
    })();
  }

  function openEditor(path) {
    if (!path) return;
    fetch("/api/open-editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error((j && ((j.error && (j.error.message || j.error)) || j.message)) || "http " + r.status);
          return j;
        });
      })
      .then(function () { view.ctx.toast("Opening in editor…", "ok"); })
      .catch(function (e) { view.ctx.toast("Couldn't open editor: " + (e && e.message ? e.message : "failed"), "err"); });
  }

  // ---- hooks ---------------------------------------------------------------

  function refreshHooks() {
    if (view.hkBusy || view.hkInFlight) return; // don't repaint mid-action
    view.hkInFlight = true;
    Promise.all([
      fetch("/api/hooks/status", { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }),
      fetch("/api/hooks/events", { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }),
    ])
      .then(function (res) {
        view.hooks = unwrap(res[0]) || {};
        view.events = unwrap(res[1]) || [];
        view.hkErr = false;
        drawHooks();
      })
      .catch(function () {
        view.hkErr = true;
        drawHooks();
      })
      .finally(function () {
        view.hkInFlight = false;
      });
  }

  function drawHooks() {
    var ctx = view.ctx;
    var sec = view.hkSecEl;
    if (!ctx || !sec) return;

    if (view.hkErr) {
      sec.innerHTML =
        '<div class="ws-shead"><div class="ov-sec-label">Claude Code Hooks</div>' +
        '<span class="pill dead">unavailable</span></div>' +
        '<div class="op-err">couldn\'t load hooks status</div>';
      return;
    }
    if (!view.hooks) {
      sec.innerHTML =
        '<div class="ws-shead"><div class="ov-sec-label">Claude Code Hooks</div>' +
        '<span class="pill idle">…</span></div>' +
        '<div class="op-loading">Loading hooks…</div>';
      return;
    }

    var h = view.hooks;
    var installed = !!h.installed;
    var busy = view.hkBusy;

    var pill = '<span class="pill ' + (installed ? "ok" : "dead") + '">' + (installed ? "installed" : "not installed") + "</span>";

    var paths =
      '<div class="hk-paths">' +
        pathChip("settings.json", h.settingsPath) +
        pathChip("hook script", h.scriptPath) +
        pathChip("events received", (h.events != null ? h.events : 0) + "") +
      "</div>";

    var actionBtn = installed
      ? '<button class="btn sm danger" id="hk-uninstall"' + (busy ? " disabled" : "") + ">" + (busy ? "Working…" : "Uninstall") + "</button>"
      : '<button class="btn sm primary" id="hk-install"' + (busy ? " disabled" : "") + ">" + ctx.icon.plus + (busy ? "Working…" : "Install") + "</button>";

    var toggle =
      '<label class="hk-toggle' + (busy ? " disabled" : "") + '">' +
        '<input type="checkbox" id="hk-gate"' + (h.gate ? " checked" : "") + (busy ? " disabled" : "") + " />" +
        "Destructive-command gate</label>";

    var card =
      '<div class="ins-card hk-card"><div class="hk-rows">' +
        paths +
        '<div class="hk-actions">' + actionBtn + toggle + "</div>" +
      "</div></div>";

    var evHead = '<div class="ov-sec-label" style="margin:0 0 10px">Recent hook events</div>';
    var evBody = hookEventsTable();

    sec.innerHTML =
      '<div class="ws-shead"><div class="ov-sec-label">Claude Code Hooks</div>' + pill + "</div>" +
      card + evHead + evBody;

    var ib = sec.querySelector("#hk-install");
    if (ib) ib.addEventListener("click", function () { hooksAction("/api/hooks/install", "hooks installed", false); });
    var ub = sec.querySelector("#hk-uninstall");
    if (ub) ub.addEventListener("click", function () { hooksAction("/api/hooks/uninstall", "hooks removed", true); });
    var gate = sec.querySelector("#hk-gate");
    if (gate) gate.addEventListener("change", function () { setGate(gate.checked); });
  }

  function pathChip(label, val) {
    var ctx = view.ctx;
    return (
      '<div class="hk-path">' +
        '<span class="k">' + ctx.esc(label) + "</span>" +
        '<span class="v" title="' + ctx.esc(val || "") + '">' + ctx.esc(val || "—") + "</span>" +
      "</div>"
    );
  }

  function hookEventsTable() {
    var ctx = view.ctx;
    var evs = view.events || [];
    if (!evs.length) {
      var installed = view.hooks && view.hooks.installed;
      return (
        '<div class="ws-tablewrap"><div class="op-empty">' + ctx.icon.trace +
        '<div class="t">No hook events yet</div>' +
        '<div class="h">' +
        (installed ? "run a Claude Code session to see them" : "install the hooks bridge to receive events") +
        "</div></div></div>"
      );
    }
    var now = ctx.now();
    var rows = evs.slice(0, 50).map(function (e) {
      var blocked = e.gated === "deny" ? '<span class="pill blocked">blocked</span>' : "";
      return (
        "<tr>" +
          '<td class="m">' + ctx.esc(e.time ? ctx.ago(e.time, now) : "—") + "</td>" +
          '<td class="m">' + ctx.esc(e.event || "—") + "</td>" +
          '<td class="m">' + ctx.esc(e.tool || "—") + "</td>" +
          "<td>" + ctx.esc(e.project || "—") + "</td>" +
          '<td class="act">' + blocked + "</td>" +
        "</tr>"
      );
    }).join("");
    return (
      '<div class="ws-tablewrap"><table>' +
        "<thead><tr><th>Time</th><th>Event</th><th>Tool</th><th>Project</th><th></th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table></div>"
    );
  }

  function hooksAction(url, okMsg, needConfirm) {
    if (view.hkBusy) return;
    // confirm() blocks the poll timer, so no repaint lands mid-dialog.
    if (needConfirm && !window.confirm("Uninstall rook hooks from Claude Code settings.json?")) return;
    view.hkBusy = true;
    drawHooks();
    fetch(url, { method: "POST" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) {
        view.hooks = unwrap(j) || view.hooks;
        view.ctx.toast(okMsg, "ok");
      })
      .catch(function () {
        view.ctx.toast("Action failed", "err");
      })
      .finally(function () {
        view.hkBusy = false;
        refreshHooks();
      });
  }

  function setGate(on) {
    if (view.hkBusy) return;
    view.hkBusy = true;
    if (view.hooks) view.hooks.gate = on; // optimistic; confirmed on next refresh
    drawHooks();
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hooksGate: on }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        view.ctx.toast(on ? "destructive-command gate on" : "gate off", "");
      })
      .catch(function () {
        if (view.hooks) view.hooks.gate = !on; // roll back optimistic flip
        view.ctx.toast("couldn't save", "err");
      })
      .finally(function () {
        view.hkBusy = false;
        refreshHooks();
      });
  }

  // ---- view registration ---------------------------------------------------

  window.OP_VIEWS["workspace"] = {
    build: function (host, ctx) {
      injectCSS();
      view.ctx = ctx;
      view.selected = view.selected || new Set();
      view.wts = null;
      view.wtErr = false;
      view.hooks = null;
      view.hkErr = false;

      // NEVER set host.className — it would break #opView. Mount into an inner
      // wrapper that carries the .ins + .op-ws styling instead.
      host.innerHTML = '<div class="ins op-ws"></div>';
      view.host = host.firstChild;

      view.wtSecEl = ctx.el("section", "ws-sec ws-sec-wt");
      view.hkSecEl = ctx.el("section", "ws-sec ws-sec-hk");
      view.host.appendChild(view.wtSecEl);
      view.host.appendChild(view.hkSecEl);

      // paint loading state; render() is called immediately after build() and on
      // every 2s poll, and kicks off the fetches.
      drawWorktrees();
      drawHooks();
    },

    render: function (state, ctx) {
      if (ctx) view.ctx = ctx;
      view.sessions = (state && state.sessions) || [];
      refreshWorktrees();
      refreshHooks();
    },
  };
})();
