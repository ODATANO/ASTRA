/* Formatting, tooltip, chart and ranking-table helpers of the dashboard. Inline SVG, no framework,
   no chart library. Load before the page script. */
(function () {
  'use strict';
  const CHAIN_NAME = { cardano: 'Cardano', midnight: 'Midnight' };
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';

  function fmtNum(n, d) {
    if (n == null || isNaN(n)) return '–';
    const a = Math.abs(n);
    const trim = (s) => s.replace(/\.0+$/, '');
    if (a >= 1e9) return trim((n / 1e9).toFixed(1)) + 'B';
    if (a >= 1e6) return trim((n / 1e6).toFixed(1)) + 'M';
    if (a >= 1e4) return trim((n / 1e3).toFixed(1)) + 'K';
    if (Number.isInteger(n)) return n.toLocaleString('en-US');
    return n.toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d });
  }
  const fmtInt = (n) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('en-US'));
  const fmtPct = (x, signed) => (x == null || isNaN(x) ? '–' : `${signed && x > 0 ? '+' : ''}${Number(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) < 1 ? 2 : 1 })}%`);

  const pad = (n) => String(n).padStart(2, '0');
  const utc = (iso) => { const d = new Date(iso); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtAxisTime = (iso, gran) => { const t = utc(iso); return gran === 'day' ? `${t.d} ${MON[t.m]}` : `${pad(t.h)}:${pad(t.mi)}`; };
  const fmtFullTime = (iso, gran) => { const t = utc(iso); return gran === 'day' ? `${t.y}-${pad(t.m + 1)}-${pad(t.d)}` : `${t.y}-${pad(t.m + 1)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)} UTC`; };
  const fmtWhen = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '–');
  const ago = (iso) => { if (!iso) return '–'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 90) return `${Math.round(s)} s ago`; if (s < 5400) return `${Math.round(s / 60)} min ago`; if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`; return `${Math.round(s / 86400)} d ago`; };
  const short = (v, head, tail) => (v && v.length > (head || 12) + (tail || 6) + 1 ? `${v.slice(0, head || 12)}…${v.slice(-(tail || 6))}` : v || '');

  // ── DOM helpers ───────────────────────────────────────────
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (tag, attrs, style) => { const e = document.createElementNS(NS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); for (const k in style || {}) e.style[k] = style[k]; return e; };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  function emptyState(container, text) { clear(container).appendChild(el('div', 'empty', text)); }
  function errorState(container, err) { clear(container).appendChild(el('div', 'empty', `Could not load: ${err && err.message ? err.message : err}`)); }
  function stat(label, value, unit, hint, delta) {
    const s = el('div', 'stat');
    s.appendChild(el('div', 'label', label));
    const v = el('div', 'value', value);
    if (unit) v.appendChild(el('small', null, unit));
    s.appendChild(v);
    // the third line is always there (empty if there is nothing to say), so every tile has the
    // same height and the Cardano and Midnight grids line up
    if (delta != null && !isNaN(delta)) {
      const d = el('div', 'delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : ''), `${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} ${fmtPct(Math.abs(delta))} ${hint || ''}`);
      s.appendChild(d);
    } else s.appendChild(el('div', 'hint', hint || ''));
    return s;
  }

  // ── tooltip ───────────────────────────────────────────────
  const tip = $('tip');
  function showTip(x, y, title, rows) {
    clear(tip);
    tip.appendChild(el('div', 't', title));
    for (const r of rows) {
      const row = el('div', 'r');
      const name = el('span');
      const key = el('i'); key.style.background = r.color || 'transparent'; if (!r.color) key.style.visibility = 'hidden';
      name.appendChild(key); name.appendChild(document.createTextNode(r.name));
      row.appendChild(el('b', null, r.value)); row.appendChild(name);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tip.style.left = `${Math.max(4, left)}px`; tip.style.top = `${Math.max(4, top)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ── charts ────────────────────────────────────────────────
  function niceTicks(max, n) {
    if (!(max > 0)) return [0, 1];
    const raw = max / (n || 4);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    const ticks = [];
    for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
    if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
    return ticks;
  }
  const specs = new WeakMap();
  function chartCard(card) {
    let plot = card.querySelector('.plot');
    if (!plot) { plot = el('div', 'plot'); card.appendChild(plot); }
    return plot;
  }
  /** spec: { kind: 'line'|'bar'|'hist', x: [iso|label], gran, series: [{ name, color, values: [], dash? }], fmt(v), unit } */
  function draw(card, spec) {
    specs.set(card, spec);
    const plot = chartCard(card);
    clear(plot);
    const hasData = spec.series.some((s) => s.values.some((v) => v != null));
    if (!spec.x.length || !hasData) { emptyState(plot, spec.empty || 'No data for this window yet.'); card.querySelector('.legend')?.remove(); return; }
    const W = Math.max(280, plot.clientWidth || card.clientWidth - 52 || 520);
    const H = spec.kind === 'hist' ? 200 : 220;
    const M = { t: 12, r: spec.kind === 'line' ? 56 : 12, b: 26, l: 44 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
    root.setAttribute('aria-label', [card.dataset.mark && CHAIN_NAME[card.dataset.mark], card.querySelector('h3')?.textContent || 'chart'].filter(Boolean).join(': '));
    const all = spec.series.flatMap((s) => s.values.filter((v) => v != null));
    const maxV = Math.max(0, ...all), minV = Math.min(0, ...all);
    // the axis reaches below 0 only for values that do (a difference, not a count)
    const hi = spec.yMax || maxV;
    const base = niceTicks(hi - minV, 4), step = base[1] - base[0];
    const ticks = [];
    for (let v = Math.floor(minV / step) * step; ; v += step) { ticks.push(+v.toFixed(10)); if (v >= hi - step * 1e-9) break; }
    if (ticks.length < 2) ticks.push(+(ticks[0] + step).toFixed(10));
    const yMin = ticks[0], yMax = ticks[ticks.length - 1];
    const y = (v) => M.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
    const n = spec.x.length;
    const slot = iw / Math.max(1, spec.kind === 'line' ? n - 1 : n);
    const xc = (i) => (spec.kind === 'line' ? (n === 1 ? M.l + iw / 2 : M.l + i * slot) : M.l + i * slot + slot / 2);
    // grid + y labels
    for (const t of ticks) {
      root.appendChild(svg('line', { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis-line' : 'grid-line' }));
      root.appendChild(svg('text', { x: M.l - 6, y: y(t) + 4, 'text-anchor': 'end' })).textContent = spec.fmtAxis ? spec.fmtAxis(t) : fmtNum(t);
    }
    // x labels: about six, never two in the same slot
    const every = Math.max(1, Math.ceil(n / (W < 480 ? 4 : 6)));
    for (let i = 0; i < n; i += every) {
      const t = svg('text', { x: xc(i), y: H - 8, 'text-anchor': i === 0 && spec.kind === 'line' ? 'start' : i === n - 1 && spec.kind === 'line' ? 'end' : 'middle' });
      t.textContent = spec.xLabel ? spec.xLabel(i) : fmtAxisTime(spec.x[i], spec.gran);
      root.appendChild(t);
    }
    const marks = [];
    if (spec.kind === 'line') {
      spec.series.forEach((s, si) => {
        if (spec.series.length === 1 && spec.area !== false) {
          let d = '';
          s.values.forEach((v, i) => { if (v != null) d += (d ? ' L' : 'M') + `${xc(i)} ${y(v)}`; });
          if (d) root.appendChild(svg('path', { d: `${d} L${xc(n - 1)} ${y(0)} L${xc(0)} ${y(0)} Z`, class: 'area' }, { fill: s.color }));
        }
        let d = '', open = false;
        s.values.forEach((v, i) => { if (v == null) { open = false; return; } d += (open ? ' L' : ' M') + `${xc(i)} ${y(v)}`; open = true; });
        root.appendChild(svg('path', { d: d.trim(), class: 'line', ...(s.dash ? { 'stroke-dasharray': '5 4' } : {}) }, { stroke: s.color }));
        let last = -1; for (let i = n - 1; i >= 0; i--) if (s.values[i] != null) { last = i; break; }
        if (last >= 0) {
          root.appendChild(svg('circle', { cx: xc(last), cy: y(s.values[last]), r: 4, class: 'dot' }, { fill: s.color }));
          marks.push({ y: y(s.values[last]), text: (spec.fmt || fmtNum)(s.values[last]), x: xc(last) + 8 });
        }
      });
      // end labels, dropped where they would collide
      marks.sort((a, b) => a.y - b.y);
      let lastY = -99;
      for (const m of marks) { if (m.y - lastY < 12) continue; lastY = m.y; const t = svg('text', { x: m.x, y: m.y + 4, class: 'end' }); t.textContent = m.text; root.appendChild(t); }
    } else {
      const k = spec.series.length;
      const gap = 2, band = Math.min(24 * k + gap * (k - 1), slot * 0.72);
      const bw = (band - gap * (k - 1)) / k;
      for (let i = 0; i < n; i++) {
        const x0 = xc(i) - band / 2;
        spec.series.forEach((s, si) => {
          const v = s.values[i];
          if (v == null) return;
          const h = Math.max(0, y(0) - y(v));
          const r = Math.min(4, bw / 2, h);
          const x = x0 + si * (bw + gap), top = y(v);
          // rounded data-end, square baseline
          const d = h <= 0 ? '' : `M${x} ${y(0)} V${top + r} a${r} ${r} 0 0 1 ${r} -${r} H${x + bw - r} a${r} ${r} 0 0 1 ${r} ${r} V${y(0)} Z`;
          if (d) root.appendChild(svg('path', { d, class: 'bar', 'data-i': i }, { fill: s.color }));
        });
      }
    }
    // crosshair + tooltip: the nearest x wins, every series reads out
    const cross = svg('line', { x1: 0, x2: 0, y1: M.t, y2: M.t + ih, class: 'cross' }, { display: 'none' });
    root.appendChild(cross);
    const hit = svg('rect', { x: M.l - slot / 2, y: 0, width: iw + slot, height: H, class: 'hit-cross' });
    root.appendChild(hit);
    const focusDots = [];
    const at = (ev) => {
      const r = root.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(xc(i) - px); if (d < bd) { bd = d; best = i; } }
      return best;
    };
    hit.addEventListener('pointermove', (ev) => {
      const i = at(ev);
      cross.setAttribute('x1', xc(i)); cross.setAttribute('x2', xc(i)); cross.style.display = '';
      root.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
      root.querySelectorAll(`.bar[data-i="${i}"]`).forEach((b) => b.classList.add('hover'));
      focusDots.forEach((d) => d.remove()); focusDots.length = 0;
      if (spec.kind === 'line') spec.series.forEach((s) => { if (s.values[i] != null) { const d = svg('circle', { cx: xc(i), cy: y(s.values[i]), r: 4, class: 'dot' }, { fill: s.color }); root.insertBefore(d, hit); focusDots.push(d); } });
      const title = spec.xTitle ? spec.xTitle(i) : fmtFullTime(spec.x[i], spec.gran);
      showTip(ev.clientX, ev.clientY, title, spec.series.map((s) => ({ name: s.name, color: s.color, value: s.values[i] == null ? '–' : (s.fmt || spec.fmt || fmtNum)(s.values[i]) })));
    });
    hit.addEventListener('pointerleave', () => { cross.style.display = 'none'; hideTip(); focusDots.forEach((d) => d.remove()); focusDots.length = 0; root.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover')); });
    plot.appendChild(root);
    // legend for two or more series (the title names a single one)
    card.querySelector('.legend')?.remove();
    if (spec.series.length > 1) {
      const lg = el('div', 'legend');
      for (const s of spec.series) { const it = el('span'); const key = el('i', spec.kind === 'bar' ? 'rect' : s.dash ? 'dash' : ''); key.style.background = s.color; it.appendChild(key); it.appendChild(document.createTextNode(s.name)); lg.appendChild(it); }
      plot.after(lg);
    }
  }
  // redraw charts whose width changed (the cards are responsive)
  const ro = new ResizeObserver((entries) => { for (const e of entries) { const card = e.target; const s = specs.get(card); if (s) draw(card, s); } });
  document.querySelectorAll('.card.chart').forEach((c) => ro.observe(c));

  function boardTable(container, rows, cols) {
    if (!rows.length) return false;
    const table = el('table', 'compact');
    const thead = el('thead'), tr = el('tr');
    tr.appendChild(el('th', null, '#'));
    for (const c of cols) tr.appendChild(el('th', c.num ? 'num' : '', c.head));
    thead.appendChild(tr); table.appendChild(thead);
    const tbody = el('tbody');
    const top = Math.max(...rows.map((r) => Number(cols.find((c) => c.bar) ? r[cols.find((c) => c.bar).key] : 0) || 0));
    for (const r of rows) {
      const row = el('tr');
      row.appendChild(el('td', 'rank', String(r.rank)));
      for (const c of cols) {
        const td = el('td', c.num ? 'num' : c.id ? 'id' : '', c.fmt ? c.fmt(r[c.key], r) : String(r[c.key] ?? '–'));
        if (c.id) td.title = String(r[c.key] ?? '');
        if (c.bar && top > 0) { const b = el('span', 'inbar'); b.style.width = `${Math.max(2, (Number(r[c.key]) / top) * 100)}%`; td.appendChild(b); }
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    clear(container).appendChild(table);
    return true;
  }

  window.AstraCharts = { fmtNum, fmtInt, fmtPct, pad, utc, MON, fmtAxisTime, fmtFullTime, fmtWhen, ago, short, el, svg, clear, emptyState, errorState, stat, showTip, hideTip, niceTicks, chartCard, draw, boardTable, ro };
})();
