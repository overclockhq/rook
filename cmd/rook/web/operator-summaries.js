// operator-summaries.js — Operator view for saved daily work summaries.
// Registers into window.OP_VIEWS["summaries"]. Self-contained IIFE, no libs.
// Mirrors the classic renderSummaries flow (web/app.js): a list of saved
// summaries (start/end + meta + snippet) on the left, a reading panel on the
// right, per-item delete, and a multi-select bulk-delete mode.
//
// Server shapes (see summary.go / db.go):
//   GET    /api/summaries         -> [{id,start,end,author,repos,snippet,createdAt}]
//   GET    /api/summary?id=<id>   -> {id,start,end,author,repos,content,createdAt}
//   DELETE /api/summary?id=<id>   -> {ok:true}
// createdAt is UnixMilli. Responses may be wrapped in {data:...}; we unwrap.
(function () {
  window.OP_VIEWS = window.OP_VIEWS || {};

  // ---- module state (persists across the 2s render() poll) -----------------
  var refs = null;          // cached DOM references built once per build()
  var data = [];            // last fetched list of summaries (metadata)
  var openId = null;        // id of the summary open in the reading panel
  var openContent = "";     // full markdown of the open summary
  var loadedOpenId = null;  // last id painted into the reading panel
  var selectMode = false;   // multi-select mode toggle
  var selected = new Set(); // ids checked for bulk delete
  var filter = "";          // list search filter
  var searchFocused = false;
  var loading = false;      // a list fetch is in flight
  var loadedOnce = false;   // first list fetch has resolved (list-only)
  var error = null;         // last list-fetch error message
  var openError = null;     // reading-panel load error
  var lastSig = null;       // signature guard so paintList skips no-op rebuilds

  function unwrap(r) { return (r && r.data !== undefined && r.data !== null) ? r.data : r; }

  // ---- data ----------------------------------------------------------------
  function fetchList(ctx, force) {
    if (loading) return;
    loading = true;
    fetch("/api/summaries", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (r) {
        var list = unwrap(r);
        data = Array.isArray(list) ? list : [];
        error = null;
        loadedOnce = true;
        // prune selections + open summary for ids that no longer exist
        var live = {};
        data.forEach(function (s) { live[s.id] = true; });
        Array.from(selected).forEach(function (id) { if (!live[id]) selected.delete(id); });
        if (openId != null && !live[openId]) { openId = null; openContent = ""; }
      })
      .catch(function (e) { error = (e && e.message) || "load failed"; loadedOnce = true; })
      .then(function () { loading = false; paint(ctx); });
  }

  function openSummary(ctx, id) {
    openId = id;
    openError = null;
    if (loadedOpenId !== id) { openContent = ""; } // show loading until it arrives
    paintOpen(ctx);
    fetch("/api/summary?id=" + encodeURIComponent(id), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (r) {
        var s = unwrap(r) || {};
        if (openId !== id) return; // user moved on while it loaded
        openContent = s.content || "";
        openError = null;
        loadedOpenId = id;
        if (refs) refs.paintedKey = null; // force a repaint for a freshly (re)loaded body
        paintOpen(ctx);
        paintList(ctx); // reflect selection highlight
      })
      .catch(function () {
        if (openId !== id) return;
        openError = "couldn't load this summary";
        paintOpen(ctx);
      });
  }

  function deleteOne(ctx, id) {
    return fetch("/api/summary?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  // ---- light markdown -> html (line based, no external lib) ----------------
  function mdToHtml(md, esc) {
    var inline = function (t) {
      return esc(t)
        .replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    };
    var lines = String(md == null ? "" : md).replace(/\r/g, "").split("\n");
    var html = "", i = 0, inCode = false, listType = "";
    var closeList = function () { if (listType) { html += "</" + listType + ">"; listType = ""; } };
    while (i < lines.length) {
      var ln = lines[i];
      if (/^```/.test(ln)) {
        if (!inCode) { closeList(); html += "<pre class='sum-pre'><code>"; inCode = true; }
        else { html += "</code></pre>"; inCode = false; }
        i++; continue;
      }
      if (inCode) { html += esc(ln) + "\n"; i++; continue; }
      // table: header row followed by a |---| separator
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1])) {
        closeList();
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
        var head = cells(ln);
        html += "<table class='sum-table'><thead><tr>" + head.map(function (h) { return "<th>" + inline(h) + "</th>"; }).join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          html += "<tr>" + cells(lines[i]).map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
          i++;
        }
        html += "</tbody></table>";
        continue;
      }
      var h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html += "<h" + h[1].length + " class='sum-h'>" + inline(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
      if (/^\s*[-*]\s+/.test(ln)) {
        if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
        html += "<li>" + inline(ln.replace(/^\s*[-*]\s+/, "")) + "</li>"; i++; continue;
      }
      if (/^\s*\d+\.\s+/.test(ln)) {
        if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
        html += "<li>" + inline(ln.replace(/^\s*\d+\.\s+/, "")) + "</li>"; i++; continue;
      }
      if (/^\s*>\s?/.test(ln)) { closeList(); html += "<blockquote>" + inline(ln.replace(/^\s*>\s?/, "")) + "</blockquote>"; i++; continue; }
      if (/^\s*---+\s*$/.test(ln)) { closeList(); html += "<hr>"; i++; continue; }
      if (ln.trim() === "") { closeList(); i++; continue; }
      closeList();
      html += "<p>" + inline(ln) + "</p>";
      i++;
    }
    closeList();
    if (inCode) html += "</code></pre>";
    return html;
  }

  // ---- helpers -------------------------------------------------------------
  function rangeLabel(s, esc) {
    var a = esc(s.start || "");
    return (s.end && s.end !== s.start) ? a + " → " + esc(s.end) : a;
  }
  function metaLine(s, ctx) {
    var bits = [];
    if (s.author) bits.push(ctx.esc(s.author));
    if (s.repos) bits.push(ctx.esc(s.repos));
    bits.push(ctx.ago(s.createdAt, ctx.now()));
    return bits.join(" · ");
  }
  function filtered() {
    if (!filter) return data;
    var q = filter.toLowerCase();
    return data.filter(function (s) {
      return ((s.start || "") + " " + (s.end || "") + " " + (s.author || "") + " " +
        (s.repos || "") + " " + (s.snippet || "")).toLowerCase().indexOf(q) !== -1;
    });
  }

  // ---- CSS (injected once) -------------------------------------------------
  function injectCSS() {
    if (document.getElementById("op-summaries-css")) return;
    var st = document.createElement("style");
    st.id = "op-summaries-css";
    st.textContent =
      ".op-sum { padding: 0; }" +
      ".op-sum-grid { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 16px; padding: 20px 24px 40px; align-items: start; }" +
      "@media (max-width: 820px) { .op-sum-grid { grid-template-columns: 1fr; } }" +
      ".op-sum-left { display: flex; flex-direction: column; gap: 10px; min-width: 0; }" +
      ".op-sum-bar { display: flex; align-items: center; gap: 8px; }" +
      ".op-sum-search { flex: 1; display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink-2); }" +
      ".op-sum-search svg { width: 15px; height: 15px; color: var(--ink-4); flex: none; }" +
      ".op-sum-search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--ink); font-size: 12.5px; font-family: var(--sans); }" +
      ".op-sum-search input::placeholder { color: var(--ink-4); }" +
      ".op-sum-bar .btn.on { color: var(--coral); border-color: var(--coral-line); background: var(--coral-soft); }" +
      ".op-sum-bar .btn.gen { color: var(--coral); border-color: var(--coral-line); }" +
      ".op-sum-bar .btn.gen:hover { background: var(--coral-soft); }" +
      ".op-sum-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); backdrop-filter: blur(2px); padding: 24px; }" +
      ".op-sum-modal-box { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg, 14px); box-shadow: var(--shadow-lg, 0 24px 60px rgba(0,0,0,.4)); padding: 20px 20px 16px; display: flex; flex-direction: column; gap: 12px; }" +
      ".op-sum-modal-h { font-size: 15px; font-weight: 600; color: var(--ink); }" +
      ".op-sum-modal-sub { font-size: 12px; color: var(--ink-3); line-height: 1.5; margin-top: -6px; }" +
      ".op-sum-fld { display: flex; flex-direction: column; gap: 5px; }" +
      ".op-sum-fld > span { font-size: 11px; color: var(--ink-3); font-weight: 500; letter-spacing: .02em; }" +
      ".op-sum-fld > span em { color: var(--ink-4); font-style: normal; font-weight: 400; }" +
      ".op-sum-fld input, .op-sum-fld select { height: 34px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font-size: 13px; font-family: var(--sans); outline: none; }" +
      ".op-sum-fld input:focus, .op-sum-fld select:focus { border-color: var(--coral-line); }" +
      ".op-sum-modal-note { font-size: 11px; color: var(--ink-4); line-height: 1.5; }" +
      ".op-sum-modal-note.err { color: var(--danger); }" +
      ".op-sum-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }" +
      ".op-sum-modal-actions .btn.gen { color: #fff; background: var(--coral); border-color: var(--coral); }" +
      ".op-sum-modal-actions .btn.gen:hover { filter: brightness(1.05); }" +
      ".op-sum-modal-actions .btn.gen:disabled { opacity: .6; cursor: default; }" +
      ".op-sum-bulk { display: flex; align-items: center; gap: 9px; padding: 9px 12px; border: 1px solid var(--coral-line); background: var(--coral-soft); border-radius: var(--radius); }" +
      ".op-sum-bulk .n { font-size: 12px; color: var(--ink); font-weight: 500; margin-right: auto; }" +
      ".op-sum-list { display: flex; flex-direction: column; }" +
      ".op-sum .sum-row { grid-template-columns: auto 1fr; align-items: start; gap: 11px; cursor: pointer; padding: 11px 4px; }" +
      ".op-sum .sum-row:hover { background: var(--surface-2); }" +
      ".op-sum .sum-row.sel { background: var(--surface-3); }" +
      ".op-sum .sum-cb { display: none; margin-top: 2px; width: 15px; height: 15px; accent-color: var(--coral); cursor: pointer; flex: none; }" +
      ".op-sum.select-mode .sum-cb { display: block; }" +
      ".op-sum .sum-row .rt { min-width: 0; display: flex; flex-direction: column; gap: 3px; white-space: normal; }" +
      ".op-sum .sum-title { font-size: 13px; color: var(--ink); font-weight: 500; }" +
      ".op-sum .sum-meta { font-size: 11px; color: var(--ink-3); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
      ".op-sum .sum-snip { font-size: 12px; color: var(--ink-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }" +
      ".op-sum-right { position: sticky; top: 20px; min-width: 0; }" +
      ".op-sum-read .sum-read-actions { display: flex; gap: 7px; }" +
      ".op-sum-read .sum-read-body { color: var(--ink-2); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }" +
      ".op-sum-read .sum-read-body .sum-h { color: var(--ink); margin: 16px 0 8px; line-height: 1.3; }" +
      ".op-sum-read .sum-read-body h1.sum-h { font-size: 18px; } .op-sum-read .sum-read-body h2.sum-h { font-size: 16px; } .op-sum-read .sum-read-body h3.sum-h { font-size: 14px; }" +
      ".op-sum-read .sum-read-body p { margin: 8px 0; }" +
      ".op-sum-read .sum-read-body ul, .op-sum-read .sum-read-body ol { margin: 8px 0; padding-left: 20px; }" +
      ".op-sum-read .sum-read-body li { margin: 3px 0; }" +
      ".op-sum-read .sum-read-body code { font-family: var(--mono); font-size: .88em; background: var(--surface-3); padding: 1px 5px; border-radius: 5px; }" +
      ".op-sum-read .sum-read-body strong { color: var(--ink); }" +
      ".op-sum-read .sum-read-body a { color: var(--coral); }" +
      ".op-sum-read .sum-read-body blockquote { margin: 8px 0; padding: 4px 12px; border-left: 2px solid var(--line-2); color: var(--ink-3); }" +
      ".op-sum-read .sum-read-body hr { border: none; border-top: 1px solid var(--line); margin: 14px 0; }" +
      ".op-sum-read .sum-read-body .sum-pre { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; overflow-x: auto; margin: 10px 0; }" +
      ".op-sum-read .sum-read-body .sum-pre code { background: none; padding: 0; }" +
      ".op-sum-read .sum-read-body .sum-table { border-collapse: collapse; margin: 10px 0; display: block; overflow-x: auto; max-width: 100%; }" +
      ".op-sum-read .sum-read-body .sum-table th, .op-sum-read .sum-read-body .sum-table td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; font-size: 12px; }" +
      ".op-sum-read .sum-read-body .sum-table th { color: var(--ink); background: var(--surface-2); }" +
      ".op-sum-read .sum-loading, .op-sum-read .sum-err { color: var(--ink-4); font-family: var(--mono); font-size: 12.5px; padding: 30px 4px; text-align: center; }" +
      ".op-sum-read .sum-err { color: var(--danger); }" +
      ".op-sum-list .sum-loading, .op-sum-list .sum-err { color: var(--ink-4); font-family: var(--mono); font-size: 12.5px; padding: 20px 4px; }" +
      ".op-sum-list .sum-err { color: var(--danger); }";
    document.head.appendChild(st);
  }

  // ---- build ---------------------------------------------------------------
  function build(host, ctx) {
    injectCSS();
    // fresh view entry: reset transient selection/open state, keep nothing stale
    openId = null; openContent = ""; loadedOpenId = null;
    selectMode = false; selected = new Set(); filter = ""; searchFocused = false;
    error = null; openError = null; lastSig = null; loadedOnce = false;

    host.innerHTML = "";
    var scroll = ctx.el("div", "ins op-sum");
    var grid = ctx.el("div", "op-sum-grid");

    // left column: toolbar + bulk bar + list
    var left = ctx.el("div", "op-sum-left");
    var secLeft = ctx.el("div", "ov-sec-label", "Saved summaries <span id='opSumCount' class='mono'></span>");

    var bar = ctx.el("div", "op-sum-bar");
    var search = ctx.el("div", "op-sum-search", ctx.icon.search);
    var input = ctx.el("input");
    input.type = "text";
    input.placeholder = "Filter summaries";
    input.addEventListener("input", function () { filter = input.value.trim(); lastSig = null; paintList(ctx); });
    input.addEventListener("focus", function () { searchFocused = true; });
    input.addEventListener("blur", function () { searchFocused = false; });
    search.appendChild(input);

    var selBtn = ctx.el("button", "btn sm", "Select");
    selBtn.title = "Multi-select for bulk delete";
    selBtn.addEventListener("click", function () {
      selectMode = !selectMode;
      if (!selectMode) selected.clear();
      lastSig = null;
      paint(ctx);
    });

    var refBtn = ctx.el("button", "btn sm", ctx.icon.trace);
    refBtn.title = "Refresh";
    refBtn.addEventListener("click", function () {
      fetchList(ctx, true);
      if (openId != null) openSummary(ctx, openId);
      ctx.toast("Refreshed", "");
    });

    var genBtn = ctx.el("button", "btn sm gen", "Generate");
    genBtn.title = "Generate a work summary for a day (all agents + GitHub, any directory)";
    genBtn.addEventListener("click", function () { openGenModal(ctx); });

    bar.appendChild(search); bar.appendChild(genBtn); bar.appendChild(selBtn); bar.appendChild(refBtn);

    var bulk = ctx.el("div", "op-sum-bulk");
    bulk.style.display = "none";
    var list = ctx.el("div", "op-sum-list ins-runs");
    list.id = "opSumList";

    left.appendChild(secLeft); left.appendChild(bar); left.appendChild(bulk); left.appendChild(list);

    // right column: reading panel
    var right = ctx.el("div", "op-sum-right");
    var card = ctx.el("div", "ins-card op-sum-read");
    var head = ctx.el("div", "ins-card-head");
    var title = ctx.el("div", "ins-card-title", "Summary");
    title.id = "opSumReadTitle";
    var actions = ctx.el("div", "sum-read-actions");
    var body = ctx.el("div", "sum-read-body");
    body.id = "opSumReadBody";
    head.appendChild(title); head.appendChild(actions);
    card.appendChild(head); card.appendChild(body);
    right.appendChild(card);

    grid.appendChild(left); grid.appendChild(right);
    scroll.appendChild(grid);
    host.appendChild(scroll);

    refs = {
      scroll: scroll, count: secLeft.querySelector("#opSumCount"),
      selBtn: selBtn, bulk: bulk, list: list,
      title: title, actions: actions, body: body
    };

    fetchList(ctx);
    render(null, ctx);
  }

  // ---- paint (idempotent; preserves open summary + selections) -------------
  function paintList(ctx) {
    if (!refs) return;
    var esc = ctx.esc;
    var rows = filtered();
    refs.count.textContent = data.length ? String(data.length) : "";
    refs.selBtn.classList.toggle("on", selectMode);
    refs.selBtn.textContent = selectMode ? "Done" : "Select";
    refs.scroll.classList.toggle("select-mode", selectMode);

    // bulk bar
    var n = selected.size;
    if (n > 0) {
      refs.bulk.style.display = "flex";
      refs.bulk.innerHTML =
        "<span class='n'>" + n + " selected</span>" +
        "<button class='btn danger sm' id='opSumBulkDel'>Delete selected (" + n + ")</button>" +
        "<button class='btn sm' id='opSumBulkClear'>Clear</button>";
      refs.bulk.querySelector("#opSumBulkDel").addEventListener("click", function () { bulkDelete(ctx); });
      refs.bulk.querySelector("#opSumBulkClear").addEventListener("click", function () { selected.clear(); lastSig = null; paint(ctx); });
    } else {
      refs.bulk.style.display = "none";
      refs.bulk.innerHTML = "";
    }

    // loading / error / empty
    if (!loadedOnce && !data.length) {
      refs.list.innerHTML = "<div class='sum-loading'>loading…</div>";
      lastSig = "state:loading";
      return;
    }
    if (error && !data.length) {
      refs.list.innerHTML = "<div class='sum-err'>" + esc(error) + "</div>";
      lastSig = "state:error:" + error;
      return;
    }
    if (!rows.length) {
      var msg = data.length ? "No summaries match “" + esc(filter) + "”"
        : "No summaries yet";
      var hint = data.length ? "Clear the filter to see all."
        : "Hit Generate above to build one for any day.";
      refs.list.innerHTML =
        "<div class='op-empty'>" + ctx.icon.file +
        "<div class='t'>" + msg + "</div><div class='h'>" + hint + "</div></div>";
      lastSig = "state:empty:" + filter + ":" + data.length;
      return;
    }

    // signature guard: avoid rebuilding (and disturbing) the list every 2s
    var sig = selectMode + "|" + filter + "|" + openId + "|" +
      Array.from(selected).sort().join(",") + "|" +
      rows.map(function (s) { return s.id + ":" + s.createdAt; }).join(",");
    if (sig === lastSig) return;
    lastSig = sig;

    refs.list.innerHTML = rows.map(function (s) {
      var chk = selected.has(s.id) ? " checked" : "";
      var cls = "ins-run sum-row" + (s.id === openId ? " sel" : "");
      return "<div class='" + cls + "' data-id='" + s.id + "'>" +
        "<input type='checkbox' class='sum-cb' data-id='" + s.id + "'" + chk + " title='select for bulk delete'>" +
        "<div class='rt'>" +
          "<div class='sum-title mono'>" + rangeLabel(s, esc) + "</div>" +
          "<div class='sum-meta'>" + metaLine(s, ctx) + "</div>" +
          (s.snippet ? "<div class='sum-snip'>" + esc(s.snippet) + "</div>" : "") +
        "</div></div>";
    }).join("");

    Array.prototype.forEach.call(refs.list.querySelectorAll(".sum-row"), function (row) {
      row.addEventListener("click", function (e) {
        if (e.target.closest(".sum-cb")) return;
        openSummary(ctx, parseInt(row.dataset.id, 10));
        paintList(ctx);
      });
    });
    Array.prototype.forEach.call(refs.list.querySelectorAll(".sum-cb"), function (cb) {
      cb.addEventListener("change", function (e) {
        e.stopPropagation();
        var id = parseInt(cb.dataset.id, 10);
        if (cb.checked) selected.add(id); else selected.delete(id);
        lastSig = null;
        paint(ctx);
      });
    });
  }

  function paintOpen(ctx) {
    if (!refs) return;
    var esc = ctx.esc;
    if (openId == null) {
      refs.title.textContent = "Summary";
      refs.actions.innerHTML = "";
      refs.body.innerHTML =
        "<div class='op-empty'>" + ctx.icon.file +
        "<div class='t'>Select a summary to read it</div>" +
        "<div class='h'>Pick one from the list on the left.</div></div>";
      loadedOpenId = null;
      refs.paintedKey = null;
      return;
    }
    var s = null;
    for (var i = 0; i < data.length; i++) { if (data[i].id === openId) { s = data[i]; break; } }
    refs.title.textContent = s ? (s.start + (s.end && s.end !== s.start ? " → " + s.end : "")) : "Summary";

    // Only rebuild the actions + body when the open summary or its content actually
    // changed. paintOpen fires on every 2s poll while a summary is open; blindly
    // re-setting body.innerHTML each time would wipe the user's text selection
    // mid-drag (they could never select-and-copy). Key on id + load/error state +
    // content length so a real change still repaints.
    var paintKey = openId + ":" + (openError ? "err" : loadedOpenId !== openId ? "loading" : (openContent ? openContent.length : 0));
    if (refs.paintedKey === paintKey) return;
    refs.paintedKey = paintKey;

    // action buttons (rebuilt only when the open item changes)
    refs.actions.innerHTML =
      "<button class='btn sm' id='opSumCopy' title='Copy markdown'>Copy</button>" +
      "<button class='btn sm' id='opSumDl' title='Download .md'>" + ctx.icon.file + "Download</button>" +
      "<button class='btn danger sm' id='opSumDel' title='Delete'>Delete</button>";
    refs.actions.querySelector("#opSumCopy").addEventListener("click", function () {
      if (navigator.clipboard) navigator.clipboard.writeText(openContent || "");
      ctx.toast("Copied to clipboard", "ok");
    });
    refs.actions.querySelector("#opSumDl").addEventListener("click", function () {
      var blob = new Blob([openContent || ""], { type: "text/markdown" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      var st = (s && s.start) || openId;
      var en = s && s.end && s.end !== s.start ? "_" + s.end : "";
      a.download = "summary-" + st + en + ".md";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    refs.actions.querySelector("#opSumDel").addEventListener("click", function () {
      if (!confirm("Delete this summary? This can't be undone.")) return;
      var id = openId;
      deleteOne(ctx, id).then(function (ok) {
        openId = null; openContent = ""; loadedOpenId = null;
        selected.delete(id);
        lastSig = null;
        ctx.toast(ok ? "Summary deleted" : "Delete failed", ok ? "ok" : "err");
        fetchList(ctx, true);
        paint(ctx);
      });
    });

    // body
    if (openError) {
      refs.body.innerHTML = "<div class='sum-err'>" + esc(openError) + "</div>";
      loadedOpenId = null;
      return;
    }
    if (loadedOpenId !== openId) {
      refs.body.innerHTML = "<div class='sum-loading'>loading…</div>";
      return;
    }
    // already-painted content stays put unless the open item changed
    refs.body.innerHTML = mdToHtml(openContent, esc);
  }

  function bulkDelete(ctx) {
    var ids = Array.from(selected);
    if (!ids.length) return;
    if (!confirm("Delete " + ids.length + " summar" + (ids.length === 1 ? "y" : "ies") + "? This can't be undone.")) return;
    var btn = refs.bulk.querySelector("#opSumBulkDel");
    if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
    var jobs = ids.map(function (id) { return deleteOne(ctx, id); });
    Promise.all(jobs).then(function (results) {
      var ok = results.filter(Boolean).length;
      ids.forEach(function (id) { if (id === openId) { openId = null; openContent = ""; loadedOpenId = null; } });
      selected.clear();
      selectMode = false;
      lastSig = null;
      ctx.toast("Deleted " + ok + " summar" + (ok === 1 ? "y" : "ies"), ok < ids.length ? "err" : "ok");
      fetchList(ctx, true);
      paint(ctx);
    });
  }

  // ---- generate modal ------------------------------------------------------
  function errMsg(j) {
    if (!j) return "";
    if (typeof j.error === "string") return j.error;
    if (j.error && j.error.message) return j.error.message;
    return j.message || "";
  }

  function openGenModal(ctx) {
    var existing = document.querySelector(".op-sum-modal");
    if (existing) existing.remove();
    var overlay = document.createElement("div");
    overlay.className = "op-sum-modal";
    var today = ctx.now ? new Date(ctx.now()).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    overlay.innerHTML =
      "<div class='op-sum-modal-box'>" +
        "<div class='op-sum-modal-h'>Generate work summary</div>" +
        "<div class='op-sum-modal-sub'>Covers every agent's work and all your GitHub contributions for the day — regardless of working directory.</div>" +
        "<label class='op-sum-fld'><span>Day</span><input id='genDate' type='date' value='" + today + "'></label>" +
        "<label class='op-sum-fld'><span>GitHub author</span><input id='genAuthor' type='text' placeholder='your-github-username' autocomplete='off' spellcheck='false'></label>" +
        "<label class='op-sum-fld'><span>Repos <em>(optional, comma-separated)</em></span><input id='genRepos' type='text' placeholder='owner/repo, owner/repo2' autocomplete='off' spellcheck='false'></label>" +
        "<label class='op-sum-fld'><span>Model <em>(Haiku is cheaper for this)</em></span><select id='genModel'><option value='haiku'>Haiku — cheapest</option><option value='sonnet'>Sonnet</option><option value='opus'>Opus — priciest</option></select></label>" +
        "<div class='op-sum-modal-note' id='genNote'>An agent spawns in a local repo, gathers the day's work, and saves the summary here when done.</div>" +
        "<div class='op-sum-modal-actions'>" +
          "<button class='btn sm' id='genCancel'>Cancel</button>" +
          "<button class='btn sm gen' id='genGo'>Generate</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    var dateEl = overlay.querySelector("#genDate");
    var authEl = overlay.querySelector("#genAuthor");
    var repoEl = overlay.querySelector("#genRepos");
    var modelEl = overlay.querySelector("#genModel");
    var note = overlay.querySelector("#genNote");
    var goBtn = overlay.querySelector("#genGo");

    // prefill author + repos + model from saved config
    fetch("/api/config", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var c = unwrap(r) || {};
        if (!authEl.value) authEl.value = c.summaryAuthor || "";
        if (!repoEl.value) repoEl.value = c.summaryRepos || "";
        if (c.summaryModel && modelEl.querySelector("option[value='" + c.summaryModel + "']")) modelEl.value = c.summaryModel;
      })
      .catch(function () {});

    var close = function () {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    overlay.querySelector("#genCancel").addEventListener("click", close);
    setTimeout(function () { authEl.focus(); }, 30);

    goBtn.addEventListener("click", function () {
      var author = authEl.value.trim();
      if (!author) {
        note.textContent = "Enter a GitHub author to attribute the work to.";
        note.className = "op-sum-modal-note err";
        authEl.focus();
        return;
      }
      goBtn.disabled = true;
      goBtn.textContent = "Starting…";
      fetch("/api/summary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateEl.value, author: author, repos: repoEl.value.trim(), model: modelEl.value })
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: unwrap(j) }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(errMsg(res.j) || "couldn't start the summary agent");
          close();
          ctx.toast("Summary agent started for " + (res.j.date || dateEl.value) + " — it'll appear here when done", "ok");
        })
        .catch(function (e) {
          note.textContent = (e && e.message) || "Failed to start the summary agent.";
          note.className = "op-sum-modal-note err";
          goBtn.disabled = false;
          goBtn.textContent = "Generate";
        });
    });
  }

  function paint(ctx) { paintList(ctx); paintOpen(ctx); }

  // ---- render (build + every 2s poll) --------------------------------------
  // Refresh the list only when it's safe to do so — never while a summary is
  // open, selections are active, or the user is typing in the filter. Otherwise
  // just repaint from cache so open content and checkboxes are preserved.
  function render(state, ctx) {
    if (!refs) return;
    var safe = openId == null && selected.size === 0 && !searchFocused && !loading;
    if (safe) fetchList(ctx);
    else paint(ctx);
  }

  window.OP_VIEWS["summaries"] = { build: build, render: render };
})();
