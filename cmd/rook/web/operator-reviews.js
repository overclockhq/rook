// operator-reviews.js — Reviews view (window.OP_VIEWS["reviews"]).
// Runs the user's senior-review pipeline (tech-lead agent, then
// finding-verifier on blocker/major findings) on a PR or a local branch and
// shows ranked, verified findings. Left: start form + runs; right: one run.
//
// Server shapes (reviews.go):
//   POST /api/reviews              {repo,pr,path?} | {path,base} -> run
//   GET  /api/reviews              -> [run]   (newest first, no raw output)
//   GET  /api/reviews/{id}         -> run incl. rawReview / rawVerify
//   POST /api/reviews/{id}/cancel  -> {ok}
// run = {id,kind,repo,pr,path,base,status,error,verdict,intent,blastRadius,
//        findings:[{id,severity,lens,file,line,claim,failure_scenario,evidence,
//        fix,verification:{verdict,evidence,note}}],questions,counts,
//        diffFiles,diffAdd,diffDel,costUsd,turns,verifyCostUsd,verifyTurns,
//        verifyError,createdAt,startedAt,finishedAt}
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  var SEV = ["blocker", "major", "minor", "nit"];
  var ACTIVE = { queued: 1, reviewing: 1, verifying: 1 };

  var st = {
    ctx: null, refs: null,
    runs: [], loaded: false, listErr: "", listBusy: false, lastList: 0, listSig: "",
    openId: null, open: null, openBusy: false, openSig: "",
    mode: "pr", formOpen: null, starting: false, formErr: "",
    prs: [], prsFor: "", prsBusy: false, prsErr: false,
    // PR picker: chosen PR, search text, filter (all|mine|ready), keyboard cursor, viewer login
    prSel: 0, prQ: "", prFilter: "all", prCur: -1, me: null, meBusy: false,
    repoQ: "", repoCur: -1,
    focus: "", prefillPath: "", prefillBase: ""
  };

  function unwrap(r) { return (r && r.data !== undefined && r.data !== null) ? r.data : r; }
  function errMsg(j) {
    if (!j) return "";
    if (typeof j.error === "string") return j.error;
    if (j.error && j.error.message) return j.error.message;
    return j.message || "";
  }
  function getJSON(url, opts) {
    return fetch(url, Object.assign({ cache: "no-store" }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: unwrap(j) }; }); });
  }
  function isActive(r) { return r && ACTIVE[r.status]; }

  // ---- CSS ------------------------------------------------------------------
  function injectCSS() {
    if (document.getElementById("op-reviews-css")) return;
    var s = document.createElement("style");
    s.id = "op-reviews-css";
    s.textContent = [
      ".op-reviews{display:grid;grid-template-columns:minmax(320px,400px) minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:16px;overflow:hidden}",
      "@media (max-width:900px){.op-reviews{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}",
      ".op-reviews .rv-left{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0}",
      ".op-reviews .rv-head{display:flex;align-items:center;gap:8px;flex:none}",
      ".op-reviews .rv-head .ttl{font-size:13px;font-weight:600;color:var(--ink);margin-right:auto}",
      ".op-reviews .rv-head .cnt{font-family:var(--mono);font-size:11px;color:var(--ink-4);font-weight:400;margin-left:6px}",
      ".op-reviews .rv-form{flex:none;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:14px;display:flex;flex-direction:column;gap:10px}",
      ".op-reviews .rv-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;align-self:flex-start}",
      ".op-reviews .rv-seg button{height:28px;padding:0 12px;font-size:12px;color:var(--ink-3);background:var(--surface-2);border:none;cursor:pointer}",
      ".op-reviews .rv-seg button+button{border-left:1px solid var(--line)}",
      ".op-reviews .rv-seg button.on{color:var(--coral);background:var(--coral-soft)}",
      ".op-reviews .rv-fld{display:flex;flex-direction:column;gap:5px;min-width:0}",
      ".op-reviews .rv-fld>span{font-size:11px;color:var(--ink-3);font-weight:500}",
      ".op-reviews .rv-fld>span em{font-style:normal;color:var(--ink-4);font-weight:400}",
      ".op-reviews .rv-fld input,.op-reviews .rv-fld select{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:12.5px;font-family:var(--sans);outline:none;min-width:0;width:100%}",
      ".op-reviews .rv-fld input.m{font-family:var(--mono)}",
      ".op-reviews .rv-fld input:focus,.op-reviews .rv-fld select:focus{border-color:var(--coral-line)}",
      ".op-reviews .rv-combo{position:relative}",
      ".op-reviews .rv-combo-btn{width:100%;height:32px;display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:12.5px;font-family:var(--mono);cursor:pointer;text-align:left}",
      ".op-reviews .rv-combo-btn:hover{border-color:var(--line-2,var(--ink-4))}",
      ".op-reviews .rv-combo-btn[aria-expanded=true],.op-reviews .rv-combo-btn:focus-visible{border-color:var(--coral-line);outline:none}",
      ".op-reviews .rv-combo-btn .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-reviews .rv-combo-btn .v.ph{color:var(--ink-4);font-family:var(--sans)}",
      ".op-reviews .rv-combo-btn .chev{flex:none;color:var(--ink-4);transition:transform .15s}",
      ".op-reviews .rv-combo-btn[aria-expanded=true] .chev{transform:rotate(180deg)}",
      ".op-reviews .rv-pop{position:absolute;z-index:20;left:0;right:0;top:calc(100% + 4px);background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);padding:6px;display:flex;flex-direction:column;gap:6px}",
      ".op-reviews .rv-pop[hidden]{display:none}",
      ".op-reviews .rv-pop input{height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:12.5px;outline:none}",
      ".op-reviews .rv-pop input:focus{border-color:var(--coral-line)}",
      ".op-reviews .rv-opts{max-height:240px;overflow:auto;display:flex;flex-direction:column}",
      ".op-reviews .rv-opt{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;min-width:0}",
      ".op-reviews .rv-opt .o{font-family:var(--mono);color:var(--ink-4)}",
      ".op-reviews .rv-opt .r{font-family:var(--mono);color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-reviews .rv-opt .tag{margin-left:auto;font-size:10.5px;color:var(--ink-4)}",
      ".op-reviews .rv-opt.cur,.op-reviews .rv-opt:hover{background:var(--surface-2)}",
      ".op-reviews .rv-opt[aria-selected=true] .r{color:var(--coral)}",
      ".op-reviews .rv-opts .none{padding:10px 8px;font-size:12px;color:var(--ink-4)}",
      ".op-reviews .rv-prhead{display:flex;align-items:center;gap:6px}",
      ".op-reviews .rv-prhead>span{font-size:11px;color:var(--ink-3);font-weight:500;margin-right:auto}",
      ".op-reviews .rv-prhead>span em{font-style:normal;color:var(--ink-4);font-weight:400;font-family:var(--mono)}",
      ".op-reviews .rv-ico{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:none;background:none;color:var(--ink-4);cursor:pointer}",
      ".op-reviews .rv-ico:hover{background:var(--surface-2);color:var(--ink-2)}",
      ".op-reviews .rv-ico svg{width:14px;height:14px}",
      ".op-reviews .rv-prtools{display:flex;gap:6px;align-items:center}",
      ".op-reviews .rv-prtools input{flex:1;height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:12.5px;outline:none;min-width:0}",
      ".op-reviews .rv-prtools input:focus{border-color:var(--coral-line)}",
      ".op-reviews .rv-flt{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;flex:none}",
      ".op-reviews .rv-flt button{height:28px;padding:0 9px;font-size:11.5px;color:var(--ink-3);background:var(--surface-2);border:none;cursor:pointer}",
      ".op-reviews .rv-flt button+button{border-left:1px solid var(--line)}",
      ".op-reviews .rv-flt button.on{color:var(--coral);background:var(--coral-soft)}",
      ".op-reviews .rv-prs{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg)}",
      ".op-reviews .rv-pr{padding:9px 11px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;flex-direction:column;gap:5px;border-left:2px solid transparent}",
      ".op-reviews .rv-pr:last-child{border-bottom:none}",
      ".op-reviews .rv-pr:hover,.op-reviews .rv-pr.cur{background:var(--surface-2)}",
      ".op-reviews .rv-pr[aria-selected=true]{background:var(--coral-soft);border-left-color:var(--coral)}",
      ".op-reviews .rv-pr .l1{display:flex;gap:8px;align-items:baseline;min-width:0}",
      ".op-reviews .rv-pr .n{font-family:var(--mono);font-size:12px;color:var(--ink-4);flex:none}",
      ".op-reviews .rv-pr[aria-selected=true] .n{color:var(--coral)}",
      ".op-reviews .rv-pr .t{font-size:12.5px;color:var(--ink);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}",
      ".op-reviews .rv-pr .l2{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--ink-4);font-family:var(--mono);padding-left:0}",
      ".op-reviews .rv-pr .br{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".op-reviews .rv-pr .add{color:var(--ok)}",
      ".op-reviews .rv-pr .del{color:var(--danger)}",
      ".op-reviews .rv-pr .ago{margin-left:auto}",
      ".op-reviews .rv-prs .msg{padding:16px 12px;font-size:12px;color:var(--ink-4);text-align:center;line-height:1.5}",
      ".op-reviews .rv-prs .msg button{margin-top:8px}",
      ".op-reviews .rv-sk{height:46px;margin:8px 11px;border-radius:6px;background:linear-gradient(90deg,var(--surface-2),var(--surface-3),var(--surface-2));background-size:200% 100%;animation:opRvSk 1.2s linear infinite}",
      "@keyframes opRvSk{0%{background-position:200% 0}100%{background-position:-200% 0}}",
      ".op-reviews .rv-fld textarea{min-height:58px;max-height:180px;resize:vertical;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:12.5px;line-height:1.45;font-family:var(--sans);outline:none;width:100%}",
      ".op-reviews .rv-fld textarea:focus{border-color:var(--coral-line)}",
      ".op-reviews .rv-focus{font-size:12.5px;color:var(--ink-2);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:8px 10px}",
      ".op-reviews .rv-hint{font-size:10.5px;color:var(--ink-4);font-family:var(--mono)}",
      "@media (prefers-reduced-motion:reduce){.op-reviews .rv-sk{animation:none}.op-reviews .rv-combo-btn .chev{transition:none}}",
      ".op-reviews .rv-note{font-size:11px;line-height:1.5;color:var(--ink-4)}",
      ".op-reviews .rv-note b{color:var(--ink-3);font-weight:500}",
      ".op-reviews .rv-note.err{color:var(--danger)}",
      ".op-reviews .rv-actions{display:flex;justify-content:flex-end;gap:8px}",
      ".op-reviews .rv-list{flex:1;min-height:0;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}",
      ".op-reviews .rv-run{padding:11px 13px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;flex-direction:column;gap:6px}",
      ".op-reviews .rv-run:last-child{border-bottom:none}",
      ".op-reviews .rv-run:hover{background:var(--surface-2)}",
      ".op-reviews .rv-run.sel{background:var(--surface-3)}",
      ".op-reviews .rv-run .l1{display:flex;align-items:center;gap:8px;min-width:0}",
      ".op-reviews .rv-run .tgt{font-family:var(--mono);font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:auto;min-width:0}",
      ".op-reviews .rv-run .l2{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ink-4);font-family:var(--mono)}",
      ".op-reviews .rv-run .l2 .sp{margin-left:auto}",
      ".op-reviews .chip{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;border-radius:999px;font-size:10.5px;font-weight:500;white-space:nowrap;font-family:var(--sans);background:var(--surface-3);color:var(--ink-3)}",
      ".op-reviews .chip.ok{background:var(--ok-soft);color:var(--ok)}",
      ".op-reviews .chip.bad{background:var(--danger-soft);color:var(--danger)}",
      ".op-reviews .chip.warn{background:var(--waiting-soft);color:var(--waiting)}",
      ".op-reviews .chip.busy{background:var(--busy-soft);color:var(--busy)}",
      ".op-reviews .chip.mute{background:var(--surface-3);color:var(--ink-4)}",
      ".op-reviews .chip .pulse{width:6px;height:6px;border-radius:50%;background:currentColor;animation:opRvPulse 1.2s ease-in-out infinite}",
      "@keyframes opRvPulse{0%,100%{opacity:1}50%{opacity:.3}}",
      ".op-reviews .sev{font-family:var(--mono);font-size:10.5px;padding:0 6px;height:18px;display:inline-flex;align-items:center;border-radius:5px;background:var(--surface-3);color:var(--ink-3)}",
      ".op-reviews .sev.blocker{background:var(--danger-soft);color:var(--danger)}",
      ".op-reviews .sev.major{background:var(--waiting-soft);color:var(--waiting)}",
      ".op-reviews .sev.minor{background:var(--busy-soft);color:var(--busy)}",
      ".op-reviews .sev.zero{opacity:.35}",
      ".op-reviews .rv-detail{min-height:0;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}",
      ".op-reviews .rv-d-head{position:sticky;top:0;z-index:1;background:var(--surface);border-bottom:1px solid var(--line);padding:14px 18px;display:flex;flex-direction:column;gap:8px}",
      ".op-reviews .rv-d-head .l1{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".op-reviews .rv-d-head .tgt{font-family:var(--mono);font-size:13.5px;color:var(--ink);font-weight:500;margin-right:auto;overflow-wrap:anywhere}",
      ".op-reviews .rv-d-head .meta{font-family:var(--mono);font-size:11px;color:var(--ink-4);display:flex;gap:12px;flex-wrap:wrap}",
      ".op-reviews .rv-d-body{padding:16px 18px 28px;display:flex;flex-direction:column;gap:18px}",
      ".op-reviews .rv-sec>.lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-4);font-weight:500;margin-bottom:7px}",
      ".op-reviews .rv-intent{font-size:13.5px;color:var(--ink);line-height:1.55}",
      ".op-reviews .rv-blast{display:flex;gap:6px;flex-wrap:wrap}",
      ".op-reviews .rv-blast span{font-size:11.5px;font-family:var(--mono);color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:2px 7px}",
      ".op-reviews .rv-banner{border-radius:var(--radius);padding:10px 12px;font-size:12.5px;line-height:1.5;border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);overflow-wrap:anywhere}",
      ".op-reviews .rv-banner.err{border-color:var(--danger-soft);background:var(--danger-soft);color:var(--danger)}",
      ".op-reviews .rv-banner.warn{border-color:var(--waiting-soft);background:var(--waiting-soft);color:var(--waiting)}",
      ".op-reviews .rv-banner.busy{border-color:var(--busy-soft);background:var(--busy-soft);color:var(--busy)}",
      ".op-reviews .rv-f{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);margin-bottom:8px}",
      ".op-reviews .rv-f.disproved{opacity:.55}",
      ".op-reviews .rv-f>summary{list-style:none;cursor:pointer;padding:10px 12px;display:flex;flex-direction:column;gap:6px}",
      ".op-reviews .rv-f>summary::-webkit-details-marker{display:none}",
      ".op-reviews .rv-f .fh{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}",
      ".op-reviews .rv-f .fid{font-family:var(--mono);font-size:11px;color:var(--ink-4)}",
      ".op-reviews .rv-f .lens{font-size:11px;color:var(--ink-3)}",
      ".op-reviews .rv-f .loc{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%}",
      ".op-reviews .rv-f .vb{margin-left:auto}",
      ".op-reviews .rv-f .claim{font-size:13px;color:var(--ink);line-height:1.5}",
      ".op-reviews .rv-f.disproved .claim{text-decoration:line-through;text-decoration-color:var(--ink-4)}",
      ".op-reviews .rv-f .fb{padding:0 12px 12px;display:grid;grid-template-columns:112px minmax(0,1fr);gap:7px 12px;font-size:12.5px;line-height:1.55}",
      ".op-reviews .rv-f .fb dt{color:var(--ink-4);font-size:11px;padding-top:2px}",
      ".op-reviews .rv-f .fb dd{margin:0;color:var(--ink-2);overflow-wrap:anywhere;white-space:pre-wrap}",
      ".op-reviews .rv-f .fb dd.code{font-family:var(--mono);font-size:11.5px}",
      ".op-reviews .rv-f .fb .vsep{grid-column:1/-1;border-top:1px dashed var(--line);margin:3px 0}",
      ".op-reviews .rv-qs{margin:0;padding-left:18px;color:var(--ink-2);font-size:12.5px;line-height:1.6}",
      ".op-reviews .rv-raw summary{cursor:pointer;font-size:11.5px;color:var(--ink-3)}",
      ".op-reviews .rv-raw pre{margin:8px 0 0;max-height:360px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;font-family:var(--mono);font-size:11px;color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere}",
      ".op-reviews .rv-muted{font-size:12px;color:var(--ink-4)}",
      ".op-reviews .rv-empty-h{font-size:12px;color:var(--ink-4);max-width:360px;line-height:1.55;font-family:var(--sans)}",
      ".op-reviews .rv-empty-h code{font-family:var(--mono);font-size:11px;color:var(--ink-3)}"
    ].join("");
    document.head.appendChild(s);
  }

  // ---- labels ----------------------------------------------------------------
  function targetLabel(r) {
    if (!r) return "";
    if (r.kind === "pr") return (r.repo || "?") + "#" + r.pr;
    var name = (r.path || "").split("/").filter(Boolean).pop() || r.path;
    return name + " vs " + (r.base || "?");
  }
  function statusChip(r) {
    var s = r.status || "";
    if (ACTIVE[s]) return "<span class='chip busy'><span class='pulse'></span>" + s + "</span>";
    if (s === "done") return "<span class='chip ok'>done</span>";
    if (s === "failed") return "<span class='chip bad'>failed</span>";
    return "<span class='chip mute'>" + st.ctx.esc(s) + "</span>";
  }
  function verdictChip(v) {
    if (!v) return "";
    var cls = { "approve": "ok", "approve-with-nits": "ok", "request-changes": "bad", "needs-design-discussion": "warn" }[v] || "mute";
    return "<span class='chip " + cls + "'>" + st.ctx.esc(v) + "</span>";
  }
  function verifierChip(f) {
    var v = f.verification && f.verification.verdict;
    if (v === "confirmed") return "<span class='chip bad vb'>" + st.ctx.icon.check + "confirmed</span>";
    if (v === "disproved") return "<span class='chip mute vb'>disproved</span>";
    if (v === "unclear") return "<span class='chip warn vb'>unclear</span>";
    if (f.severity === "blocker" || f.severity === "major") return "<span class='chip mute vb'>unverified</span>";
    return "";
  }
  function sevCounts(r) {
    var c = r.counts || {};
    var short = { blocker: "B", major: "M", minor: "m", nit: "n" };
    return SEV.map(function (k) {
      var n = c[k] || 0;
      return "<span class='sev " + k + (n ? "" : " zero") + "' title='" + k + "'>" + short[k] + " " + n + "</span>";
    }).join("") + (c.disproved ? "<span class='sev' title='disproved by the verifier'>✕ " + c.disproved + "</span>" : "");
  }
  function cost(r) { return (r.costUsd || 0) + (r.verifyCostUsd || 0); }

  // ---- data ------------------------------------------------------------------
  function fetchList() {
    if (st.listBusy) return;
    st.listBusy = true;
    getJSON("/api/reviews").then(function (res) {
      if (!res.ok) throw new Error(errMsg(res.j) || "couldn't load reviews");
      st.runs = Array.isArray(res.j) ? res.j : [];
      st.listErr = "";
      if (st.openId == null && st.runs.length) st.openId = st.runs[0].id;
    }).catch(function (e) { st.listErr = (e && e.message) || "couldn't load reviews"; })
      .then(function () {
        st.listBusy = false; st.loaded = true; st.lastList = Date.now();
        paintList(); paintForm();
        if (st.openId != null) {
          var row = runById(st.openId);
          if (!st.open || st.open.id !== st.openId || (row && (row.status !== st.open.status || row.finishedAt !== st.open.finishedAt))) fetchOpen();
        } else paintDetail();
      });
  }
  function runById(id) { for (var i = 0; i < st.runs.length; i++) if (st.runs[i].id === id) return st.runs[i]; return null; }
  function fetchOpen() {
    var id = st.openId;
    if (id == null || st.openBusy) return;
    st.openBusy = true;
    getJSON("/api/reviews/" + id).then(function (res) {
      if (st.openId !== id) return;
      st.open = res.ok ? res.j : { id: id, status: "failed", error: errMsg(res.j) || "couldn't load this review", findings: [] };
    }).catch(function () {}).then(function () { st.openBusy = false; paintDetail(); });
  }
  function loadPRs(repo, force) {
    if (!repo || (st.prsFor === repo && !force)) return;
    st.prsFor = repo; st.prs = []; st.prsBusy = true; st.prsErr = false; st.prCur = -1; paintPRList();
    getJSON("/api/github/prs?repo=" + encodeURIComponent(repo)).then(function (res) {
      if (st.prsFor !== repo) return;
      st.prs = res.ok && Array.isArray(res.j) ? res.j : [];
      st.prsErr = !res.ok;
    }).catch(function () { st.prsErr = true; }).then(function () { if (st.prsFor === repo) { st.prsBusy = false; paintPRList(); } });
  }
  // The viewer's GitHub login, for the "Mine" filter. Fetched once, lazily.
  function loadMe() {
    if (st.me !== null || st.meBusy) return;
    st.meBusy = true;
    getJSON("/api/github/orgs").then(function (res) { st.me = (res.ok && res.j && res.j.login) || ""; })
      .catch(function () { st.me = ""; }).then(function () { st.meBusy = false; paintPRList(); });
  }

  // ---- start form --------------------------------------------------------------
  var NOTE = "Runs your <b>tech-lead</b> agent, then <b>finding-verifier</b> on blocker/major findings, as <code>claude -p</code> in the local checkout. " +
    "Uses your Claude plan usage (Opus, up to 40 turns each). Read-only: nothing is written to the repo or posted to GitHub.";
  function reposWithRemote() { return (st.ctx.getRepos() || []).filter(function (r) { return r.remote; }); }
  function buildForm() {
    var ctx = st.ctx, esc = ctx.esc, f = st.refs.form;
    var repos = ctx.getRepos() || [];
    var remotes = reposWithRemote();
    var html = "<div class='rv-seg'><button data-mode='pr' class='" + (st.mode === "pr" ? "on" : "") + "'>Pull request</button>" +
      "<button data-mode='local' class='" + (st.mode === "local" ? "on" : "") + "'>Local branch</button></div>";
    if (st.mode === "pr") {
      html +=
        "<label class='rv-fld'><span>PR <em>owner/repo#number</em></span><input class='m' id='rvRef' placeholder='acme/api#123' autocomplete='off' spellcheck='false'></label>" +
        "<div class='rv-fld'><span>Repository</span><div class='rv-combo'>" +
        "<button type='button' class='rv-combo-btn' id='rvRepoBtn' aria-haspopup='listbox' aria-expanded='false'" + (remotes.length ? "" : " disabled") + ">" +
        "<span class='v' id='rvRepoVal'></span>" + CHEV + "</button>" +
        "<div class='rv-pop' id='rvRepoPop' hidden><input id='rvRepoQ' placeholder='Filter repositories…' autocomplete='off' spellcheck='false' aria-label='Filter repositories'>" +
        "<div class='rv-opts' id='rvRepoList' role='listbox' aria-label='Repositories'></div></div></div></div>" +
        "<div class='rv-fld'><div class='rv-prhead'><span>Open pull requests <em id='rvPRCount'></em></span>" +
        "<button type='button' class='rv-ico' id='rvPRReload' title='Reload open PRs' aria-label='Reload open PRs'>" + ctx.icon.trace + "</button></div>" +
        "<div class='rv-prtools'><input id='rvPRQ' placeholder='Search #, title, author, branch' autocomplete='off' spellcheck='false' aria-label='Search pull requests'>" +
        "<div class='rv-flt' role='group' aria-label='Filter pull requests'>" +
        ["all", "mine", "ready"].map(function (k) { return "<button type='button' data-f='" + k + "' class='" + (st.prFilter === k ? "on" : "") + "' aria-pressed='" + (st.prFilter === k) + "'>" + { all: "All", mine: "Mine", ready: "Ready" }[k] + "</button>"; }).join("") +
        "</div></div>" +
        "<div class='rv-prs' id='rvPRList' role='listbox' aria-label='Open pull requests' tabindex='-1'></div>" +
        "<div class='rv-hint'>↑↓ move · Enter pick · ⌘Enter start review</div></div>";
    } else {
      html +=
        "<label class='rv-fld'><span>Repository</span><select id='rvPath'><option value=''>" + (repos.length ? "choose…" : "no local repos found") + "</option>" +
        repos.map(function (r) { return "<option value='" + esc(r.path) + "'>" + esc(r.name) + (r.branch ? " · " + esc(r.branch) : "") + "</option>"; }).join("") + "</select></label>" +
        "<label class='rv-fld'><span>Base branch <em>the branch is compared to its merge-base with this</em></span><input class='m' id='rvBase' list='rvBases' placeholder='origin/main' autocomplete='off' spellcheck='false'>" +
        "<datalist id='rvBases'><option value='origin/main'><option value='origin/development'><option value='main'><option value='development'><option value='origin/master'></datalist></label>";
    }
    html += "<label class='rv-fld'><span>Focus <em>optional: what the reviewer should look at hardest</em></span>" +
      "<textarea id='rvFocus' maxlength='2000' placeholder='e.g. security of the new auth handler; does it meet the acceptance criteria in issue 123; ignore the generated files'>" + esc(st.focus) + "</textarea></label>";
    html += "<div class='rv-note" + (st.formErr ? " err" : "") + "' id='rvNote'>" + (st.formErr ? esc(st.formErr) : NOTE) + "</div>" +
      "<div class='rv-actions'><button class='btn sm' id='rvCancelForm'>Close</button><button class='btn sm primary' id='rvGo'" + (st.starting ? " disabled" : "") + ">" + (st.starting ? "Starting…" : "Start review") + "</button></div>";
    f.innerHTML = html;

    Array.prototype.forEach.call(f.querySelectorAll(".rv-seg button"), function (b) {
      b.addEventListener("click", function () { st.mode = b.dataset.mode; st.formErr = ""; buildForm(); });
    });
    f.querySelector("#rvCancelForm").addEventListener("click", function () { st.formOpen = false; paintForm(); });
    f.querySelector("#rvGo").addEventListener("click", submit);
    var focus = f.querySelector("#rvFocus");
    focus.addEventListener("input", function () { st.focus = focus.value; });
    focus.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); } });
    if (st.mode === "pr") { wirePRPicker(f);
    } else {
      var bs = f.querySelector("#rvBase"), ps = f.querySelector("#rvPath");
      if (st.prefillPath) { ps.value = st.prefillPath; bs.value = st.prefillBase; st.prefillPath = ""; st.prefillBase = ""; }
      bs.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    }
  }
  // ---- PR picker -----------------------------------------------------------------
  var CHEV = "<svg class='chev' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='m6 9 6 6 6-6'/></svg>";
  var RECENT_KEY = "rvRecentRepos";
  function recentRepos() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { return []; } }
  function rememberRepo(repo) {
    var r = recentRepos().filter(function (x) { return x !== repo; }); r.unshift(repo);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 8))); } catch (e) {}
  }
  // GitHub remotes of local checkouts, deduplicated (worktrees share a remote), recent first.
  function repoOptions() {
    var seen = {}, out = [];
    reposWithRemote().forEach(function (r) {
      if (seen[r.remote]) { seen[r.remote].n++; return; }
      seen[r.remote] = { remote: r.remote, n: 1 }; out.push(seen[r.remote]);
    });
    var rec = recentRepos();
    out.forEach(function (o) { o.rank = rec.indexOf(o.remote); });
    out.sort(function (a, b) {
      var ra = a.rank < 0 ? 99 : a.rank, rb = b.rank < 0 ? 99 : b.rank;
      return ra - rb || a.remote.localeCompare(b.remote);
    });
    return out;
  }
  function checksOf(p) {
    var r = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [];
    if (!r.length) return null;
    var bad = 0, pend = 0;
    r.forEach(function (c) {
      var v = String(c.conclusion || c.state || c.status || "").toUpperCase();
      if (/FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/.test(v)) bad++;
      else if (!v || /PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING/.test(v)) pend++;
    });
    if (bad) return "<span class='chip bad'>checks failing</span>";
    if (pend) return "<span class='chip warn'>checks running</span>";
    return "<span class='chip ok'>checks pass</span>";
  }
  function stateChip(p) {
    if (p.isDraft) return "<span class='chip mute'>draft</span>";
    if (p.reviewDecision === "APPROVED") return "<span class='chip ok'>approved</span>";
    if (p.reviewDecision === "CHANGES_REQUESTED") return "<span class='chip bad'>changes requested</span>";
    return "<span class='chip busy'>needs review</span>";
  }
  function visiblePRs() {
    var q = st.prQ.toLowerCase().trim().replace(/^#/, "");
    return st.prs.filter(function (p) {
      var who = (p.author && p.author.login) || "";
      if (st.prFilter === "mine" && (!st.me || who !== st.me)) return false;
      if (st.prFilter === "ready" && p.isDraft) return false;
      if (!q) return true;
      return (p.number + " " + (p.title || "") + " " + who + " " + (p.headRefName || "")).toLowerCase().indexOf(q) !== -1;
    });
  }
  function paintRepoBtn() {
    var v = st.refs && st.refs.form.querySelector("#rvRepoVal");
    if (!v) return;
    var n = reposWithRemote().length;
    v.textContent = st.prsFor || (n ? "Choose a repository…" : "No local GitHub repos found");
    v.className = "v" + (st.prsFor ? "" : " ph");
  }
  function paintRepoList() {
    var f = st.refs && st.refs.form, host = f && f.querySelector("#rvRepoList");
    if (!host) return;
    var esc = st.ctx.esc, q = st.repoQ.toLowerCase().trim();
    // exact repo name first, then name prefix, then any substring of owner/name
    function score(o) {
      var r = o.remote.toLowerCase(), name = r.slice(r.indexOf("/") + 1);
      return name === q || r === q ? 0 : name.indexOf(q) === 0 ? 1 : r.indexOf(q) !== -1 ? 2 : -1;
    }
    var opts = repoOptions();
    if (q) opts = opts.filter(function (o) { return score(o) >= 0; }).sort(function (a, b) { return score(a) - score(b); });
    if (st.repoCur >= opts.length) st.repoCur = opts.length - 1;
    host.innerHTML = opts.length ? opts.map(function (o, i) {
      var parts = o.remote.split("/");
      return "<div class='rv-opt" + (i === st.repoCur ? " cur" : "") + "' role='option' id='rvRepoOpt" + i + "' data-r='" + esc(o.remote) + "' aria-selected='" + (o.remote === st.prsFor) + "'>" +
        "<span class='r'><span class='o'>" + esc(parts[0]) + "/</span>" + esc(parts.slice(1).join("/")) + "</span>" +
        (o.rank >= 0 ? "<span class='tag'>recent</span>" : (o.n > 1 ? "<span class='tag'>" + o.n + " checkouts</span>" : "")) + "</div>";
    }).join("") : "<div class='none'>No repository matches “" + esc(st.repoQ) + "”.</div>";
    var qi = f.querySelector("#rvRepoQ");
    if (qi) qi.setAttribute("aria-activedescendant", st.repoCur >= 0 ? "rvRepoOpt" + st.repoCur : "");
    var cur = host.querySelector(".rv-opt.cur"); if (cur) cur.scrollIntoView({ block: "nearest" });
    return opts;
  }
  function paintPRList() {
    var f = st.refs && st.refs.form, host = f && f.querySelector("#rvPRList");
    if (!host) return;
    var ctx = st.ctx, esc = ctx.esc, cnt = f.querySelector("#rvPRCount");
    paintRepoBtn();
    Array.prototype.forEach.call(f.querySelectorAll(".rv-flt button"), function (b) {
      var on = b.dataset.f === st.prFilter; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    });
    if (!st.prsFor) { cnt.textContent = ""; host.innerHTML = "<div class='msg'>Choose a repository to list its open pull requests,<br>or type <code>owner/repo#number</code> above.</div>"; return; }
    if (st.prsBusy) { cnt.textContent = ""; host.innerHTML = "<div class='rv-sk'></div><div class='rv-sk'></div><div class='rv-sk'></div>"; return; }
    if (st.prsErr) { cnt.textContent = ""; host.innerHTML = "<div class='msg'>Couldn't load PRs for " + esc(st.prsFor) + ". Is <code>gh</code> signed in?<br><button type='button' class='btn sm' data-retry>Try again</button></div>"; wireRetry(host); return; }
    var list = visiblePRs();
    cnt.textContent = list.length === st.prs.length ? String(st.prs.length) : list.length + " of " + st.prs.length;
    if (!st.prs.length) { host.innerHTML = "<div class='msg'>No open pull requests in " + esc(st.prsFor) + ".</div>"; return; }
    if (!list.length) {
      var why = st.prFilter === "mine" ? (st.me === null ? "Checking who you are on GitHub…" : (st.me ? "None of the open PRs are by @" + esc(st.me) + "." : "Couldn't read your GitHub login.")) :
        st.prFilter === "ready" ? "Every open PR is a draft." : "No PR matches “" + esc(st.prQ) + "”.";
      host.innerHTML = "<div class='msg'>" + why + "</div>"; return;
    }
    if (st.prCur >= list.length) st.prCur = list.length - 1;
    host.innerHTML = list.map(function (p, i) {
      var who = (p.author && p.author.login) || "", ts = Date.parse(p.updatedAt);
      return "<div class='rv-pr" + (i === st.prCur ? " cur" : "") + "' role='option' id='rvPROpt" + i + "' data-n='" + p.number + "' aria-selected='" + (p.number === st.prSel) + "'" + (p.title ? " title='" + esc(p.title) + "'" : "") + ">" +
        "<div class='l1'><span class='n'>#" + p.number + "</span><span class='t'>" + esc(p.title || "(untitled)") + "</span></div>" +
        "<div class='l2'>" + stateChip(p) + (checksOf(p) || "") +
        (who ? "<span>@" + esc(who) + (who === st.me ? " (you)" : "") + "</span>" : "") +
        (p.headRefName ? "<span class='br'>⎇ " + esc(p.headRefName) + "</span>" : "") +
        (p.additions != null ? "<span><span class='add'>+" + p.additions + "</span> <span class='del'>−" + (p.deletions || 0) + "</span></span>" : "") +
        (ts ? "<span class='ago'>" + esc(ctx.ago(ts, ctx.now())) + "</span>" : "") + "</div></div>";
    }).join("");
    var qi = f.querySelector("#rvPRQ");
    if (qi) qi.setAttribute("aria-activedescendant", st.prCur >= 0 ? "rvPROpt" + st.prCur : "");
    var cur = host.querySelector(".rv-pr.cur"); if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function wireRetry(host) {
    var b = host.querySelector("[data-retry]");
    if (b) b.addEventListener("click", function () { loadPRs(st.prsFor, true); });
  }
  function pickRepo(repo) {
    if (!repo) return;
    rememberRepo(repo);
    if (repo !== st.prsFor) { st.prSel = 0; st.prQ = ""; var qi = st.refs.form.querySelector("#rvPRQ"); if (qi) qi.value = ""; }
    loadPRs(repo);
  }
  function pickPR(n) {
    var f = st.refs.form;
    st.prSel = n;
    f.querySelector("#rvRef").value = st.prsFor + "#" + n;
    if (st.formErr) { st.formErr = ""; var note = f.querySelector("#rvNote"); if (note) { note.className = "rv-note"; note.innerHTML = NOTE; } }
    paintPRList();
  }
  function wirePRPicker(f) {
    var ref = f.querySelector("#rvRef"), btn = f.querySelector("#rvRepoBtn"), pop = f.querySelector("#rvRepoPop"),
      rq = f.querySelector("#rvRepoQ"), rl = f.querySelector("#rvRepoList"), pq = f.querySelector("#rvPRQ"), pl = f.querySelector("#rvPRList");
    function openPop(open) {
      pop.hidden = !open; btn.setAttribute("aria-expanded", String(open));
      if (open) { st.repoQ = ""; rq.value = ""; st.repoCur = -1; paintRepoList(); rq.focus(); }
      else document.removeEventListener("mousedown", outside, true);
      if (open) document.addEventListener("mousedown", outside, true);
    }
    function outside(e) { if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) openPop(false); }
    btn.addEventListener("click", function () { openPop(pop.hidden); });
    rq.addEventListener("input", function () { st.repoQ = rq.value; st.repoCur = rq.value ? 0 : -1; paintRepoList(); });
    rq.addEventListener("keydown", function (e) {
      var n = rl.querySelectorAll(".rv-opt").length;
      if (e.key === "ArrowDown") { e.preventDefault(); st.repoCur = Math.min(n - 1, st.repoCur + 1); paintRepoList(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); st.repoCur = Math.max(0, st.repoCur - 1); paintRepoList(); }
      else if (e.key === "Enter") { e.preventDefault(); var o = rl.querySelectorAll(".rv-opt")[st.repoCur < 0 ? 0 : st.repoCur]; if (o) { openPop(false); pickRepo(o.dataset.r); btn.focus(); } }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); openPop(false); btn.focus(); }
    });
    rl.addEventListener("click", function (e) { var o = e.target.closest(".rv-opt"); if (o) { openPop(false); pickRepo(o.dataset.r); pq.focus(); } });

    pq.value = st.prQ;
    pq.addEventListener("input", function () { st.prQ = pq.value; st.prCur = pq.value ? 0 : -1; paintPRList(); });
    pq.addEventListener("keydown", function (e) {
      var n = pl.querySelectorAll(".rv-pr").length;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); st.prCur = Math.min(n - 1, st.prCur + 1); paintPRList(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); st.prCur = Math.max(0, st.prCur - 1); paintPRList(); }
      else if (e.key === "Enter") { e.preventDefault(); var o = pl.querySelectorAll(".rv-pr")[st.prCur < 0 ? 0 : st.prCur]; if (o) pickPR(parseInt(o.dataset.n, 10)); }
    });
    pl.addEventListener("click", function (e) { var o = e.target.closest(".rv-pr"); if (o) pickPR(parseInt(o.dataset.n, 10)); });
    pl.addEventListener("dblclick", function (e) { var o = e.target.closest(".rv-pr"); if (o) { pickPR(parseInt(o.dataset.n, 10)); submit(); } });
    Array.prototype.forEach.call(f.querySelectorAll(".rv-flt button"), function (b) {
      b.addEventListener("click", function () { st.prFilter = b.dataset.f; st.prCur = -1; if (st.prFilter === "mine") loadMe(); paintPRList(); });
    });
    f.querySelector("#rvPRReload").addEventListener("click", function () { if (st.prsFor) loadPRs(st.prsFor, true); });
    // Typing or pasting a ref selects that PR in the list when it belongs to the chosen repo.
    ref.addEventListener("input", function () {
      var m = ref.value.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/);
      if (!m) return;
      if (m[1] !== st.prsFor && repoOptions().some(function (o) { return o.remote === m[1]; })) { st.prSel = parseInt(m[2], 10); loadPRs(m[1]); return; }
      if (m[1] === st.prsFor) { st.prSel = parseInt(m[2], 10); paintPRList(); }
    });
    ref.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    if (st.prSel && st.prsFor) ref.value = st.prsFor + "#" + st.prSel;
    if (!st.prsFor) { var first = repoOptions()[0]; if (first && first.rank === 0) loadPRs(first.remote); }
    if (st.me === null) loadMe();
    paintPRList();
  }
  function setFormErr(msg) {
    st.formErr = msg;
    var n = st.refs.form.querySelector("#rvNote");
    if (n) { n.className = "rv-note err"; n.textContent = msg; }
  }
  function submit() {
    if (st.starting) return;
    var f = st.refs.form, body;
    if (st.mode === "pr") {
      var raw = (f.querySelector("#rvRef").value || "").trim();
      var m = raw.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/);
      if (!m) { setFormErr("Enter a PR as owner/repo#number, or pick one."); return; }
      body = { repo: m[1], pr: parseInt(m[2], 10) };
      var p = st.ctx.resolveRepo(m[1]);
      if (p) body.path = p;
    } else {
      var path = f.querySelector("#rvPath").value, base = (f.querySelector("#rvBase").value || "").trim();
      if (!path) { setFormErr("Pick a repository."); return; }
      if (!base) { setFormErr("Enter the base branch to compare against."); return; }
      body = { path: path, base: base };
    }
    body.focus = (f.querySelector("#rvFocus").value || "").trim();
    st.starting = true; st.formErr = ""; buildForm();
    getJSON("/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) {
        st.starting = false;
        if (!res.ok) { buildForm(); setFormErr(errMsg(res.j) || "Couldn't start the review."); return; }
        st.ctx.toast("Review started for " + targetLabel(res.j), "ok");
        st.focus = ""; st.prSel = 0;
        st.formOpen = false; st.openId = res.j.id; st.open = res.j; st.listSig = "";
        paintForm(); fetchList();
      })
      .catch(function () { st.starting = false; buildForm(); setFormErr("Couldn't reach rook."); });
  }
  function paintForm() {
    if (!st.refs) return;
    var show = st.formOpen === null ? (st.loaded && !st.runs.length) : st.formOpen;
    var was = st.refs.form.style.display !== "none" && st.refs.form.innerHTML !== "";
    st.refs.form.style.display = show ? "" : "none";
    if (show && !was) buildForm();
    st.refs.newBtn.style.display = show ? "none" : "";
  }

  // ---- list ------------------------------------------------------------------
  function paintList() {
    if (!st.refs) return;
    var ctx = st.ctx, esc = ctx.esc, list = st.refs.list;
    st.refs.count.textContent = st.runs.length ? String(st.runs.length) : "";
    var sig = st.loaded + "|" + st.listErr + "|" + st.openId + "|" + st.runs.map(function (r) {
      return r.id + ":" + r.status + ":" + r.verdict + ":" + JSON.stringify(r.counts) + ":" + cost(r);
    }).join(",") + "|" + Math.floor(ctx.now() / 30000);
    if (sig === st.listSig) return;
    st.listSig = sig;
    if (!st.loaded) { list.innerHTML = "<div class='op-empty'><div class='t'>loading…</div></div>"; return; }
    if (st.listErr && !st.runs.length) { list.innerHTML = "<div class='op-empty'>" + ctx.icon.alert + "<div class='t'>" + esc(st.listErr) + "</div></div>"; return; }
    if (!st.runs.length) {
      list.innerHTML = "<div class='op-empty'>" + ctx.icon.review + "<div class='t'>No reviews yet</div>" +
        "<div class='rv-empty-h'>A review runs your <code>tech-lead</code> agent on one PR or branch and has <code>finding-verifier</code> try to disprove every blocker and major finding. " +
        "Both live in <code>~/.claude/agents/</code> (or a repo's <code>.claude/agents/</code>). Start one with the form above.</div></div>";
      return;
    }
    list.innerHTML = st.runs.map(function (r) {
      return "<div class='rv-run" + (r.id === st.openId ? " sel" : "") + "' data-id='" + r.id + "'>" +
        "<div class='l1'><span class='tgt' title='" + esc(r.path) + "'>" + esc(targetLabel(r)) + "</span>" + verdictChip(r.verdict) + statusChip(r) + "</div>" +
        "<div class='l2'>" + (r.verdict ? sevCounts(r) : "") +
        "<span class='sp'>" + (cost(r) ? ctx.fmtUSD(cost(r)) + " · " : "") + ctx.ago(r.createdAt, ctx.now()) + "</span></div></div>";
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll(".rv-run"), function (row) {
      row.addEventListener("click", function () {
        var id = parseInt(row.dataset.id, 10);
        if (id === st.openId) return;
        st.openId = id; st.open = null; st.openSig = ""; st.listSig = "";
        paintList(); paintDetail(); fetchOpen();
      });
    });
  }

  // ---- detail ------------------------------------------------------------------
  function findingHTML(f) {
    var esc = st.ctx.esc;
    var v = f.verification || null;
    var disproved = v && v.verdict === "disproved";
    var loc = f.file ? f.file + (f.line ? ":" + f.line : "") : "";
    var row = function (k, val, code) { return val ? "<dt>" + k + "</dt><dd" + (code ? " class='code'" : "") + ">" + esc(val) + "</dd>" : ""; };
    return "<details class='rv-f" + (disproved ? " disproved" : "") + "'" + (disproved ? "" : " open") + " data-fid='" + esc(f.id) + "'>" +
      "<summary><div class='fh'><span class='sev " + esc(f.severity) + "'>" + esc(f.severity || "?") + "</span>" +
      (f.lens ? "<span class='lens'>" + esc(f.lens) + "</span>" : "") +
      (loc ? "<span class='loc' title='" + esc(loc) + "'>" + esc(loc) + "</span>" : "") +
      "<span class='fid'>" + esc(f.id) + "</span>" + verifierChip(f) + "</div>" +
      "<div class='claim'>" + esc(f.claim || "") + "</div></summary>" +
      "<dl class='fb'>" + row("Failure scenario", f.failure_scenario) + row("Evidence", f.evidence, true) + row("Fix", f.fix) +
      (v ? "<div class='vsep'></div>" + row("Verifier", v.verdict + (v.note ? " — " + v.note : "")) + row("Verifier evidence", v.evidence, true) : "") +
      "</dl></details>";
  }
  function confirmedMarkdown(r) {
    var fs = (r.findings || []).filter(function (f) { return f.verification && f.verification.verdict === "confirmed"; });
    if (!fs.length) return "";
    var out = ["## Review: " + targetLabel(r) + " — " + (r.verdict || ""), ""];
    if (r.intent) out.push("_" + r.intent + "_", "");
    fs.forEach(function (f) {
      out.push("### [" + f.severity + "] " + (f.file || "") + (f.line ? ":" + f.line : "") + " — " + (f.claim || ""));
      if (f.failure_scenario) out.push("- **Failure:** " + f.failure_scenario);
      if (f.evidence) out.push("- **Evidence:** " + f.evidence);
      if (f.fix) out.push("- **Fix:** " + f.fix);
      if (f.verification.evidence) out.push("- **Verified:** " + f.verification.evidence);
      out.push("");
    });
    return out.join("\n");
  }
  // Re-open the start form on the same target, so the user can add or change the focus.
  function prefillForm(r) {
    st.focus = r.focus || ""; st.formErr = "";
    if (r.kind === "pr") { st.mode = "pr"; st.prSel = r.pr; if (st.prsFor !== r.repo) loadPRs(r.repo); }
    else { st.mode = "local"; st.prefillPath = r.path; st.prefillBase = r.base; }
    st.formOpen = true; st.refs.form.innerHTML = ""; paintForm();
    var ta = st.refs.form.querySelector("#rvFocus"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  // Prompt for a follow-up session: the findings as context, no changes until the user says so.
  function discussPrompt(r) {
    var out = ["I ran a tech-lead review of " + (r.kind === "pr" ? "PR #" + r.pr + " of " + r.repo : "this branch against " + r.base) + ". Verdict: " + (r.verdict || "none") + "."];
    if (r.focus) out.push("I asked it to focus on: " + r.focus);
    if (r.intent) out.push("Intent it read: " + r.intent);
    var fs = r.findings || [];
    out.push(fs.length ? "Findings (verifier verdict in brackets):" : "It reported no findings.");
    fs.forEach(function (f) {
      var v = f.verification ? f.verification.verdict : "unverified";
      out.push("- " + (f.id || "") + " [" + f.severity + ", " + v + "] " + (f.file || "") + (f.line ? ":" + f.line : "") + " — " + (f.claim || "") + (f.fix ? " Fix: " + f.fix : ""));
    });
    if ((r.questions || []).length) out.push("Open questions:", (r.questions || []).map(function (q) { return "- " + q; }).join("\n"));
    out.push("Help me go through these: answer my questions about them and check anything I ask in the code. Do not change files, commit, push or post anything until I say so.");
    return out.join("\n");
  }
  function paintDetail() {
    if (!st.refs) return;
    var ctx = st.ctx, esc = ctx.esc, d = st.refs.detail;
    if (st.openId == null) {
      st.openSig = "none";
      d.innerHTML = "<div class='op-empty'>" + ctx.icon.review + "<div class='t'>No review selected</div><div class='h'>start one, or pick a run on the left</div></div>";
      return;
    }
    var r = st.open && st.open.id === st.openId ? st.open : null;
    if (!r) {
      if (st.openSig !== "loading") { st.openSig = "loading"; d.innerHTML = "<div class='op-empty'><div class='t'>loading…</div></div>"; }
      return;
    }
    var sig = [r.id, r.status, r.verdict, r.finishedAt, r.error, r.verifyError, JSON.stringify(r.findings || []).length, cost(r)].join("|");
    if (sig === st.openSig) return;
    st.openSig = sig;

    var findings = (r.findings || []).slice();
    var nConfirmed = findings.filter(function (f) { return f.verification && f.verification.verdict === "confirmed"; }).length;
    var meta = [];
    if (r.diffFiles) meta.push(r.diffFiles + " files +" + (r.diffAdd || 0) + " −" + (r.diffDel || 0));
    if (cost(r)) meta.push(ctx.fmtUSD(cost(r)) + (r.verifyCostUsd ? " (review " + ctx.fmtUSD(r.costUsd || 0) + " + verify " + ctx.fmtUSD(r.verifyCostUsd) + ")" : ""));
    if (r.turns) meta.push(r.turns + (r.verifyTurns ? "+" + r.verifyTurns : "") + " turns");
    meta.push("started " + ctx.ago(r.createdAt, ctx.now()));
    if (r.finishedAt && r.startedAt) meta.push("took " + Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000)) + "s");

    var html = "<div class='rv-d-head'><div class='l1'><span class='tgt' title='" + esc(r.path || "") + "'>" + esc(targetLabel(r)) + "</span>" +
      verdictChip(r.verdict) + statusChip(r) +
      (isActive(r) ? "<button class='btn sm danger' id='rvStop'>" + ctx.icon.stop + "Cancel</button>" : "") +
      (!isActive(r) ? "<button class='btn sm' id='rvRerun' title='Start a new review of the same target, with your focus'>Re-run with focus…</button>" : "") +
      (r.status === "done" ? "<button class='btn sm' id='rvDiscuss' title='Open an agent session in this checkout with these findings, to ask follow-up questions'>Discuss in a session</button>" : "") +
      (r.status === "done" ? "<button class='btn sm' id='rvCopy'" + (nConfirmed ? "" : " disabled title='no confirmed findings'") + ">Copy confirmed as markdown" + (nConfirmed ? " (" + nConfirmed + ")" : "") + "</button>" : "") +
      "</div><div class='meta'>" + meta.map(esc).join("<span>·</span>") + "</div></div><div class='rv-d-body'>";

    if (isActive(r)) {
      var stage = { queued: "Queued — waiting for the running review to finish.", reviewing: "The tech-lead agent is reviewing the change. This usually takes a few minutes.", verifying: "The finding-verifier is trying to disprove the blocker and major findings." }[r.status];
      html += "<div class='rv-banner busy'>" + esc(stage) + " A running review can't take new instructions: cancel it and start again with a focus, or use <b>Discuss in a session</b> once it finishes.</div>";
    }
    if (r.status === "failed" || r.status === "canceled") html += "<div class='rv-banner " + (r.status === "failed" ? "err" : "") + "'>" + esc(r.error || r.status) + "</div>";
    if (r.verifyError) html += "<div class='rv-banner warn'>Verifier failed, so blocker/major findings are unverified: " + esc(r.verifyError) + "</div>";

    if (r.focus) html += "<div class='rv-sec'><div class='lbl'>Your focus</div><div class='rv-focus'>" + esc(r.focus) + "</div></div>";
    if (r.intent) html += "<div class='rv-sec'><div class='lbl'>Intent</div><div class='rv-intent'>" + esc(r.intent) + "</div></div>";
    if (r.blastRadius && r.blastRadius.length) html += "<div class='rv-sec'><div class='lbl'>Blast radius</div><div class='rv-blast'>" + r.blastRadius.map(function (b) { return "<span>" + esc(b) + "</span>"; }).join("") + "</div></div>";
    if (r.verdict) {
      html += "<div class='rv-sec'><div class='lbl'>Findings · " + findings.length + "</div>";
      html += findings.length ? findings.map(findingHTML).join("") : "<div class='rv-muted'>No findings — the reviewer found nothing these changes break.</div>";
      html += "</div>";
    }
    if (r.questions && r.questions.length) html += "<div class='rv-sec'><div class='lbl'>Open questions</div><ol class='rv-qs'>" + r.questions.map(function (q) { return "<li>" + esc(q) + "</li>"; }).join("") + "</ol></div>";
    if (r.rawReview || r.rawVerify) {
      html += "<div class='rv-sec rv-raw'><div class='lbl'>Debug</div>" +
        (r.rawReview ? "<details><summary>Raw tech-lead output</summary><pre>" + esc(r.rawReview) + "</pre></details>" : "") +
        (r.rawVerify ? "<details><summary>Raw verifier output</summary><pre>" + esc(r.rawVerify) + "</pre></details>" : "") + "</div>";
    }
    html += "<div class='rv-muted'>" + esc(r.path || "") + (r.base ? " · base " + esc(r.base) : "") + "</div></div>";
    d.innerHTML = html;

    var stop = d.querySelector("#rvStop");
    if (stop) stop.addEventListener("click", function () {
      if (!window.confirm("Cancel this review? The running agent is killed.")) return;
      stop.disabled = true;
      getJSON("/api/reviews/" + r.id + "/cancel", { method: "POST" }).then(function (res) {
        ctx.toast(res.ok ? "Review canceled" : (errMsg(res.j) || "Cancel failed"), res.ok ? "ok" : "err");
        st.listSig = ""; fetchList();
      });
    });
    var rerun = d.querySelector("#rvRerun");
    if (rerun) rerun.addEventListener("click", function () { prefillForm(r); });
    var discuss = d.querySelector("#rvDiscuss");
    if (discuss) discuss.addEventListener("click", function () {
      ctx.launch({ title: "Discuss review", name: "discuss-review-" + r.id, cwd: r.path, prompt: discussPrompt(r) });
    });
    var copy = d.querySelector("#rvCopy");
    if (copy) copy.addEventListener("click", function () {
      var md = confirmedMarkdown(r);
      if (!md) { ctx.toast("No confirmed findings to copy", ""); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(md).then(function () { ctx.toast("Copied " + nConfirmed + " confirmed finding" + (nConfirmed === 1 ? "" : "s"), "ok"); }, function () { ctx.toast("Clipboard blocked", "err"); });
    });
  }

  // ---- build / render ------------------------------------------------------------
  function build(host, ctx) {
    injectCSS();
    st.ctx = ctx; st.listSig = ""; st.openSig = ""; st.formOpen = null; st.formErr = "";
    host.innerHTML = "<div class='ins op-reviews'>" +
      "<div class='rv-left'><div class='rv-head'><span class='ttl'>Reviews<span class='cnt' id='rvCount'></span></span>" +
      "<button class='btn sm' id='rvNew'>" + ctx.icon.plus + "New review</button>" +
      "<button class='btn sm' id='rvRefresh' title='Refresh'>" + ctx.icon.trace + "</button></div>" +
      "<div class='rv-form' id='rvForm' style='display:none'></div>" +
      "<div class='rv-list' id='rvList'></div></div>" +
      "<div class='rv-detail' id='rvDetail'></div></div>";
    var root = host.firstChild;
    st.refs = {
      root: root, form: root.querySelector("#rvForm"), list: root.querySelector("#rvList"),
      detail: root.querySelector("#rvDetail"), count: root.querySelector("#rvCount"), newBtn: root.querySelector("#rvNew")
    };
    st.refs.newBtn.addEventListener("click", function () { st.formOpen = true; st.formErr = ""; st.refs.form.innerHTML = ""; paintForm(); });
    root.querySelector("#rvRefresh").addEventListener("click", function () { st.listSig = ""; st.openSig = ""; st.open = null; fetchList(); });
    paintList(); paintDetail(); fetchList();
    var args = ctx.takeViewArgs ? ctx.takeViewArgs("reviews") : null;
    if (args && args.repo && args.pr) prefillForm({ kind: "pr", repo: args.repo, pr: args.pr, focus: args.focus || "" });
  }

  // Poll every 2s while a run is active; otherwise every 15s.
  function render(state, ctx) {
    if (!st.refs) return;
    st.ctx = ctx;
    var anyActive = st.runs.some(isActive);
    if (Date.now() - st.lastList > (anyActive ? 1800 : 15000)) fetchList();
    else paintList();
  }

  window.OP_VIEWS["reviews"] = { build: build, render: render };
})();
