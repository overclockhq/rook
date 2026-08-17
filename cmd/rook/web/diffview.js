/* diffview.js — best-in-class code review surface for rook.
   Exposes window.renderDiffV2(mountEl, data, opts).

   data = { base, files:[{path,status,add,del}], patch, add, del, truncated }
   opts = { onSend(comments) }  where comments = [{file, line, side, text}]

   Self-contained: parses the unified `patch` itself, highlights with a vendored
   highlight.js (guarded — degrades to escaped plaintext if hljs is absent). */
(function () {
  "use strict";

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Map file extensions / basenames to highlight.js language ids.
  var EXT_LANG = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    go: "go", rs: "rust", py: "python", rb: "ruby", php: "php",
    java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", swift: "swift",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
    cs: "csharp", m: "objectivec", mm: "objectivec",
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
    xml: "xml", html: "xml", htm: "xml", svg: "xml", vue: "xml",
    css: "css", scss: "scss", sass: "scss", less: "less",
    md: "markdown", markdown: "markdown", mdx: "markdown",
    sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
    dockerfile: "dockerfile", makefile: "makefile", mk: "makefile",
    lua: "lua", pl: "perl", r: "r", dart: "dart", ex: "elixir", exs: "elixir",
    erl: "erlang", clj: "clojure", hs: "haskell", tf: "hcl", hcl: "hcl",
    diff: "diff", patch: "diff", bru: "javascript",
  };
  function langFor(path) {
    if (!path) return "plaintext";
    var base = path.split("/").pop().toLowerCase();
    if (base === "dockerfile") return "dockerfile";
    if (base === "makefile") return "makefile";
    var dot = base.lastIndexOf(".");
    if (dot < 0) return "plaintext";
    return EXT_LANG[base.slice(dot + 1)] || "plaintext";
  }

  var _langOK = {};
  function langAvailable(lang) {
    if (lang in _langOK) return _langOK[lang];
    var ok = false;
    try {
      ok = typeof window.hljs !== "undefined" &&
        typeof window.hljs.getLanguage === "function" &&
        !!window.hljs.getLanguage(lang);
    } catch (e) { ok = false; }
    _langOK[lang] = ok;
    return ok;
  }
  // Highlight a single line of source. Returns safe HTML. Falls back to escaped
  // plaintext when hljs is missing or the language is unknown.
  function hl(text, lang) {
    if (text === "") return "";
    if (lang && lang !== "plaintext" && langAvailable(lang)) {
      try {
        return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch (e) { /* fall through */ }
    }
    return esc(text);
  }

  // ---------------------------------------------------------------- parsing
  // parsePatch turns a unified git diff into [{path, oldPath, binary, hunks:[
  //   {header, section, lines:[{type:'add'|'del'|'context', oldNo, newNo, text}]}]}].
  function parsePatch(patch) {
    var files = [];
    if (!patch) return files;
    var lines = patch.split("\n");
    var cur = null, hunk = null, oldNo = 0, newNo = 0;

    function startFile(p, oldP) {
      cur = { path: p || "", oldPath: oldP || "", binary: false, hunks: [] };
      files.push(cur);
      hunk = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (raw === "") continue; // separators / trailing newline (blank context is " ")

      if (raw.indexOf("diff --git ") === 0) {
        var m = raw.match(/^diff --git a\/(.*) b\/(.*)$/);
        if (m) startFile(m[2], m[1]); else startFile("", "");
        continue;
      }
      if (cur == null) continue; // stray leading lines before any file header

      if (raw.indexOf("--- ") === 0) {
        var op = raw.slice(4);
        if (op !== "/dev/null") cur.oldPath = op.replace(/^a\//, "");
        continue;
      }
      if (raw.indexOf("+++ ") === 0) {
        var np = raw.slice(4);
        if (np !== "/dev/null") cur.path = np.replace(/^b\//, "");
        continue;
      }
      if (raw.indexOf("Binary files") === 0 || raw.indexOf("GIT binary patch") === 0) {
        cur.binary = true;
        continue;
      }
      if (raw.indexOf("@@") === 0) {
        var hm = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
        oldNo = hm ? parseInt(hm[1], 10) : 0;
        newNo = hm ? parseInt(hm[2], 10) : 0;
        hunk = { header: raw, section: hm ? hm[3].trim() : "", lines: [] };
        cur.hunks.push(hunk);
        continue;
      }
      if (hunk == null) continue; // meta: index / mode / rename / similarity …

      var t = raw.charAt(0);
      if (t === "\\") continue; // "\ No newline at end of file"
      if (t === "+") {
        hunk.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
      } else if (t === "-") {
        hunk.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
      } else { // " " context
        hunk.lines.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
      }
    }
    return files;
  }

  // Pair del/add runs for the split view. Context lines mirror on both sides.
  function pairLines(lns) {
    var rows = [], i = 0;
    while (i < lns.length) {
      var l = lns[i];
      if (l.type === "context") { rows.push({ left: l, right: l }); i++; continue; }
      var dels = [], adds = [];
      while (i < lns.length && lns[i].type === "del") { dels.push(lns[i]); i++; }
      while (i < lns.length && lns[i].type === "add") { adds.push(lns[i]); i++; }
      if (!dels.length && !adds.length) { i++; continue; }
      var n = Math.max(dels.length, adds.length);
      for (var k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
    }
    return rows;
  }

  // ---------------------------------------------------------------- render
  var ST_LABEL = { M: "M", A: "A", D: "D", R: "R", C: "C", "?": "+" };
  var ST_CLASS = { M: "mod", A: "add", D: "del", R: "ren", C: "cpy", "?": "new" };

  function renderDiffV2(mount, data, opts) {
    opts = opts || {};
    data = data || {};
    var files = data.files || [];
    var parsed = parsePatch(data.patch || "");
    var byPath = {};
    parsed.forEach(function (f) { byPath[f.path] = f; });

    // Merge: authoritative order/status from data.files; content from parsed.
    // Include any parsed file missing from data.files (defensive) at the end.
    var seen = {};
    var merged = files.map(function (f) {
      seen[f.path] = true;
      return { meta: f, parsed: byPath[f.path] || null };
    });
    parsed.forEach(function (f) {
      if (!seen[f.path]) {
        merged.push({ meta: { path: f.path, status: "M", add: 0, del: 0 }, parsed: f });
      }
    });

    var mode = "unified"; // or "split"
    var comments = []; // {id, file, line, side, text}
    var cid = 0;

    mount.innerHTML = "";
    var root = document.createElement("div");
    root.className = "dv2";
    mount.appendChild(root);

    if (!merged.length) {
      root.innerHTML = '<p class="dv2-empty">No changes yet — nothing differs from the base.</p>';
      return;
    }

    var baseShort = (data.base || "").length > 12 ? data.base.slice(0, 12) : (data.base || "HEAD");

    // ----- tree (left) -----
    var tree = document.createElement("aside");
    tree.className = "dv2-tree";
    tree.innerHTML =
      '<div class="dv2-tree-head">' + merged.length + " file" + (merged.length === 1 ? "" : "s") + "</div>" +
      '<div class="dv2-tree-list">' +
      merged.map(function (item, i) {
        var f = item.meta;
        var sc = ST_CLASS[f.status] || "mod";
        return '<button class="dv2-tI" data-jump="' + i + '" title="' + esc(f.path) + '">' +
          '<span class="dv2-chip dv2-chip-' + sc + '">' + (ST_LABEL[f.status] || esc(f.status)) + "</span>" +
          '<span class="dv2-tI-name">' + esc(f.path) + "</span>" +
          '<span class="dv2-tI-n"><span class="dv2-add">+' + (f.add > 0 ? f.add : 0) + "</span> " +
          '<span class="dv2-del">−' + (f.del > 0 ? f.del : 0) + "</span></span>" +
          '</button>';
      }).join("") +
      "</div>";
    root.appendChild(tree);

    // ----- main (right) -----
    var main = document.createElement("main");
    main.className = "dv2-main";
    root.appendChild(main);

    var head = document.createElement("header");
    head.className = "dv2-head";
    head.innerHTML =
      '<div class="dv2-totals">' +
      "<strong>" + merged.length + "</strong> file" + (merged.length === 1 ? "" : "s") +
      ' · <span class="dv2-add">+' + (data.add || 0) + "</span> " +
      '<span class="dv2-del">−' + (data.del || 0) + "</span>" +
      ' · <span class="dv2-base mono" title="diffed against">' + esc(baseShort) + "</span>" +
      (data.truncated ? ' · <span class="dv2-trunc">truncated</span>' : "") +
      "</div>" +
      '<div class="dv2-seg" role="tablist">' +
      '<button class="dv2-seg-b is-on" data-mode="unified">Unified</button>' +
      '<button class="dv2-seg-b" data-mode="split">Split</button>' +
      "</div>";
    main.appendChild(head);

    var body = document.createElement("div");
    body.className = "dv2-body";
    main.appendChild(body);

    // Build a file section shell for each merged file.
    var sections = merged.map(function (item, i) {
      var f = item.meta;
      var sc = ST_CLASS[f.status] || "mod";
      var sec = document.createElement("section");
      sec.className = "dv2-file";
      sec.id = "dv2-file-" + i;
      sec.dataset.path = f.path;
      sec.innerHTML =
        '<div class="dv2-file-head">' +
        '<button class="dv2-collapse" title="Collapse / expand">▾</button>' +
        '<span class="dv2-chip dv2-chip-' + sc + '">' + (ST_LABEL[f.status] || esc(f.status)) + "</span>" +
        '<span class="dv2-file-name mono">' + esc(f.path) + "</span>" +
        '<span class="dv2-file-n"><span class="dv2-add">+' + (f.add > 0 ? f.add : 0) + "</span> " +
        '<span class="dv2-del">−' + (f.del > 0 ? f.del : 0) + "</span></span>" +
        '<label class="dv2-viewed"><input type="checkbox" class="dv2-viewed-cb"> Viewed</label>' +
        "</div>" +
        '<div class="dv2-file-body"></div>';
      body.appendChild(sec);
      return sec;
    });

    // ----- floating send button -----
    var send = document.createElement("button");
    send.className = "dv2-send";
    send.hidden = true;
    root.appendChild(send);
    function refreshSend() {
      var n = comments.length;
      send.hidden = n === 0;
      send.textContent = "Send " + n + " comment" + (n === 1 ? "" : "s") + " to agent";
    }

    // Render one code line (unified). Returns HTML string.
    function uLine(file, l) {
      var side = l.type === "del" ? "old" : "new";
      var lineNo = side === "old" ? l.oldNo : l.newNo;
      var key = file + "|" + side + "|" + lineNo;
      return '<div class="dv2-line dv2-' + l.type + '" data-key="' + esc(key) + '">' +
        '<span class="dv2-ln">' + (l.oldNo != null ? l.oldNo : "") + "</span>" +
        '<span class="dv2-ln">' + (l.newNo != null ? l.newNo : "") + "</span>" +
        '<button class="dv2-plus" data-file="' + esc(file) + '" data-side="' + side +
        '" data-line="' + lineNo + '" title="Add comment">+</button>' +
        '<span class="dv2-sign">' + (l.type === "add" ? "+" : l.type === "del" ? "−" : " ") + "</span>" +
        '<code class="dv2-src">' + (hl(l.text, langFor(file)) || "&nbsp;") + "</code>" +
        "</div>";
    }

    // Render one split cell for a side ('old'|'new'). l may be null (filler).
    function sCell(file, l, side) {
      if (!l) return '<div class="dv2-cell dv2-empty"></div>';
      var lineNo = side === "old" ? l.oldNo : l.newNo;
      var key = file + "|" + side + "|" + lineNo;
      return '<div class="dv2-cell dv2-' + l.type + '" data-key="' + esc(key) + '">' +
        '<span class="dv2-ln">' + (lineNo != null ? lineNo : "") + "</span>" +
        '<button class="dv2-plus" data-file="' + esc(file) + '" data-side="' + side +
        '" data-line="' + lineNo + '" title="Add comment">+</button>' +
        '<span class="dv2-sign">' + (l.type === "add" ? "+" : l.type === "del" ? "−" : " ") + "</span>" +
        '<code class="dv2-src">' + (hl(l.text, langFor(file)) || "&nbsp;") + "</code>" +
        "</div>";
    }

    function fileBodyHTML(item) {
      var f = item.meta, pf = item.parsed;
      if (!pf || !pf.hunks.length) {
        if (pf && pf.binary) return '<div class="dv2-note">Binary file — no textual diff.</div>';
        return '<div class="dv2-note">No textual diff available.</div>';
      }
      var out = [];
      pf.hunks.forEach(function (h) {
        out.push('<div class="dv2-hunk">' + esc(h.header) + "</div>");
        if (mode === "split") {
          pairLines(h.lines).forEach(function (r) {
            out.push('<div class="dv2-srow">' +
              sCell(f.path, r.left, "old") + sCell(f.path, r.right, "new") + "</div>");
          });
        } else {
          h.lines.forEach(function (l) { out.push(uLine(f.path, l)); });
        }
      });
      return out.join("");
    }

    // (Re)render every open file body, then re-inject stored comments.
    function renderBodies() {
      root.classList.toggle("is-split", mode === "split");
      merged.forEach(function (item, i) {
        var sec = sections[i];
        var fb = sec.querySelector(".dv2-file-body");
        fb.innerHTML = fileBodyHTML(item);
      });
      injectComments();
    }

    function commentBlockHTML(c) {
      return '<div class="dv2-comment" data-cid="' + c.id + '">' +
        '<div class="dv2-comment-meta mono">' + esc(c.file) + ":" + c.line + " (" + c.side + ")</div>" +
        '<div class="dv2-comment-text"></div>' +
        '<button class="dv2-comment-del" title="Remove">×</button>' +
        "</div>";
    }

    function injectComments() {
      comments.forEach(function (c) {
        var key = c.file + "|" + c.side + "|" + c.line;
        // In split view a key exists once (on its side's cell); in unified once too.
        var el = body.querySelector('[data-key="' + cssEsc(key) + '"]');
        if (!el) return;
        var row = el.closest(".dv2-srow") || el.closest(".dv2-line") || el;
        var block = document.createElement("div");
        block.innerHTML = commentBlockHTML(c);
        var node = block.firstChild;
        node.querySelector(".dv2-comment-text").textContent = c.text;
        row.insertAdjacentElement("afterend", node);
      });
    }

    function cssEsc(s) {
      if (window.CSS && CSS.escape) return CSS.escape(s);
      return String(s).replace(/["\\]/g, "\\$&");
    }

    // Open an inline editor beneath a given code row.
    function openEditor(anchorRow, file, line, side) {
      if (anchorRow.nextElementSibling && anchorRow.nextElementSibling.classList.contains("dv2-editor")) {
        anchorRow.nextElementSibling.querySelector("textarea").focus();
        return;
      }
      var ed = document.createElement("div");
      ed.className = "dv2-editor";
      ed.innerHTML =
        '<div class="dv2-editor-meta mono">' + esc(file) + ":" + line + " (" + side + ")</div>" +
        '<textarea class="dv2-editor-ta" placeholder="Leave a comment for the agent…"></textarea>' +
        '<div class="dv2-editor-act">' +
        '<button class="dv2-btn dv2-btn-primary" data-do="save">Add comment</button>' +
        '<button class="dv2-btn" data-do="cancel">Cancel</button>' +
        "</div>";
      anchorRow.insertAdjacentElement("afterend", ed);
      var ta = ed.querySelector("textarea");
      ta.focus();
      ed.addEventListener("click", function (e) {
        var b = e.target.closest("[data-do]");
        if (!b) return;
        if (b.dataset.do === "cancel") { ed.remove(); return; }
        var text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        var c = { id: ++cid, file: file, line: Number(line), side: side, text: text };
        comments.push(c);
        ed.remove();
        var block = document.createElement("div");
        block.innerHTML = commentBlockHTML(c);
        var node = block.firstChild;
        node.querySelector(".dv2-comment-text").textContent = c.text;
        anchorRow.insertAdjacentElement("afterend", node);
        refreshSend();
      });
      ta.addEventListener("keydown", function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") ed.querySelector('[data-do="save"]').click();
        if (e.key === "Escape") ed.remove();
      });
    }

    // ----- events -----
    body.addEventListener("click", function (e) {
      var plus = e.target.closest(".dv2-plus");
      if (plus) {
        var row = plus.closest(".dv2-srow") || plus.closest(".dv2-line");
        openEditor(row, plus.dataset.file, plus.dataset.line, plus.dataset.side);
        return;
      }
      var del = e.target.closest(".dv2-comment-del");
      if (del) {
        var wrap = del.closest(".dv2-comment");
        var id = Number(wrap.dataset.cid);
        comments = comments.filter(function (c) { return c.id !== id; });
        wrap.remove();
        refreshSend();
        return;
      }
      var col = e.target.closest(".dv2-collapse");
      if (col) { col.closest(".dv2-file").classList.toggle("is-collapsed"); return; }
    });

    body.addEventListener("change", function (e) {
      var cb = e.target.closest(".dv2-viewed-cb");
      if (!cb) return;
      var sec = cb.closest(".dv2-file");
      sec.classList.toggle("is-viewed", cb.checked);
      sec.classList.toggle("is-collapsed", cb.checked);
    });

    tree.addEventListener("click", function (e) {
      var b = e.target.closest("[data-jump]");
      if (!b) return;
      var i = Number(b.dataset.jump);
      var sec = sections[i];
      if (sec) {
        sec.classList.remove("is-collapsed");
        sec.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      tree.querySelectorAll(".dv2-tI").forEach(function (x) { x.classList.remove("is-sel"); });
      b.classList.add("is-sel");
    });

    head.addEventListener("click", function (e) {
      var b = e.target.closest(".dv2-seg-b");
      if (!b || b.classList.contains("is-on")) return;
      mode = b.dataset.mode;
      head.querySelectorAll(".dv2-seg-b").forEach(function (x) {
        x.classList.toggle("is-on", x === b);
      });
      renderBodies();
    });

    send.addEventListener("click", function () {
      if (typeof opts.onSend === "function") {
        opts.onSend(comments.map(function (c) {
          return { file: c.file, line: c.line, side: c.side, text: c.text };
        }));
      }
    });

    renderBodies();
    refreshSend();
  }

  window.renderDiffV2 = renderDiffV2;
})();
