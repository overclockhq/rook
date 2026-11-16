/* operator-guardrails.js — Guardrails view (window.OP_VIEWS["guardrails"]).
   What keeps Claude safe and honest on this Mac: the user's own hook scripts
   (with double-gating warnings against rook's bridge), permission rules, the
   per-repo gate, the hook self-test and the morning brief job. rook's own hooks
   bridge is managed in the Workspace view; this page links there and only
   reports on it. Data comes from /api/guardrails (fetched on open and on
   Refresh, not every poll: it runs git status across repos). The 2s render()
   tick only polls a running gate or self-test. */
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var TABS = [["hooks", "Safety hooks"], ["perms", "Permissions"], ["gate", "Gate"], ["selftest", "Self-test"], ["brief", "Morning brief"]];
  var gv = {
    host: null, ctx: null, data: null, err: "", loading: false,
    tab: "hooks", gateSel: "", gateDetail: null, gateBusy: {}, toggling: {},
    selftest: null, briefSel: "", briefText: null, briefErr: "", polling: false
  };
  try { var t0 = localStorage.getItem("opGuardrailsTab"); if (t0) gv.tab = t0; } catch (e) {}

  function injectCSS() {
    if (document.getElementById("op-guardrails-css")) return;
    var s = document.createElement("style");
    s.id = "op-guardrails-css";
    s.textContent = [
      ".op-guardrails{display:flex;flex-direction:column;overflow:hidden}",
      ".op-guardrails .gr-head{display:flex;align-items:center;gap:12px;flex:none;margin-bottom:6px;min-height:30px;flex-wrap:wrap}",
      ".op-guardrails .gr-head .ov-sec-label{margin:0}",
      ".op-guardrails .gr-sub{font-size:12px;color:var(--ink-3)}",
      ".op-guardrails .gr-head .sp{margin-left:auto;display:flex;gap:8px;align-items:center}",
      ".op-guardrails .gr-link{background:none;border:none;padding:0;color:var(--coral);cursor:pointer;font-size:12px;font-family:var(--sans)}",
      ".op-guardrails .gr-link:hover{text-decoration:underline}",
      ".op-guardrails .ws-tabs{padding:0;margin-bottom:14px}",
      ".op-guardrails .gr-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;overflow:hidden}",
      ".op-guardrails .gr-scroll{flex:1;min-height:0;overflow:auto}",
      ".op-guardrails .gr-tablewrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}",
      ".op-guardrails table{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".op-guardrails thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface-2);white-space:nowrap;z-index:1}",
      ".op-guardrails tbody td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-2)}",
      ".op-guardrails tbody tr:last-child td{border-bottom:none}",
      ".op-guardrails tbody tr:hover{background:var(--surface-2)}",
      ".op-guardrails tbody tr.sel{background:var(--coral-soft)}",
      ".op-guardrails tr.ev td{background:var(--surface-2);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:500;padding:7px 12px}",
      ".op-guardrails tr.rook td{color:var(--ink-3)}",
      ".op-guardrails .m{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums}",
      ".op-guardrails .nw{white-space:nowrap}",
      ".op-guardrails .purpose{color:var(--ink);line-height:1.4}",
      ".op-guardrails .cmd{font-family:var(--mono);font-size:11px;color:var(--ink-4);margin-top:3px;word-break:break-all}",
      ".op-guardrails .muted{color:var(--ink-4)}",
      ".op-guardrails .chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--surface-3);color:var(--ink-3);white-space:nowrap}",
      ".op-guardrails .chip.ok{background:var(--ok-soft);color:var(--ok)}",
      ".op-guardrails .chip.bad{background:var(--danger-soft);color:var(--danger)}",
      ".op-guardrails .chip.warn{background:var(--waiting-soft);color:var(--waiting)}",
      ".op-guardrails .chip.run{background:var(--busy-soft);color:var(--busy)}",
      ".op-guardrails .chip.rk{background:var(--coral-soft);color:var(--coral)}",
      ".op-guardrails .banner{border:1px solid var(--line);border-left:3px solid var(--ink-4);border-radius:var(--radius);background:var(--surface);padding:10px 14px;font-size:12.5px;color:var(--ink-2);display:flex;gap:10px;align-items:flex-start;flex:none}",
      ".op-guardrails .banner svg{width:16px;height:16px;flex:none;margin-top:1px}",
      ".op-guardrails .banner.warn{border-left-color:var(--waiting)}",
      ".op-guardrails .banner.warn svg{color:var(--waiting)}",
      ".op-guardrails .banner.bad{border-left-color:var(--danger)}",
      ".op-guardrails .banner.bad svg{color:var(--danger)}",
      ".op-guardrails .banner b{color:var(--ink);font-weight:600}",
      ".op-guardrails .banner .m{color:var(--ink-3)}",
      ".op-guardrails .card{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:12px 14px;margin-bottom:10px}",
      ".op-guardrails .card-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".op-guardrails .card-h .t{font-weight:500;color:var(--ink);font-size:13px}",
      ".op-guardrails .card-h .counts{margin-left:auto;display:flex;gap:6px}",
      ".op-guardrails details{margin-top:8px}",
      ".op-guardrails summary{cursor:pointer;font-size:12px;color:var(--ink-3)}",
      ".op-guardrails summary:hover{color:var(--ink-2)}",
      ".op-guardrails ol.plist{margin:6px 0 0;padding-left:28px;font-family:var(--mono);font-size:11.5px;color:var(--ink-2);line-height:1.7}",
      ".op-guardrails .flag{color:var(--danger);font-size:12px;margin-top:6px;display:flex;gap:8px;align-items:flex-start}",
      ".op-guardrails .flag svg{width:14px;height:14px;flex:none;margin-top:1px}",
      ".op-guardrails .split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,42%);grid-template-rows:minmax(0,1fr);gap:12px}",
      ".op-guardrails .split.one{grid-template-columns:minmax(0,1fr)}",
      ".op-guardrails .pane{display:flex;flex-direction:column;min-height:0;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);overflow:hidden}",
      ".op-guardrails .pane-h{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex:none;font-size:12.5px;color:var(--ink-2)}",
      ".op-guardrails .pane-h .t{font-weight:500;color:var(--ink)}",
      ".op-guardrails .pane-h .sp{margin-left:auto}",
      ".op-guardrails pre.out{flex:1;min-height:0;overflow:auto;margin:0;padding:12px 14px;font-family:var(--mono);font-size:11.5px;line-height:1.55;color:var(--ink-2);white-space:pre-wrap;word-break:break-word}",
      ".op-guardrails .sw{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--ink-2)}",
      ".op-guardrails .sw input{position:absolute;opacity:0;width:0;height:0}",
      ".op-guardrails .sw .tr{width:30px;height:17px;border-radius:999px;background:var(--surface-3);border:1px solid var(--line-2);position:relative;transition:background .12s}",
      ".op-guardrails .sw .tr::after{content:'';position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--ink-3);transition:transform .12s,background .12s}",
      ".op-guardrails .sw input:checked + .tr{background:var(--ok-soft);border-color:var(--ok)}",
      ".op-guardrails .sw input:checked + .tr::after{transform:translateX(13px);background:var(--ok)}",
      ".op-guardrails .sw input:focus-visible + .tr{outline:2px solid var(--coral-line);outline-offset:2px}",
      ".op-guardrails .sw.busy{opacity:.5;pointer-events:none}",
      ".op-guardrails .row-act{display:inline-flex;gap:6px;justify-content:flex-end}",
      ".op-guardrails td.act{text-align:right;white-space:nowrap}",
      ".op-guardrails .kv{display:flex;flex-wrap:wrap;gap:10px 26px;margin-top:8px}",
      ".op-guardrails .kv .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4)}",
      ".op-guardrails .kv .v{font-size:12.5px;color:var(--ink-2);margin-top:2px}",
      ".op-guardrails .briefs{list-style:none;margin:0;padding:6px;overflow:auto;flex:1;min-height:0}",
      ".op-guardrails .briefs button{width:100%;display:flex;justify-content:space-between;gap:10px;padding:7px 10px;border-radius:var(--radius-sm);background:none;border:none;color:var(--ink-2);font-family:var(--mono);font-size:12px;cursor:pointer;text-align:left}",
      ".op-guardrails .briefs button:hover{background:var(--surface-2)}",
      ".op-guardrails .briefs button.on{background:var(--coral-soft);color:var(--ink)}",
      ".op-guardrails .briefs .sz{color:var(--ink-4)}",
      ".op-guardrails .st-res{margin-bottom:10px}",
      ".op-guardrails .st-res pre.out{max-height:240px;border-top:1px solid var(--line);margin-top:10px;padding:10px 0 0}",
      ".op-guardrails .op-empty{padding:40px 20px}",
      ".op-guardrails .op-empty .h{max-width:560px;line-height:1.6}",
      ".op-guardrails .gr-err{color:var(--danger);font-family:var(--mono);font-size:12.5px;padding:16px 4px}"
    ].join("");
    document.head.appendChild(s);
  }

  function c() { return gv.ctx; }
  function e(v) { return c().esc(v == null ? "" : String(v)); }
  function unwrap(j) { return (j && typeof j === "object" && !Array.isArray(j) && "data" in j) ? j.data : j; }
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j = unwrap(j);
        if (!r.ok) throw new Error((j && j.message) || (j && j.error && j.error.message) || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function postJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j = unwrap(j);
        if (!r.ok) throw new Error((j && j.error && j.error.message) || (j && j.message) || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function home(p) { return String(p || "").replace(/^\/Users\/[^/]+/, "~"); }
  function base(p) { var s = String(p || ""); return s.slice(s.lastIndexOf("/") + 1); }
  function dur(ms) { if (ms == null) return ""; var s = Math.round(ms / 1000); if (s < 60) return s + "s"; return Math.floor(s / 60) + "m " + (s % 60) + "s"; }
  function size(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB"; }
  function empty(icon, title, hint) { return '<div class="op-empty">' + icon + '<div class="t">' + e(title) + '</div><div class="h">' + hint + "</div></div>"; }

  function load() {
    if (gv.loading) return;
    gv.loading = true; paint();
    getJSON("/api/guardrails").then(function (j) { gv.data = j; gv.err = ""; })
      .catch(function (er) { gv.err = er.message || "failed to load"; })
      .finally(function () { gv.loading = false; paint(); });
  }

  // ---- shell ------------------------------------------------------------------
  function paint() {
    var host = gv.host; if (!host) return;
    var d = gv.data;
    var badge = {};
    if (d) {
      badge.hooks = (d.conflicts || []).length ? '<span class="tab-badge" title="possible double-gating">' + d.conflicts.length + "!</span>" : '<span class="tab-badge">' + (d.hooks || []).filter(function (h) { return !h.rook; }).length + "</span>";
      var flags = 0; (d.permissions || []).forEach(function (p) { flags += (p.flags || []).length; });
      if (flags) badge.perms = '<span class="tab-badge">' + flags + "!</span>";
      badge.gate = '<span class="tab-badge">' + (d.gate || []).length + "</span>";
      badge.brief = '<span class="tab-badge">' + ((d.morning && d.morning.briefs) || []).length + "</span>";
    }
    var scrollers = {};
    host.querySelectorAll("[data-keep]").forEach(function (n) { scrollers[n.dataset.keep] = n.scrollTop; });

    host.innerHTML =
      '<div class="gr-head"><div class="ov-sec-label">Guardrails</div>' +
        '<span class="gr-sub">Your hooks, permissions and the gate. rook\'s own hooks bridge is managed in <button class="gr-link" data-go="workspace">Workspace</button>.</span>' +
        '<span class="sp"><button class="btn sm" data-act="refresh">' + c().icon.resume + (gv.loading ? "Loading…" : "Refresh") + "</button></span></div>" +
      '<div class="ws-tabs">' + TABS.map(function (t) {
        return '<button class="ws-tab' + (gv.tab === t[0] ? " on" : "") + '" data-tab="' + t[0] + '">' + e(t[1]) + (badge[t[0]] || "") + "</button>";
      }).join("") + "</div>" +
      '<div class="gr-body">' + body() + "</div>";

    host.querySelectorAll("[data-keep]").forEach(function (n) { if (scrollers[n.dataset.keep]) n.scrollTop = scrollers[n.dataset.keep]; });
    var out = host.querySelector("pre.out.live"); if (out) out.scrollTop = out.scrollHeight;
    wire();
  }

  function body() {
    if (!gv.data) {
      if (gv.err) return '<div class="gr-err">Could not load guardrails: ' + e(gv.err) + "</div>";
      return '<div class="muted m" style="padding:16px 4px">Reading your Claude setup…</div>';
    }
    if (gv.tab === "perms") return permsTab();
    if (gv.tab === "gate") return gateTab();
    if (gv.tab === "selftest") return selftestTab();
    if (gv.tab === "brief") return briefTab();
    return hooksTab();
  }

  // ---- safety hooks -------------------------------------------------------------
  function healthChip(h) {
    if (h.health === "ok") return '<span class="chip ok">ok</span>';
    if (h.health === "missing") return '<span class="chip bad" title="' + e(h.script) + ' does not exist">script missing</span>';
    if (h.health === "not-executable") return '<span class="chip bad" title="chmod +x ' + e(h.script) + '">not executable</span>';
    return '<span class="chip" title="runs an inline command, not a script file">inline</span>';
  }
  function srcLabel(s, repo) {
    var name = repo ? base(repo) : "";
    if (s === "global") return "global";
    if (s === "global-local") return "global · local";
    if (s === "repo-local") return name + " · local";
    return name || "repo";
  }

  function hooksTab() {
    var d = gv.data, hooks = d.hooks || [];
    var html = "";
    (d.conflicts || []).forEach(function (cf) {
      html += '<div class="banner ' + (cf.severity === "warn" ? "warn" : "") + '">' + c().icon.alert + "<div>" +
        "<b>" + e(cf.event) + ": rook and your hooks both run</b> · rook matcher <span class=\"m\">" + e(cf.rookMatcher || "(all)") + "</span> overlaps yours <span class=\"m\">" +
        e((cf.userMatchers || []).map(function (m) { return m || "(all)"; }).join(", ")) + "</span><br>" + e(cf.note) +
        ' Nothing has been changed. To keep one, remove the other: rook\'s bridge in <button class="gr-link" data-go="workspace">Workspace</button>, yours in ~/.claude/settings.json.</div></div>';
    });
    if (d.statusline) {
      var sl = d.statusline;
      html += '<div class="banner">' + c().icon.terminal + "<div><b>Statusline</b> · " + e(sl.purpose || "custom command") +
        ' <span class="m">' + e(home(sl.command)) + "</span> " + (sl.script && !sl.exists ? '<span class="chip bad">script missing</span>' : "") + "</div></div>";
    }
    if (!hooks.length) {
      return html + empty(c().icon.alert, "No hooks registered",
        "Hooks are scripts Claude Code runs on events such as PreToolUse (before a tool call, can allow / ask / deny) and Stop (when a session ends). Add them under \"hooks\" in ~/.claude/settings.json or a repo's .claude/settings.json.");
    }
    var byEv = {}, order = [];
    hooks.forEach(function (h) { if (!byEv[h.event]) { byEv[h.event] = []; order.push(h.event); } byEv[h.event].push(h); });
    var rows = order.map(function (ev) {
      var r = '<tr class="ev"><td colspan="5">' + e(ev) + " · " + byEv[ev].length + "</td></tr>";
      return r + byEv[ev].map(function (h) {
        return '<tr class="' + (h.rook ? "rook" : "") + '">' +
          '<td class="m nw">' + e(h.matcher || "(all)") + "</td>" +
          '<td><div class="purpose">' + (h.rook ? '<span class="chip rk">rook</span> ' : "") + e(h.purpose || (h.rook ? "rook hooks bridge" : "No description in the script header")) + "</div>" +
            '<div class="cmd">' + e(home(h.command)) + "</div></td>" +
          '<td class="nw" title="' + e(home(h.file)) + '">' + e(srcLabel(h.source, h.repo)) + "</td>" +
          '<td class="nw">' + healthChip(h) + "</td>" +
          '<td class="m nw">' + (h.timeout ? e(h.timeout) + "s" : '<span class="muted">default</span>') + "</td></tr>";
      }).join("");
    }).join("");
    return html + '<div class="gr-tablewrap" data-keep="hooks"><table><thead><tr><th>Matcher</th><th>What it does</th><th>Source</th><th>Health</th><th>Timeout</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }

  // ---- permissions ----------------------------------------------------------------
  function permsTab() {
    var sets = gv.data.permissions || [];
    if (!sets.length) {
      return empty(c().icon.file, "No permission rules",
        "Permission rules decide which tool calls run without asking (allow), always prompt (ask) or never run (deny). Set them under \"permissions\" in ~/.claude/settings.json or a repo's .claude/settings.json.");
    }
    var html = sets.map(function (p) {
      var counts = '<span class="counts"><span class="chip ok">' + p.allowCount + " allow</span>" +
        '<span class="chip warn">' + p.askCount + " ask</span>" +
        '<span class="chip bad">' + p.denyCount + " deny</span></span>";
      var out = '<div class="card"><div class="card-h"><span class="t">' + e(srcLabel(p.source, p.repo)) + '</span><span class="m muted">' + e(home(p.file)) + "</span>" + counts + "</div>";
      if (p.error) out += '<div class="flag">' + c().icon.alert + "<span>This file is not valid JSON, so Claude Code may ignore it.</span></div>";
      if (p.local) out += '<div class="muted" style="font-size:12px;margin-top:6px">Local settings are machine-specific and often hold one-off approvals; only counts are shown.</div>';
      (p.flags || []).forEach(function (f) {
        out += '<div class="flag">' + c().icon.alert + "<span>" + e(f.message) + ". Rotate that credential, then delete the entry from " + e(base(p.file)) + ". The text is not shown here.</span></div>";
      });
      if (!p.local) {
        [["allow", p.allow], ["ask", p.ask], ["deny", p.deny]].forEach(function (l) {
          if (!l[1] || !l[1].length) return;
          out += "<details><summary>" + l[1].length + " " + l[0] + " rules</summary><ol class=\"plist\">" +
            l[1].map(function (x) { return "<li>" + e(x) + "</li>"; }).join("") + "</ol></details>";
        });
      }
      return out + "</div>";
    }).join("");
    return '<div class="gr-scroll" data-keep="perms">' + html + "</div>";
  }

  // ---- gate -----------------------------------------------------------------------------
  function runChip(r) {
    if (!r || r.status === "none") return '<span class="chip">not run</span>';
    var t = r.status === "running" ? "running " + dur(r.durationMs) : r.status + (r.durationMs ? " · " + dur(r.durationMs) : "");
    var cls = { pass: "ok", fail: "bad", error: "bad", running: "run", nothing: "" }[r.status] || "";
    return '<span class="chip ' + cls + '" title="exit ' + e(r.exitCode) + '">' + e(t) + "</span>";
  }

  function gateTab() {
    var d = gv.data, rows = d.gate || [];
    var html = "";
    if (!d.gateScriptOk) {
      html += '<div class="banner bad">' + c().icon.alert + "<div><b>Gate script not found</b> <span class=\"m\">" + e(home(d.gateScript)) +
        "</span><br>The gate is the definition of done for Go changes (build, tests, coverage, lint). Run gate is disabled until the script exists.</div></div>";
    }
    if (!rows.length) {
      return html + empty(c().icon.check, "No Go repos found",
        "The gate checks repos with a go.mod. rook finds repos where agents run, one level under common folders, and under repoRoots in ~/.rook/config.json.");
    }
    var trs = rows.map(function (r) {
      var busy = gv.gateBusy[r.path] || (r.last && r.last.status === "running");
      var tog = !!gv.toggling[r.path];
      return '<tr class="' + (gv.gateSel === r.path ? "sel" : "") + '" data-row="' + e(r.path) + '">' +
        '<td><div style="color:var(--ink);font-weight:500">' + e(r.name) + '</div><div class="cmd">' + e(home(r.path)) + "</div></td>" +
        '<td class="m nw">' + e(r.branch || "—") + "</td>" +
        '<td class="m nw">' + (r.dirty < 0 ? "?" : r.dirty === 0 ? '<span class="muted">clean</span>' : e(r.dirty)) + "</td>" +
        '<td class="nw"><label class="sw' + (tog ? " busy" : "") + '" title="Stop hook gate for this repo (off = .claude/gate-off exists)"><input type="checkbox" data-toggle="' + e(r.path) + '"' + (r.gateOff ? "" : " checked") + '><span class="tr"></span>' + (r.gateOff ? "off" : "on") + "</label></td>" +
        '<td class="nw">' + runChip(r.last) + (r.last && r.last.finishedAt ? ' <span class="muted m">' + c().ago(r.last.finishedAt, Date.now()) + " ago</span>" : "") + "</td>" +
        '<td class="act"><span class="row-act">' +
          '<button class="btn sm" data-run="' + e(r.path) + '"' + (busy || !d.gateScriptOk ? " disabled" : "") + ">" + (busy ? "Running…" : "Run gate") + "</button>" +
          (r.last ? '<button class="btn sm" data-out="' + e(r.path) + '">Output</button>' : "") +
        "</span></td></tr>";
    }).join("");
    var table = '<div class="gr-tablewrap" data-keep="gate"><table><thead><tr><th>Repo</th><th>Branch</th><th>Dirty</th><th>Gate</th><th>Last run</th><th></th></tr></thead><tbody>' + trs + "</tbody></table></div>";
    var det = gv.gateDetail && gv.gateDetail.repo === gv.gateSel ? gv.gateDetail : null;
    if (!gv.gateSel) return html + '<div class="split one">' + table + "</div>";
    var pane = '<div class="pane"><div class="pane-h"><span class="t">' + e(base(gv.gateSel)) + "</span>" + runChip(det) +
      (det && det.totalLines > 400 ? '<span class="muted m">last 400 of ' + det.totalLines + " lines</span>" : "") +
      '<span class="sp"><button class="btn xs" data-act="close-out">' + c().icon.x + "</button></span></div>" +
      '<pre class="out' + (det && det.status === "running" ? " live" : "") + '">' +
        (det ? e(det.output || (det.status === "running" ? "Starting…" : "(no output)")) + (det.error ? "\n\n" + e(det.error) : "") : "Loading…") + "</pre></div>";
    return html + '<div class="split">' + table + pane + "</div>";
  }

  function fetchGate(repo) {
    return getJSON("/api/guardrails/gate?repo=" + encodeURIComponent(repo)).then(function (r) {
      if (gv.gateSel === repo) gv.gateDetail = r;
      var row = (gv.data.gate || []).filter(function (x) { return x.path === repo; })[0];
      if (row && r.status !== "none") row.last = r;
      if (r.status !== "running") delete gv.gateBusy[repo];
      return r;
    });
  }

  function runGate(repo) {
    gv.gateBusy[repo] = true; gv.gateSel = repo; gv.gateDetail = null; paint();
    postJSON("/api/guardrails/gate", { repo: repo }).then(function (r) {
      gv.gateDetail = r; var row = (gv.data.gate || []).filter(function (x) { return x.path === repo; })[0]; if (row) row.last = r;
      c().toast("Gate started in " + base(repo), "");
      paint();
    }).catch(function (er) { delete gv.gateBusy[repo]; c().toast(er.message, "err"); paint(); });
  }

  function toggleGate(repo, on) {
    gv.toggling[repo] = true; paint();
    postJSON("/api/guardrails/gate-toggle", { repo: repo, off: !on }).then(function (r) {
      var row = (gv.data.gate || []).filter(function (x) { return x.path === repo; })[0];
      if (row) row.gateOff = !!r.gateOff;
      c().toast("Gate " + (r.gateOff ? "off" : "on") + " for " + base(repo), "ok");
    }).catch(function (er) { c().toast(er.message, "err"); })
      .finally(function () { delete gv.toggling[repo]; paint(); });
  }

  // ---- self-test ------------------------------------------------------------------------
  function selftestTab() {
    var st = gv.selftest;
    var running = st && st.status === "running";
    var html = '<div class="banner">' + c().icon.check + "<div><b>Hook self-test</b> runs ~/.claude/hooks/tests/guard_test.sh and agent_hooks_test.sh. They feed sample tool calls to your guard hooks in temp dirs and check each allow / ask / deny decision. Nothing in your repos is touched." +
      '</div><span style="margin-left:auto"><button class="btn sm primary" data-act="selftest"' + (running ? " disabled" : "") + ">" + (running ? "Running…" : "Run self-test") + "</button></span></div>";
    if (!st || st.status === "none") return html + empty(c().icon.check, "Not run yet", "Run it after you edit a hook script to make sure the guard still decides as you expect.");
    if (st.status === "missing") return html + empty(c().icon.alert, "No test scripts found", "Expected ~/.claude/hooks/tests/guard_test.sh and agent_hooks_test.sh. Each prints FAIL lines and a final \"N passed, M failed\" line.");
    var res = (st.results || []).map(function (r) {
      var chip = r.missing ? '<span class="chip">missing</span>' :
        (r.fail || r.error || r.exitCode) ? '<span class="chip bad">' + r.fail + " failed</span>" : '<span class="chip ok">passed</span>';
      var out = '<div class="card st-res"><div class="card-h"><span class="t m">' + e(r.name) + "</span>" + chip +
        (r.missing ? "" : '<span class="m muted">' + r.pass + " passed · " + r.fail + " failed · " + dur(r.durationMs) + "</span>") + "</div>";
      if (r.error) out += '<div class="flag">' + c().icon.alert + "<span>" + e(r.error) + "</span></div>";
      if (r.failing && r.failing.length) out += '<pre class="out">' + e(r.failing.join("\n")) + "</pre>";
      return out + "</div>";
    }).join("");
    if (running) res = '<div class="muted m" style="padding:8px 2px">Running… started ' + c().ago(st.startedAt, Date.now()) + " ago</div>";
    return html + '<div class="gr-scroll" data-keep="st">' + res + "</div>";
  }

  function runSelftest() {
    postJSON("/api/guardrails/selftest", {}).then(function (s) { gv.selftest = s; paint(); })
      .catch(function (er) { c().toast(er.message, "err"); });
  }

  // ---- morning brief ----------------------------------------------------------------------
  function briefTab() {
    var m = gv.data.morning || {};
    var job = '<div class="card"><div class="card-h"><span class="t">Morning brief job</span>' +
      (m.loaded ? '<span class="chip ok">loaded</span>' : m.plistExists ? '<span class="chip warn">not loaded</span>' : '<span class="chip">not installed</span>') +
      (m.running ? '<span class="chip run">running now</span>' : "") + "</div>" +
      '<div class="kv"><div><div class="k">Schedule</div><div class="v">' + e(m.schedule || "—") + "</div></div>" +
      '<div><div class="k">Last exit</div><div class="v m">' + e(m.lastExit || "—") + "</div></div>" +
      '<div><div class="k">Script</div><div class="v m">' + e(home(m.program) || "—") + "</div></div>" +
      '<div><div class="k">launchd label</div><div class="v m">' + e(m.label) + "</div></div></div>" +
      (!m.plistExists ? '<div class="muted" style="font-size:12px;margin-top:8px">No ' + e(home(m.plistPath)) + ". The job is a launchd agent that writes a daily brief to " + e(home(m.dir)) + "/YYYY-MM-DD.md.</div>" :
        !m.loaded ? '<div class="muted" style="font-size:12px;margin-top:8px">Load it with <span class="m">launchctl load ' + e(home(m.plistPath)) + "</span></div>" : "") +
      "</div>";
    var briefs = m.briefs || [];
    if (!briefs.length) {
      return job + empty(c().icon.note, "No briefs yet", "Briefs appear here after the job runs: one markdown file per day in " + e(home(m.dir)) + ".");
    }
    if (!gv.briefSel) { gv.briefSel = briefs[0].date; fetchBrief(gv.briefSel); }
    var list = '<div class="pane"><div class="pane-h"><span class="t">Briefs</span><span class="muted m">' + briefs.length + '</span></div><ul class="briefs" data-keep="briefs">' +
      briefs.map(function (b) { return '<li><button class="' + (b.date === gv.briefSel ? "on" : "") + '" data-brief="' + e(b.date) + '"><span>' + e(b.date) + '</span><span class="sz">' + size(b.size) + "</span></button></li>"; }).join("") + "</ul></div>";
    var text = gv.briefErr ? '<span style="color:var(--danger)">' + e(gv.briefErr) + "</span>" : gv.briefText == null ? "Loading…" : e(gv.briefText || "(empty)");
    var view = '<div class="pane"><div class="pane-h"><span class="t m">' + e(gv.briefSel) + '.md</span></div><pre class="out" data-keep="brieftext">' + text + "</pre></div>";
    return job + '<div class="split" style="grid-template-columns:240px minmax(0,1fr)">' + list + view + "</div>";
  }

  function fetchBrief(date) {
    gv.briefText = null; gv.briefErr = "";
    getJSON("/api/guardrails/brief?date=" + encodeURIComponent(date)).then(function (j) {
      if (gv.briefSel === date) gv.briefText = j.markdown || "";
    }).catch(function (er) { if (gv.briefSel === date) gv.briefErr = er.message; })
      .finally(function () { if (gv.tab === "brief") paint(); });
  }

  // ---- wiring --------------------------------------------------------------------------------
  function wire() {
    var h = gv.host;
    h.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { gv.tab = b.dataset.tab; try { localStorage.setItem("opGuardrailsTab", gv.tab); } catch (er) {} paint(); });
    });
    h.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () { var r = document.querySelector('.op-rail-btn[data-view="' + b.dataset.go + '"]'); if (r) r.click(); });
    });
    h.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function () {
        var a = b.dataset.act;
        if (a === "refresh") load();
        else if (a === "selftest") runSelftest();
        else if (a === "close-out") { gv.gateSel = ""; gv.gateDetail = null; paint(); }
      });
    });
    h.querySelectorAll("[data-run]").forEach(function (b) { b.addEventListener("click", function (ev) { ev.stopPropagation(); runGate(b.dataset.run); }); });
    h.querySelectorAll("[data-out]").forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.stopPropagation(); gv.gateSel = b.dataset.out; gv.gateDetail = null; paint(); fetchGate(gv.gateSel).then(paint); });
    });
    h.querySelectorAll("[data-toggle]").forEach(function (cb) {
      cb.addEventListener("click", function (ev) { ev.stopPropagation(); });
      cb.addEventListener("change", function () { toggleGate(cb.dataset.toggle, cb.checked); });
    });
    h.querySelectorAll("[data-brief]").forEach(function (b) {
      b.addEventListener("click", function () { gv.briefSel = b.dataset.brief; fetchBrief(gv.briefSel); paint(); });
    });
  }

  // poll only what is running: an open gate's output, running gates, the self-test
  function poll() {
    if (gv.polling || !gv.data) return;
    var jobs = [];
    (gv.data.gate || []).forEach(function (r) {
      if (gv.gateBusy[r.path] || (r.last && r.last.status === "running")) jobs.push(fetchGate(r.path));
    });
    if (gv.gateSel && gv.gateDetail && gv.gateDetail.status === "running" && !jobs.length) jobs.push(fetchGate(gv.gateSel));
    if (gv.selftest && gv.selftest.status === "running") {
      jobs.push(getJSON("/api/guardrails/selftest").then(function (s) { gv.selftest = s; }));
    }
    if (!jobs.length) return;
    gv.polling = true;
    Promise.all(jobs.map(function (p) { return p.catch(function () {}); })).finally(function () { gv.polling = false; paint(); });
  }

  window.OP_VIEWS["guardrails"] = {
    build: function (host, ctx) {
      injectCSS(); gv.ctx = ctx;
      host.innerHTML = '<div class="ins op-guardrails"></div>'; gv.host = host.firstChild;
      gv.briefSel = ""; gv.briefText = null;
      paint(); load();
      getJSON("/api/guardrails/selftest").then(function (s) { gv.selftest = s; paint(); }).catch(function () {});
    },
    render: function (state, ctx) { gv.ctx = ctx || gv.ctx; poll(); }
  };
})();
