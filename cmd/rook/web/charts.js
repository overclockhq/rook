/* ============================================================
   rook charts — dependency-free, theme-aware SVG data-viz.
   Exposes window.rookCharts = { barChart, lineArea, donut, traceTimeline }.

   Design notes (dataviz practice):
   - One accent per series by default; a fixed categorical order for
     multi-series marks (donut slices, timeline span types), never cycled hues.
   - Mark colors are set via the CSS custom properties (var(--accent) etc.)
     through element.style, so charts follow theme switches live without a
     re-render. Text/grid/axis inherit their tokens from charts.css.
   - Faint grid, emphasized endpoints, selective labels, subtle motion only,
     and every chart ships a hover tooltip / crosshair.
   - Responsive: viewBox + width:100%. Animation respects
     prefers-reduced-motion.
   ============================================================ */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  // Fixed categorical order — assigned in sequence, never cycled past its end
  // without folding extras into the neutral (--muted) slot.
  var CAT = ['var(--accent)', 'var(--blue)', 'var(--shell)', 'var(--busy)', 'var(--muted)'];

  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      }
    }
    return e;
  }

  function resolve(target) {
    if (!target) return null;
    return typeof target === 'string' ? document.querySelector(target) : target;
  }

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Compact number formatter (tokens etc.); callers can override via opts.format.
  function fmtNum(n) {
    n = +n || 0;
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function fmtDur(ms) {
    ms = +ms || 0;
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(2).replace(/\.?0+$/, '') + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  function emptyNote(msg) {
    var p = document.createElement('p');
    p.className = 'rc-empty';
    p.textContent = msg;
    return p;
  }

  function colorAt(i, override) {
    return override || CAT[Math.min(i, CAT.length - 1)];
  }

  // ---- shared floating tooltip ------------------------------------------
  function tipNode() {
    var t = document.getElementById('rook-chart-tip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'rook-chart-tip';
      t.className = 'rook-tip';
      t.setAttribute('role', 'tooltip');
      document.body.appendChild(t);
    }
    return t;
  }

  function showTip(html, ev) {
    var t = tipNode();
    t.innerHTML = html;
    t.classList.add('show');
    moveTip(ev);
  }

  function moveTip(ev) {
    var t = document.getElementById('rook-chart-tip');
    if (!t) return;
    var pad = 14, r = t.getBoundingClientRect();
    var x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
    t.style.left = Math.max(4, x) + 'px';
    t.style.top = Math.max(4, y) + 'px';
  }

  function hideTip() {
    var t = document.getElementById('rook-chart-tip');
    if (t) t.classList.remove('show');
  }

  function makeSVG(w, h, label) {
    return el('svg', {
      viewBox: '0 0 ' + w + ' ' + h,
      width: '100%', height: h,
      preserveAspectRatio: 'xMinYMin meet',
      class: 'rook-chart',
      role: 'img',
      'aria-label': label || 'chart'
    });
  }

  // =======================================================================
  // barChart — horizontal bars, value labels, hover tooltip, animated width.
  //   opts: { series:[{label,value,sub,color?}], format? }
  // =======================================================================
  function barChart(target, opts) {
    var node = resolve(target);
    if (!node) return;
    opts = opts || {};
    var series = opts.series || [];
    var fmt = opts.format || fmtNum;
    var reduce = reduceMotion();

    node.innerHTML = '';
    if (!series.length) { node.appendChild(emptyNote('No data')); return; }

    var W = 600, rowH = 44, padT = 6, padB = 4;
    var H = padT + padB + series.length * rowH;
    var max = 1;
    series.forEach(function (s) { max = Math.max(max, Math.abs(+s.value || 0)); });

    var svg = makeSVG(W, H, 'bar chart of ' + series.length + ' items');

    series.forEach(function (s, i) {
      var y = padT + i * rowH;
      var color = colorAt(0, s.color); // single accent per series by default
      var val = +s.value || 0;

      var lab = el('text', { x: 0, y: y + 12, class: 'rc-label' });
      lab.textContent = s.label;
      svg.appendChild(lab);

      var vt = el('text', { x: W, y: y + 12, 'text-anchor': 'end', class: 'rc-val' });
      vt.textContent = fmt(val);
      svg.appendChild(vt);

      var ty = y + 19, th = 16;
      svg.appendChild(el('rect', { x: 0, y: ty, width: W, height: th, rx: 5, class: 'rc-track' }));

      var w = val ? Math.max((Math.abs(val) / max) * W, 4) : 0;
      var bar = el('rect', { x: 0, y: ty, width: w, height: th, rx: 5, class: 'rc-bar' });
      bar.style.fill = color;
      if (!reduce && w > 0) {
        bar.style.transformBox = 'fill-box';
        bar.style.transformOrigin = 'left center';
        bar.style.transform = 'scaleX(0)';
        bar.style.transition = 'transform .5s cubic-bezier(.22,.61,.36,1)';
        bar.style.transitionDelay = (i * 40) + 'ms';
      }
      svg.appendChild(bar);

      var hit = el('rect', { x: 0, y: y, width: W, height: rowH - 2, fill: 'transparent', class: 'rc-hit' });
      var html = '<b>' + esc(s.label) + '</b>' +
        (s.sub ? '<span class="rc-tip-sub">' + esc(s.sub) + '</span>' : '') +
        '<span class="rc-tip-v">' + esc(fmt(val)) + '</span>';
      hit.addEventListener('pointerenter', function (e) { showTip(html, e); });
      hit.addEventListener('pointermove', moveTip);
      hit.addEventListener('pointerleave', hideTip);
      svg.appendChild(hit);
    });

    node.appendChild(svg);

    if (!reduce) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var bars = svg.querySelectorAll('.rc-bar');
          for (var i = 0; i < bars.length; i++) bars[i].style.transform = 'scaleX(1)';
        });
      });
    }
  }

  // =======================================================================
  // lineArea — area+line with faint grid, emphasized endpoint,
  //   hover crosshair + tooltip. Caller drives the metric toggle by
  //   re-invoking with new points; optional legend via opts.series.
  //   opts: { points:[{x,label,value}], series?:[{name,color?}], format? }
  // =======================================================================
  function lineArea(target, opts) {
    var node = resolve(target);
    if (!node) return;
    opts = opts || {};
    var pts = opts.points || [];
    var fmt = opts.format || fmtNum;
    var reduce = reduceMotion();
    var legend = normalizeSeries(opts.series);
    var color = (legend[0] && legend[0].color) || 'var(--accent)';

    node.innerHTML = '';
    if (pts.length < 2) { node.appendChild(emptyNote('Not enough data')); return; }

    if (legend.length) node.appendChild(buildLegend(legend, null, fmt, false));

    var W = 640, H = 200, L = 46, R = 14, T = 14, B = 26;
    var plotW = W - L - R, plotH = H - T - B;
    var vals = pts.map(function (p) { return +p.value || 0; });
    var max = Math.max.apply(null, vals);
    var min = Math.min.apply(null, vals.concat([0]));
    if (max === min) max = min + 1;

    var X = function (i) { return L + (i / (pts.length - 1)) * plotW; };
    var Y = function (v) { return T + plotH - (v - min) / (max - min) * plotH; };

    var svg = makeSVG(W, H, 'trend over ' + pts.length + ' points');

    // faint horizontal grid + y labels
    var rows = 4;
    for (var g = 0; g <= rows; g++) {
      var gv = min + (max - min) * (g / rows);
      var gy = Y(gv);
      svg.appendChild(el('line', { x1: L, y1: gy, x2: L + plotW, y2: gy, class: 'rc-grid' }));
      var yl = el('text', { x: L - 8, y: gy + 3, 'text-anchor': 'end', class: 'rc-axis' });
      yl.textContent = fmt(gv);
      svg.appendChild(yl);
    }

    // area + line paths
    var linePts = pts.map(function (p, i) { return X(i) + ',' + Y(vals[i]); });
    var areaD = 'M' + X(0) + ',' + (T + plotH) + ' L' + linePts.join(' L') +
      ' L' + X(pts.length - 1) + ',' + (T + plotH) + ' Z';
    var area = el('path', { d: areaD, class: 'rc-area' });
    area.style.fill = color;
    svg.appendChild(area);

    var line = el('path', { d: 'M' + linePts.join(' L'), class: 'rc-line' });
    line.style.stroke = color;
    svg.appendChild(line);

    // x labels — selective, no crowding
    var step = Math.max(1, Math.ceil(pts.length / 6));
    pts.forEach(function (p, i) {
      if (i % step !== 0 && i !== pts.length - 1) return;
      var anchor = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      var xl = el('text', { x: X(i), y: H - 8, 'text-anchor': anchor, class: 'rc-axis' });
      xl.textContent = p.label != null ? p.label : (p.x != null ? p.x : i);
      svg.appendChild(xl);
    });

    // emphasized endpoint
    var last = pts.length - 1;
    var end = el('circle', { cx: X(last), cy: Y(vals[last]), r: 4.5, class: 'rc-endpoint' });
    end.style.fill = color;
    svg.appendChild(end);

    // hover crosshair + dot + capture overlay
    var cross = el('line', { x1: L, y1: T, x2: L, y2: T + plotH, class: 'rc-cross' });
    cross.style.opacity = 0;
    svg.appendChild(cross);
    var dot = el('circle', { cx: L, cy: T, r: 4, class: 'rc-cross-dot' });
    dot.style.fill = color;
    dot.style.opacity = 0;
    svg.appendChild(dot);

    var overlay = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
    overlay.addEventListener('pointermove', function (e) {
      var r = svg.getBoundingClientRect();
      var sx = ((e.clientX - r.left) / r.width) * W;
      var idx = 0, best = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(X(i) - sx);
        if (d < best) { best = d; idx = i; }
      }
      var px = X(idx), py = Y(vals[idx]);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.style.opacity = 1;
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.style.opacity = 1;
      var name = legend[0] ? esc(legend[0].name) + ' · ' : '';
      showTip('<b>' + esc(pts[idx].label) + '</b><span class="rc-tip-v">' +
        name + esc(fmt(vals[idx])) + '</span>', e);
    });
    overlay.addEventListener('pointerleave', function () {
      cross.style.opacity = 0; dot.style.opacity = 0; hideTip();
    });
    svg.appendChild(overlay);

    node.appendChild(svg);

    // subtle line-draw + area fade
    if (!reduce) {
      try {
        var len = line.getTotalLength();
        line.style.strokeDasharray = len;
        line.style.strokeDashoffset = len;
        line.style.transition = 'stroke-dashoffset .7s ease';
        area.style.opacity = 0;
        area.style.transition = 'opacity .7s ease';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            line.style.strokeDashoffset = 0;
            area.style.opacity = '';
          });
        });
      } catch (e) { /* getTotalLength unsupported — leave static */ }
    }
  }

  // =======================================================================
  // donut — cost/identity share. Fixed categorical colors, gaps between
  //   segments, center total, legend, hover highlight + tooltip.
  //   opts: { slices:[{label,value,color?}], format? }
  // =======================================================================
  function donut(target, opts) {
    var node = resolve(target);
    if (!node) return;
    opts = opts || {};
    var slices = (opts.slices || []).filter(function (s) { return (+s.value || 0) > 0; });
    var fmt = opts.format || fmtNum;
    var reduce = reduceMotion();

    node.innerHTML = '';
    if (!slices.length) { node.appendChild(emptyNote('No data')); return; }

    var total = slices.reduce(function (a, s) { return a + (+s.value || 0); }, 0);
    var W = 200, H = 200, cx = 100, cy = 100, rO = 82, rI = 52;
    var r = (rO + rI) / 2, C = 2 * Math.PI * r, sw = rO - rI;

    var wrap = document.createElement('div');
    wrap.className = 'rc-donut-wrap';

    var svg = makeSVG(W, H, 'share across ' + slices.length + ' slices');
    var arcs = [];
    var off = 0;
    slices.forEach(function (s, i) {
      var val = +s.value || 0;
      var frac = val / total;
      var seg = frac * C;
      var gap = slices.length > 1 ? 2 : 0;
      var dash = Math.max(seg - gap, 0.001);
      var arc = el('circle', {
        cx: cx, cy: cy, r: r, fill: 'none',
        'stroke-width': sw,
        'stroke-dasharray': dash + ' ' + (C - dash),
        'stroke-dashoffset': -off,
        transform: 'rotate(-90 ' + cx + ' ' + cy + ')',
        class: 'rc-arc'
      });
      arc.style.stroke = colorAt(i, s.color);
      var html = '<b>' + esc(s.label) + '</b><span class="rc-tip-v">' +
        esc(fmt(val)) + ' · ' + (frac * 100).toFixed(1) + '%</span>';
      arc.addEventListener('pointerenter', function (e) {
        svg.classList.add('rc-dim'); arc.classList.add('rc-on'); showTip(html, e);
      });
      arc.addEventListener('pointermove', moveTip);
      arc.addEventListener('pointerleave', function () {
        svg.classList.remove('rc-dim'); arc.classList.remove('rc-on'); hideTip();
      });
      svg.appendChild(arc);
      arcs.push(arc);
      off += seg;
    });

    // center total
    var ct = el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'rc-center-v' });
    ct.textContent = fmt(total);
    svg.appendChild(ct);
    var cl = el('text', { x: cx, y: cy + 14, 'text-anchor': 'middle', class: 'rc-center-l' });
    cl.textContent = 'total';
    svg.appendChild(cl);

    wrap.appendChild(svg);
    wrap.appendChild(buildLegend(slices.map(function (s, i) {
      return { name: s.label, color: colorAt(i, s.color), value: +s.value || 0 };
    }), total, fmt, true));
    node.appendChild(wrap);

    if (!reduce) {
      arcs.forEach(function (a, i) {
        a.style.opacity = 0;
        a.style.transition = 'opacity .4s ease';
        a.style.transitionDelay = (i * 60) + 'ms';
      });
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          arcs.forEach(function (a) { a.style.opacity = ''; });
        });
      });
    }
  }

  // =======================================================================
  // traceTimeline — Langfuse-style waterfall of one run's tool calls.
  //   Rows indented by depth, bars positioned on a shared time axis by
  //   startMs/durMs, colored by span type, hover shows name+duration+cost.
  //   opts: { spans:[{name,type,startMs,durMs,costUsd?,depth}] }
  // =======================================================================
  function traceTimeline(target, opts) {
    var node = resolve(target);
    if (!node) return;
    opts = opts || {};
    var spans = opts.spans || [];
    var reduce = reduceMotion();

    node.innerHTML = '';
    if (!spans.length) { node.appendChild(emptyNote('No spans')); return; }

    var t0 = Infinity, t1 = -Infinity;
    spans.forEach(function (s) {
      var st = +s.startMs || 0, en = st + (+s.durMs || 0);
      if (st < t0) t0 = st;
      if (en > t1) t1 = en;
    });
    var span = Math.max(t1 - t0, 1);

    var types = [];
    spans.forEach(function (s) {
      var t = s.type || 'tool';
      if (types.indexOf(t) === -1) types.push(t);
    });
    var typeColor = function (t) { return colorAt(types.indexOf(t), null); };

    var W = 720, rowH = 24, padT = 22, padB = 8;
    var labW = 220, plotL = labW + 8, plotR = W - 12, plotW = plotR - plotL;
    var H = padT + padB + spans.length * rowH;
    var X = function (ms) { return plotL + ((ms - t0) / span) * plotW; };

    var svg = makeSVG(W, H, 'trace timeline of ' + spans.length + ' spans');

    // time axis: 5 ticks with elapsed labels + faint vertical gridlines
    var ticks = 4;
    for (var k = 0; k <= ticks; k++) {
      var tv = span * (k / ticks);
      var tx = plotL + (k / ticks) * plotW;
      svg.appendChild(el('line', { x1: tx, y1: padT - 6, x2: tx, y2: H - padB, class: 'rc-grid' }));
      var tl = el('text', {
        x: tx, y: 12,
        'text-anchor': k === 0 ? 'start' : (k === ticks ? 'end' : 'middle'),
        class: 'rc-axis'
      });
      tl.textContent = fmtDur(tv);
      svg.appendChild(tl);
    }

    spans.forEach(function (s, i) {
      var y = padT + i * rowH;
      var depth = Math.max(0, +s.depth || 0);
      // errored calls read red regardless of type; that's the signal you want
      var color = s.isError ? '#e5533a' : typeColor(s.type || 'tool');
      var st = +s.startMs || 0, dur = +s.durMs || 0;

      // row hover band
      var band = el('rect', { x: 0, y: y, width: W, height: rowH, class: 'rc-row' });
      svg.appendChild(band);

      // indented label (nesting), truncated to the label gutter so long
      // names (e.g. full shell command paths) never bleed onto the bars
      var lx = 6 + depth * 14;
      var lab = el('text', { x: lx, y: y + rowH / 2 + 4, class: 'rc-tl-label' });
      var maxChars = Math.max(6, Math.floor((labW - lx) / 6.4));
      var nm = String(s.name == null ? '' : s.name);
      lab.textContent = nm.length > maxChars ? nm.slice(0, maxChars - 1) + '…' : nm;
      svg.appendChild(lab);

      // bar on the shared axis
      var bx = X(st);
      var bw = Math.max((dur / span) * plotW, 3);
      var by = y + 5, bh = rowH - 10;
      var bar = el('rect', { x: bx, y: by, width: bw, height: bh, rx: 4, class: 'rc-tl-bar' });
      bar.style.fill = color;
      // still-running (no result yet) → estimated width, drawn faint + dashed
      if (s.estimated) { bar.style.opacity = '0.4'; bar.setAttribute('stroke', color); bar.setAttribute('stroke-dasharray', '3 2'); }
      svg.appendChild(bar);

      var cost = s.costUsd != null ? '<span class="rc-tip-sub">$' + (+s.costUsd).toFixed(4) + '</span>' : '';
      var note = s.isError ? '<span class="rc-tip-sub" style="color:#e5533a">error</span>' : (s.estimated ? '<span class="rc-tip-sub">running · est.</span>' : '');
      var html = '<b>' + esc(s.name) + '</b>' +
        '<span class="rc-tip-sub">' + esc(s.type || 'tool') + '</span>' + cost + note +
        '<span class="rc-tip-v">' + fmtDur(dur) + '</span>';
      var enter = function (e) { band.classList.add('rc-on'); showTip(html, e); };
      band.addEventListener('pointerenter', enter);
      band.addEventListener('pointermove', moveTip);
      band.addEventListener('pointerleave', function () { band.classList.remove('rc-on'); hideTip(); });

      if (!reduce) {
        bar.style.transformBox = 'fill-box';
        bar.style.transformOrigin = 'left center';
        bar.style.transform = 'scaleX(0)';
        bar.style.transition = 'transform .4s ease';
        bar.style.transitionDelay = (i * 25) + 'ms';
      }
    });

    node.appendChild(svg);

    // type legend
    if (types.length > 1) {
      node.appendChild(buildLegend(types.map(function (t) {
        return { name: t, color: typeColor(t) };
      }), null, null, false));
    }

    if (!reduce) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var bars = svg.querySelectorAll('.rc-tl-bar');
          for (var i = 0; i < bars.length; i++) bars[i].style.transform = 'scaleX(1)';
        });
      });
    }
  }

  // ---- shared legend + helpers ------------------------------------------
  function normalizeSeries(series) {
    if (!series) return [];
    if (typeof series === 'string') return [{ name: series }];
    if (Array.isArray(series)) {
      return series.map(function (s) {
        return typeof s === 'string' ? { name: s } : s;
      });
    }
    return [series];
  }

  // items: [{name,color?,value?}]. If total given, shows a percentage.
  function buildLegend(items, total, fmt, withValues) {
    var box = document.createElement('div');
    box.className = 'rc-legend';
    items.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'rc-leg-item';
      var sw = document.createElement('span');
      sw.className = 'rc-swatch';
      sw.style.background = it.color || colorAt(i, null);
      var name = document.createElement('span');
      name.className = 'rc-leg-name';
      name.textContent = it.name;
      row.appendChild(sw);
      row.appendChild(name);
      if (withValues && it.value != null) {
        var v = document.createElement('span');
        v.className = 'rc-leg-val';
        var pct = total ? ' · ' + ((it.value / total) * 100).toFixed(0) + '%' : '';
        v.textContent = (fmt ? fmt(it.value) : it.value) + pct;
        row.appendChild(v);
      }
      box.appendChild(row);
    });
    return box;
  }

  window.rookCharts = {
    barChart: barChart,
    lineArea: lineArea,
    donut: donut,
    traceTimeline: traceTimeline,
    fmtNum: fmtNum,
    fmtDur: fmtDur
  };
})();
