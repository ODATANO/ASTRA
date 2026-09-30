/* Browser side of the ODATANO ASTRA dashboard: reads /odata/v4/astra, draws the
   charts as inline SVG (no framework, no chart library). One instance = one network; the
   filter row's window scopes every chart and ranking below it. */
(function () {
  'use strict';
  const CFG = window.ASTRA_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const API = (params.get('api') || CFG.api || '/odata/v4/astra').replace(/\/+$/, '');
  const CHAINS = ['cardano', 'midnight'];
  const CHAIN_NAME = { cardano: 'Cardano', midnight: 'Midnight' };
  const COLOR = { cardano: 'var(--series-cardano)', midnight: 'var(--series-midnight)', mute: 'var(--series-mute)' };
  const SLOT = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';

  // ── state ─────────────────────────────────────────────────
  // `gen` counts window changes; an answer requested under an older one is dropped, never drawn.
  const state = { window: '7d', network: null, overview: {}, cache: new Map(), timer: null, loading: false, gen: 0 };
  try { const w = localStorage.getItem('astra.window'); if (['24h', '7d', '30d'].includes(w)) state.window = w; } catch { /* private mode */ }

  // ── fetch ─────────────────────────────────────────────────
  const url = (path) => API + path;
  function api(path) {
    const gen = state.gen;
    const never = new Promise(() => {});
    return cached(path).then((v) => (gen === state.gen ? v : never), (e) => (gen === state.gen ? Promise.reject(e) : never));
  }
  async function cached(path) {
    const key = path;
    if (state.cache.has(key)) return state.cache.get(key);
    const p = fetch(url(path), { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error((data.error && data.error.message) || `${res.status}`), { status: res.status });
      return data;
    });
    state.cache.set(key, p);
    p.catch(() => state.cache.delete(key));
    return p;
  }
  const enc = encodeURIComponent;
  const filter = (entity, expr, extra) => `/${entity}?$filter=${enc(expr)}${extra || ''}`;
  const series = (chain, metric, window) => api(`/getSeries(chain='${chain}',metric='${metric}',window='${window}')`);

  // ── formatting ────────────────────────────────────────────
  const isMainnet = () => state.network === 'mainnet';
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
  // Money comes in atoms: lovelace (1e6 per ADA) and specks (1e15 per DUST). A scale is the
  // divisor and label to show a value in; for DUST it steps down (mDUST, µDUST, ...) until the
  // reference value is at least 1, because a fee of 1e8 specks is 0.0000001 DUST.
  const DUST_SCALES = [[1e15, 'DUST'], [1e12, 'mDUST'], [1e9, 'µDUST'], [1e6, 'nDUST'], [1e3, 'pDUST'], [1, 'specks']];
  function moneyScale(unit, ref) {
    if (unit === 'lovelace') return { div: 1e6, label: isMainnet() ? 'ADA' : 'tADA', digits: 2 };
    if (unit === 'ADA') return { div: 1, label: isMainnet() ? 'ADA' : 'tADA', digits: 0 };
    if (unit === 'specks' || unit === 'DUST') {
      const r = Math.abs(Number(ref) || 0);
      const [div, label] = DUST_SCALES.find(([d]) => r / d >= 1) || DUST_SCALES[DUST_SCALES.length - 1];
      return { div, label, digits: 2 };
    }
    return { div: 1, label: unit || '', digits: 0 };
  }
  const feeValue = (v, unit, scale) => (v == null ? null : Number(v) / (scale || moneyScale(unit, v)).div);
  const feeUnit = (unit, scale) => (scale || moneyScale(unit, 0)).label;
  const fmtFee = (v, unit, scale) => { if (v == null) return '–'; const s = scale || moneyScale(unit, v); return `${fmtNum(Number(v) / s.div, s.digits)} ${s.label}`; };
  const pad = (n) => String(n).padStart(2, '0');
  const utc = (iso) => { const d = new Date(iso); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtAxisTime = (iso, gran) => { const t = utc(iso); return gran === 'day' ? `${t.d} ${MON[t.m]}` : `${pad(t.h)}:${pad(t.mi)}`; };
  const fmtFullTime = (iso, gran) => { const t = utc(iso); return gran === 'day' ? `${t.y}-${pad(t.m + 1)}-${pad(t.d)}` : `${t.y}-${pad(t.m + 1)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)} UTC`; };
  const fmtWhen = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '–');
  const ago = (iso) => { if (!iso) return '–'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 90) return `${Math.round(s)} s ago`; if (s < 5400) return `${Math.round(s / 60)} min ago`; if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`; return `${Math.round(s / 86400)} d ago`; };
  const short = (v, head, tail) => (v && v.length > (head || 12) + (tail || 6) + 1 ? `${v.slice(0, head || 12)}…${v.slice(-(tail || 6))}` : v || '');
  const granOf = (w) => (w === '1h' ? 'minute' : w === '24h' ? 'hour' : 'day');
  const perOf = (w) => (w === '1h' ? 'per minute' : w === '24h' ? 'per hour' : 'per day');

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
  /** Histogram: one bar per log-scale fee band, hover reads the band. */
  function drawHist(card, dist, unit) {
    const bins = (dist && dist.bins) || [];
    // one scale for the whole axis, chosen from the largest band
    const scale = moneyScale(unit, bins.length ? bins[bins.length - 1].hi : 0);
    const fmt = (v) => fmtFee(v, unit, scale);
    draw(card, {
      kind: 'bar', gran: 'band', x: bins.map((b) => b.lo), unit: 'tx',
      series: [{ name: 'transactions', color: card.dataset.chart.endsWith('Midnight') ? COLOR.midnight : COLOR.cardano, values: bins.map((b) => Number(b.count)) }],
      xLabel: (i) => fmtNum(feeValue(bins[i].lo, unit, scale), 2),
      xTitle: (i) => `${fmt(bins[i].lo)} to ${fmt(bins[i].hi)} · ${fmtPct(bins[i].share * 100)} of ${fmtInt(dist.count)}`,
      empty: 'No fees in this window yet.',
    });
  }
  // redraw charts whose width changed (the cards are responsive)
  const ro = new ResizeObserver((entries) => { for (const e of entries) { const card = e.target; const s = specs.get(card); if (s) draw(card, s); } });
  document.querySelectorAll('.card.chart').forEach((c) => ro.observe(c));

  // ── network switch, badge, hero ───────────────────────────
  function renderNetwork(overview) {
    const nets = [...new Set(overview.map((o) => o.network).filter(Boolean))];
    state.network = nets[0] || null;
    const badge = $('netBadge');
    badge.textContent = nets.length ? nets.join(' / ') : 'no source';
    badge.classList.toggle('off', !nets.length);
    badge.classList.toggle('warn', overview.some((o) => o.backfilling));
    $('factNetwork').textContent = state.network ? `${state.network} network` : 'no network yet';
    renderSwitch(CFG.networks || []);
    // The server probes the sister instances (one ASTRA per network) and says which are up;
    // a network that is not reachable stays a label, not a dead link. Falls back to the static list.
    fetch(new URL('/api/networks', new URL(API, location.href)).href, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rep) => { if (rep && Array.isArray(rep.networks)) renderSwitch(rep.networks.map((n) => ({ id: n.id, url: n.up ? n.url : '' }))); })
      .catch(() => {});
  }
  function renderSwitch(networks) {
    const sw = $('netSwitch');
    clear(sw);
    for (const n of networks) {
      if (n.id === state.network) sw.appendChild(el('span', 'on', n.id));
      else if (n.url) { const a = el('a', null, n.id); a.href = n.url; sw.appendChild(a); }
      else { const s = el('span', 'soon', n.id); s.appendChild(el('i', null, 'soon')); sw.appendChild(s); }
    }
  }

  // ── Now ───────────────────────────────────────────────────
  async function loadOverview() {
    const cards = { cardano: $('ovCardano'), midnight: $('ovMidnight') };
    Object.values(cards).forEach((c) => c.classList.add('loading'));
    try {
      const { value } = await api('/ChainOverview');
      renderNetwork(value);
      for (const chain of CHAINS) {
        const o = value.find((r) => r.chain === chain);
        const card = cards[chain];
        const stats = card.querySelector('[data-stats]');
        const pill = card.querySelector('[data-sync]');
        clear(stats);
        state.overview[chain] = o || null;
        if (!o) { pill.textContent = 'no source'; pill.className = 'pill pill--off'; emptyState(stats, 'This instance has no source for this chain.'); $('fact' + CHAIN_NAME[chain]).textContent = `${CHAIN_NAME[chain]} not connected`; continue; }
        const lag = Number(o.lagBlocks || 0), slag = Number(o.sourceLagBlocks || 0);
        if (o.backfilling) { pill.textContent = 'backfilling'; pill.className = 'pill pill--warn'; }
        else if (o.sourceSyncStatus === 'synced' && lag + slag < 20) { pill.textContent = 'live'; pill.className = 'pill pill--ok'; }
        else { pill.textContent = o.sourceSyncStatus || 'unknown'; pill.className = 'pill pill--warn'; }
        // Tiles carry the number only; a delta shows as arrow + percent, no prose.
        // The windows are anchored to the wall clock: when the numbers stop before a window
        // starts, its tile shows a dash instead of 0 and -100%, and a delta against an empty
        // previous window is dropped (that is missing data, not a quiet chain).
        const staleMin = o.lastBlockAt ? (Date.now() - new Date(o.lastBlockAt).getTime()) / 60000 : Infinity;
        const fresh1h = staleMin < 60, fresh24h = staleMin < 1440;
        const delta = (fresh, prev, pct) => (fresh && Number(prev) > 0 ? pct : null);
        // Midnight fees are filled in after the block; the server sends null until they reach the last hour
        const feesShown = fresh24h && o.fees24h != null;
        const feesHint = feesShown || !o.feesThroughAt ? null : (() => { const t = utc(o.feesThroughAt); return `to ${t.d} ${MON[t.m]}`; })();
        // each fee tile picks its own scale (the day's total may be in DUST while one fee is in µDUST)
        const money = (v, digits) => { const s = moneyScale(o.feeUnit, v); return [fmtNum(Number(v) / s.div, digits == null ? s.digits : digits), s.label]; };
        const [fees24h, fees24hUnit] = money(o.fees24h, o.feeUnit === 'lovelace' ? 0 : null);
        const [medianFee, medianFeeUnit] = money(o.medianFee24h, o.feeUnit === 'lovelace' ? 3 : null);
        const [p95Fee, p95FeeUnit] = money(o.p95Fee24h, o.feeUnit === 'lovelace' ? 3 : null);
        stats.appendChild(stat('Tip', fmtInt(o.sourceTipHeight)));
        stats.appendChild(stat('Blocks, 1 h', fresh1h ? fmtInt(o.blocks1h) : '–', null, null, delta(fresh1h, o.blocks1hPrev, o.blocks1hChangePct)));
        stats.appendChild(stat('Block time', fresh1h ? fmtNum(o.avgBlockTime1h, 1) : '–', fresh1h ? 's' : null));
        stats.appendChild(stat('Tx, 1 h', fresh1h ? fmtInt(o.tx1h) : '–', null, null, delta(fresh1h, o.tx1hPrev, o.tx1hChangePct)));
        stats.appendChild(stat('Tx, 24 h', fresh24h ? fmtInt(o.tx24h) : '–'));
        stats.appendChild(stat('Tx / block', fresh24h ? fmtNum(o.avgTxPerBlock24h, 1) : '–'));
        stats.appendChild(stat('Fees, 24 h', feesShown ? fees24h : '–', feesShown ? fees24hUnit : null, feesHint, delta(feesShown, o.fees24hPrev, o.fees24hChangePct)));
        stats.appendChild(stat('Median fee', feesShown ? medianFee : '–', feesShown ? medianFeeUnit : null, feesHint));
        stats.appendChild(stat('P95 fee', feesShown ? p95Fee : '–', feesShown ? p95FeeUnit : null, feesHint));
        $('fact' + CHAIN_NAME[chain]).textContent = `${CHAIN_NAME[chain]} at ${fmtInt(o.sourceTipHeight)}`;
        $('fact' + CHAIN_NAME[chain]).className = chain;
      }
      applyChains();
    } catch (err) {
      Object.values(cards).forEach((c) => errorState(c.querySelector('[data-stats]'), err));
      $('netBadge').textContent = 'offline'; $('netBadge').classList.add('off');
    } finally { Object.values(cards).forEach((c) => c.classList.remove('loading')); }
  }

  // Sections and cards of one chain (data-chain) disappear when the instance has no source for it.
  const has = (chain) => !!state.overview[chain];
  function applyChains() {
    document.querySelectorAll('[data-chain]').forEach((e) => { e.hidden = !has(e.dataset.chain); });
    document.querySelectorAll('[data-nav]').forEach((a) => { a.hidden = !!$(a.dataset.nav)?.hidden; });
  }
  const setSubs = (root, W) => root.querySelectorAll('[data-sub]').forEach((e) => { e.textContent = perOf(W); });

  // ── Heartbeat ─────────────────────────────────────────────
  async function loadHeartbeat() {
    for (const chain of CHAINS) {
      const card = document.querySelector(`[data-chart="hb${CHAIN_NAME[chain]}"]`);
      card.classList.add('loading');
      try {
        const s = await series(chain, 'blocks.count', '1h');
        // minutes between the first and the last bucket without a block are real zeros
        const pts = s.points || [];
        const x = [], values = [];
        if (pts.length) {
          const byMin = new Map(pts.map((p) => [new Date(p.bucketStart).getTime(), Number(p.sum)]));
          const first = new Date(pts[0].bucketStart).getTime(), last = new Date(pts[pts.length - 1].bucketStart).getTime();
          for (let t = first; t <= last; t += 60000) { x.push(new Date(t).toISOString()); values.push(byMin.get(t) || 0); }
        }
        draw(card, { kind: 'bar', gran: 'minute', x, unit: 'blocks', series: [{ name: 'blocks', color: COLOR[chain], values }], fmt: fmtInt, empty: 'No blocks in the last hour, or the numbers do not reach it yet.' });
      } catch (err) { errorState(chartCard(card), err); }
      finally { card.classList.remove('loading'); }
    }
  }

  // ── Activity ──────────────────────────────────────────────
  const pts = (s) => (s && s.points) || [];
  function alignOn(x, points, pick) {
    const m = new Map(points.map((p) => [p.bucketStart, p]));
    return x.map((k) => (m.has(k) ? pick(m.get(k)) : null));
  }
  const unionX = (...lists) => [...new Set(lists.flat().map((p) => p.bucketStart))].sort();
  /**
   * Sums of event metrics on the axis of a dense base series (blocks.count, tx.decoded): a
   * bucket the base covers but a metric lacks is a real 0, one the base lacks stays out.
   * parts: [[metric, name, color?]]; opts: { kind, unit, fmt, fmtAxis, empty }
   */
  async function sumChart(card, chain, base, parts, opts) {
    const W = state.window;
    const [b, ...s] = await Promise.all([series(chain, base, W).catch(() => null), ...parts.map(([m]) => series(chain, m, W).catch(() => null))]);
    const x = unionX(pts(b), ...s.map(pts));
    draw(card, {
      kind: opts.kind || 'line', gran: granOf(W), x, unit: opts.unit, fmt: opts.fmt || fmtInt, fmtAxis: opts.fmtAxis, area: parts.length === 1 ? undefined : false, empty: opts.empty,
      series: parts.map(([, name, color], i) => ({
        name, color: color || (parts.length === 1 ? COLOR[chain] : SLOT[i]),
        values: s[i] ? alignOn(x, pts(s[i]), (p) => Number(p.sum)).map((v) => (v == null ? 0 : v)) : x.map(() => null),
      })),
    });
  }
  const ACTIVITY = ['tx', 'feesCardano', 'feesMidnight', 'distCardano', 'distMidnight', 'mixCardano', 'mixMidnight', 'empty', 'txPerBlock', 'interval',
    'feeErrMidnight', 'supply', 'volume', 'tokenTransfers', 'utxoFlow', 'blockSize', 'contractTx', 'txSize'];
  /** median and p95 of a size distribution, bytes */
  async function sizeChart(card, chain, metric) {
    const W = state.window;
    const s = await series(chain, metric, W);
    const x = pts(s).map((p) => p.bucketStart);
    draw(card, { kind: 'line', gran: granOf(W), x, unit: 'bytes', fmt: (v) => `${fmtInt(Math.round(v))} B`, area: false, series: [
      { name: 'median', color: COLOR[chain], values: pts(s).map((p) => (p.p50 == null ? null : Number(p.p50))) },
      { name: 'p95', color: COLOR.mute, values: pts(s).map((p) => (p.p95 == null ? null : Number(p.p95))) },
    ], empty: 'No data in this window yet.' });
  }
  async function loadActivity() {
    const W = state.window, gran = granOf(W);
    setSubs(document.querySelector('main'), W);
    const cards = ACTIVITY.map((n) => document.querySelector(`[data-chart="${n}"]`)).filter(Boolean);
    cards.forEach((c) => c.classList.add('loading'));
    const jobs = [];
    // transactions, both chains on one axis
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="tx"]');
      try {
        const [c, m] = await Promise.all(CHAINS.map((ch) => series(ch, 'tx.count', W).catch(() => null)));
        const x = unionX(pts(c), pts(m));
        draw(card, { kind: 'bar', gran, x, unit: 'tx', fmt: fmtInt, series: [
          { name: 'Cardano', color: COLOR.cardano, values: alignOn(x, pts(c), (p) => Number(p.sum)) },
          { name: 'Midnight', color: COLOR.midnight, values: alignOn(x, pts(m), (p) => Number(p.sum)) },
        ] });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    for (const chain of CHAINS) {
      const N = CHAIN_NAME[chain];
      // fees: median in the chain hue, p95 as context
      jobs.push((async () => {
        const card = document.querySelector(`[data-chart="fees${N}"]`);
        try {
          const s = await series(chain, 'fees.paid', W);
          const unit = s.unit, x = pts(s).map((p) => p.bucketStart);
          // one scale for axis, labels and tooltip, chosen from the largest p95
          const scale = moneyScale(unit, Math.max(0, ...pts(s).map((p) => Number(p.p95) || 0)));
          const f = (v) => fmtFee(v, unit, scale);
          draw(card, { kind: 'line', gran, x, unit: scale.label, fmt: f, fmtAxis: (v) => fmtNum(feeValue(v, unit, scale), 2), series: [
            { name: 'median', color: COLOR[chain], values: pts(s).map((p) => (p.p50 == null ? null : Number(p.p50))) },
            { name: 'p95', color: COLOR.mute, values: pts(s).map((p) => (p.p95 == null ? null : Number(p.p95))) },
          ] });
        } catch (err) { errorState(chartCard(card), err); }
      })());
      // fee distribution
      jobs.push((async () => {
        const card = document.querySelector(`[data-chart="dist${N}"]`);
        const path = `/getDistribution(chain='${chain}',metric='fees.paid',window='${W}')`;
        try { const d = await api(path); drawHist(card, d, d.unit); }
        catch (err) { errorState(chartCard(card), err); }
      })());
      // transaction mix as shares of all transactions
      jobs.push((async () => {
        const card = document.querySelector(`[data-chart="mix${N}"]`);
        const parts = chain === 'cardano'
          ? [['tx.withAssets', 'with native assets'], ['tx.withMetadata', 'with metadata']]
          : [['tx.contractCalls', 'contract calls'], ['tx.contractDeploys', 'contract deploys'], ['tx.zswap', 'shielded (decoded)'], ['tx.failed', 'failed']];
        try {
          const all = await series(chain, 'tx.count', W);
          const subs = await Promise.all(parts.map(([m]) => series(chain, m, W).catch(() => null)));
          const x = pts(all).map((p) => p.bucketStart);
          const total = new Map(pts(all).map((p) => [p.bucketStart, Number(p.sum)]));
          // an hour with transactions but none of a kind is a real 0 %, not a gap
          const share = (s) => (s ? alignOn(x, pts(s), (p) => Number(p.sum)).map((v, i) => (total.get(x[i]) ? ((v ?? 0) / total.get(x[i])) * 100 : null)) : x.map(() => null));
          draw(card, { kind: 'line', gran, x, unit: '%', fmt: (v) => fmtPct(v), fmtAxis: (v) => `${fmtNum(v)}%`, series: parts.map(([, name], i) => ({ name, color: SLOT[i], values: share(subs[i]) })), area: false });
        } catch (err) { errorState(chartCard(card), err); }
      })());
    }
    // empty blocks share and transactions per block, both chains
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="empty"]');
      try {
        const r = await Promise.all(CHAINS.map((ch) => Promise.all([series(ch, 'blocks.count', W), series(ch, 'blocks.empty', W)]).catch(() => null)));
        const x = unionX(...r.map((p) => (p ? pts(p[0]) : [])));
        const shares = r.map((p) => { if (!p) return x.map(() => null); const tot = new Map(pts(p[0]).map((q) => [q.bucketStart, Number(q.sum)])); return alignOn(x, pts(p[1]), (q) => Number(q.sum)).map((v, i) => (tot.get(x[i]) ? ((v ?? 0) / tot.get(x[i])) * 100 : null)); });
        draw(card, { kind: 'line', gran, x, unit: '%', fmt: (v) => fmtPct(v), fmtAxis: (v) => `${fmtNum(v)}%`, area: false, series: CHAINS.map((ch, i) => ({ name: CHAIN_NAME[ch], color: COLOR[ch], values: shares[i] })) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="txPerBlock"]');
      try {
        const r = await Promise.all(CHAINS.map((ch) => series(ch, 'blocks.txCount', W).catch(() => null)));
        const x = unionX(...r.map((s) => pts(s)));
        draw(card, { kind: 'line', gran, x, unit: 'tx', fmt: (v) => fmtNum(v, 2), area: false, series: CHAINS.map((ch, i) => ({ name: CHAIN_NAME[ch], color: COLOR[ch], values: alignOn(x, pts(r[i]), (p) => (p.avg == null ? null : Number(p.avg))) })) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    // block interval: median solid, p95 dashed, per chain
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="interval"]');
      try {
        const r = await Promise.all(CHAINS.map((ch) => (has(ch) ? series(ch, 'blocks.interval', W).catch(() => null) : null)));
        const x = unionX(...r.map((s) => pts(s)));
        const pick = (i, k) => alignOn(x, pts(r[i]), (p) => (p[k] == null ? null : Number(p[k])));
        draw(card, { kind: 'line', gran, x, unit: 's', fmt: (v) => `${fmtNum(v, 1)} s`, area: false, series: CHAINS.flatMap((ch, i) => (r[i] ? [
          { name: `${CHAIN_NAME[ch]} median`, color: COLOR[ch], values: pick(i, 'p50') },
          { name: `${CHAIN_NAME[ch]} p95`, color: COLOR[ch], dash: true, values: pick(i, 'p95') },
        ] : [])) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    if (has('midnight')) jobs.push((async () => {
      const card = document.querySelector('[data-chart="feeErrMidnight"]');
      try {
        const s = await series('midnight', 'fees.estimateError', W);
        const unit = s.unit, x = pts(s).map((p) => p.bucketStart);
        const scale = moneyScale(unit, Math.max(0, ...pts(s).map((p) => Math.abs(Number(p.p95) || 0))));
        draw(card, { kind: 'line', gran, x, unit: scale.label, fmt: (v) => fmtFee(v, unit, scale), fmtAxis: (v) => fmtNum(feeValue(v, unit, scale), 2), series: [
          { name: 'median', color: COLOR.midnight, values: pts(s).map((p) => (p.p50 == null ? null : Number(p.p50))) },
          { name: 'p95', color: COLOR.mute, values: pts(s).map((p) => (p.p95 == null ? null : Number(p.p95))) },
        ], empty: 'No fees in this window yet.' });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    const job = (name, fn) => jobs.push((async () => { const card = document.querySelector(`[data-chart="${name}"]`); if (!card) return; try { await fn(card); } catch (err) { errorState(chartCard(card), err); } })());
    if (has('cardano')) {
      job('tokenTransfers', (card) => sumChart(card, 'cardano', 'blocks.count', [['tokens.transfers', 'transfers']], { kind: 'bar', unit: 'moves', empty: 'No token transfers in this window yet.' }));
      job('utxoFlow', (card) => sumChart(card, 'cardano', 'blocks.count', [['utxo.created', 'created'], ['utxo.spent', 'spent']], { unit: 'utxo' }));
      job('blockSize', (card) => sizeChart(card, 'cardano', 'blocks.size'));
    }
    if (has('midnight')) {
      job('contractTx', (card) => sumChart(card, 'midnight', 'blocks.count', [['tx.contractCalls', 'calls'], ['tx.contractDeploys', 'deploys']], { unit: 'tx', empty: 'No contract transactions in this window yet.' }));
      job('txSize', (card) => sizeChart(card, 'midnight', 'tx.size'));
    }
    if (has('cardano')) {
      jobs.push((async () => {
        const card = document.querySelector('[data-chart="supply"]');
        try { await sumChart(card, 'cardano', 'blocks.count', [['tokens.mints', 'mints'], ['tokens.burns', 'burns']], { unit: 'tx', empty: 'No mints or burns in this window yet.' }); }
        catch (err) { errorState(chartCard(card), err); }
      })());
      jobs.push((async () => {
        const card = document.querySelector('[data-chart="volume"]');
        const ada = moneyScale('ADA', 0);
        try { await sumChart(card, 'cardano', 'blocks.count', [['value.transferred', 'transferred']], { kind: 'bar', unit: ada.label, fmt: (v) => `${fmtNum(v, 0)} ${ada.label}` }); }
        catch (err) { errorState(chartCard(card), err); }
      })());
    }
    await Promise.allSettled(jobs);
    cards.forEach((c) => c.classList.remove('loading'));
  }

  // ── Key figures (window vs. previous window) ──────────
  const KEY_FIGURES = {
    cardano: [['tx.count', 'Transactions'], ['blocks.count', 'Blocks'], ['fees.paid', 'Avg fee'], ['tokens.transfers', 'Token transfers'], ['utxo.created', 'UTxOs created'], ['withdrawals.count', 'Withdrawals']],
    midnight: [['tx.count', 'Transactions'], ['blocks.count', 'Blocks'], ['fees.paid', 'Avg fee'], ['tx.contractCalls', 'Contract calls'], ['tx.contractDeploys', 'Contract deploys'], ['tx.zswap', 'Shielded (decoded)']],
  };
  async function loadKeyFigures() {
    const W = state.window;
    const cards = [...document.querySelectorAll('[data-kf]')];
    cards.forEach((c) => c.classList.add('loading'));
    const metrics = [...new Set(Object.values(KEY_FIGURES).flat().map(([m]) => m))];
    try {
      const { value } = await api(filter('KeyFigures', `window eq '${W}' and (${metrics.map((m) => `metric eq '${m}'`).join(' or ')})`));
      for (const card of cards) {
        const chain = card.dataset.kf, box = card.querySelector('[data-kfstats]');
        clear(box);
        for (const [metric, label] of KEY_FIGURES[chain] || []) {
          const r = value.find((v) => v.chain === chain && v.metric === metric);
          if (!r) continue;
          const money = r.kind === 'distribution' && r.value != null;
          const shown = r.value == null ? '–' : money ? fmtFee(r.value, r.unit) : fmtInt(r.value);
          box.appendChild(stat(label, shown, null, null, r.previous != null && Number(r.previous) > 0 && r.changePct != null ? Number(r.changePct) : null));
        }
        if (!box.childNodes.length) emptyState(box, 'No figures for this window yet.');
      }
    } catch (err) { cards.forEach((c) => errorState(c.querySelector('[data-kfstats]'), err)); }
    finally { cards.forEach((c) => c.classList.remove('loading')); }
  }

  // ── Ledger (Midnight, decoded from the ledger payload) ───
  async function loadLedger() {
    if (!has('midnight')) return;
    const W = state.window, root = $('ledger');
    setSubs(root, W);
    const cards = [...root.querySelectorAll('.card')];
    cards.forEach((c) => c.classList.add('loading'));
    const chart = (name, fn) => (async () => { const card = root.querySelector(`[data-chart="${name}"]`); try { await fn(card); } catch (err) { errorState(chartCard(card), err); } })();
    const decoded = 'tx.decoded';
    const jobs = [
      (async () => {
        // how far the decoding reaches, shown only while it trails the blocks
        const box = $('decodeStatus');
        try {
          const { value } = await api(filter('SyncStatus', `chain eq 'midnight'`));
          const c = value[0] || {};
          const lag = c.lastHeight == null ? 0 : Number(c.lastHeight) - Number(c.decodeHeight ?? 0);
          clear(box);
          box.hidden = !(c.decodeHeight == null || lag > 100);
          if (!box.hidden) {
            const at = c.decodeBlockTime ? new Date(Number(c.decodeBlockTime) * 1000).toISOString() : null;
            box.appendChild(stat('Decoded through', c.decodeHeight == null ? '–' : fmtInt(c.decodeHeight), null, at ? fmtWhen(at) : null));
            box.appendChild(stat('Blocks behind', fmtInt(lag)));
          }
        } catch { box.hidden = true; }
      })(),
      // stored in DUST, not specks (specks squared overflow the sumSq column)
      chart('dust', (card) => sumChart(card, 'midnight', decoded, [['dust.consumed', 'consumed']], { kind: 'bar', unit: 'DUST', fmt: (v) => `${fmtNum(v, 2)} DUST`, empty: 'No decoded DUST spends in this window yet.' })),
      chart('dustEvents', (card) => sumChart(card, 'midnight', decoded, [['dust.spends', 'spends'], ['dust.registrations', 'registrations']], { unit: 'events', empty: 'No decoded DUST events in this window yet.' })),
      chart('zswap', (card) => sumChart(card, 'midnight', decoded, [['zswap.inputs', 'inputs'], ['zswap.outputs', 'outputs'], ['zswap.transients', 'transients']], { unit: 'coins', empty: 'No decoded shielded activity in this window yet.' })),
      chart('zswapShare', async (card) => {
        const [all, z] = await Promise.all([series('midnight', decoded, W), series('midnight', 'tx.zswap', W).catch(() => null)]);
        const x = pts(all).map((p) => p.bucketStart);
        const zs = new Map(pts(z).map((p) => [p.bucketStart, Number(p.sum)]));
        draw(card, { kind: 'line', gran: granOf(W), x, unit: '%', fmt: (v) => fmtPct(v), fmtAxis: (v) => `${fmtNum(v)}%`, series: [
          { name: 'shielded', color: COLOR.midnight, values: pts(all).map((p) => (Number(p.sum) ? ((zs.get(p.bucketStart) || 0) / Number(p.sum)) * 100 : null)) },
        ], empty: 'No decoded transactions in this window yet.' });
      }),
    ];
    const boards = [
      ['contracts', 'TopContracts', [{ head: 'Contract', key: 'entityId', id: true, fmt: (v) => short(v, 14, 10) }, { head: 'Calls', key: 'count', num: true, fmt: fmtInt, bar: true }], 'No decoded contract calls in this window yet.'],
      ['circuits', 'TopCircuits', [{ head: 'Circuit', key: 'entityId', id: true, fmt: (v) => short(v, 24, 8) }, { head: 'Calls', key: 'count', num: true, fmt: fmtInt, bar: true }], 'No decoded contract calls in this window yet.'],
    ];
    for (const [name, entity, cols, empty] of boards) {
      jobs.push((async () => {
        const tbl = root.querySelector(`[data-board="${name}"] [data-table]`);
        try { const { value } = await api(filter(entity, `chain eq 'midnight' and window eq '${W}' and rank le 10`)); if (!boardTable(tbl, value, cols)) emptyState(tbl, empty); }
        catch (err) { errorState(tbl, err); }
      })());
    }
    await Promise.allSettled(jobs);
    cards.forEach((c) => c.classList.remove('loading'));
  }

  // ── Stake & Governance (Cardano) ─────────────────────────
  async function loadStake() {
    if (!has('cardano')) return;
    const W = state.window, root = $('stake');
    setSubs(root, W);
    const cards = [...root.querySelectorAll('.card')];
    cards.forEach((c) => c.classList.add('loading'));
    const ada = moneyScale('ADA', 0);
    const fmtAda = (v) => `${fmtNum(Number(v), 0)} ${ada.label}`;
    const chart = (name, fn) => (async () => { const card = root.querySelector(`[data-chart="${name}"]`); try { await fn(card); } catch (err) { errorState(chartCard(card), err); } })();
    const epochs = api(`/StakeEpochs?$filter=${enc("chain eq 'cardano'")}&$orderby=${enc('epoch desc')}&$top=2`).then((r) => r.value || []);
    const jobs = [
      (async () => {
        const box = $('stakeStats');
        try {
          const [cur, prev] = await epochs;
          clear(box);
          if (!cur) { emptyState(box, 'No epoch snapshot yet.'); return; }
          const ch = (k) => (prev && Number(prev[k]) > 0 ? ((Number(cur[k]) - Number(prev[k])) / Number(prev[k])) * 100 : null);
          box.appendChild(stat('Epoch', fmtInt(cur.epoch), null, fmtWhen(cur.takenAt)));
          box.appendChild(stat('Pools', fmtInt(cur.pools), null, null, ch('pools')));
          box.appendChild(stat('Live stake', fmtNum(Number(cur.totalLiveStakeAda)), ada.label, null, ch('totalLiveStakeAda')));
          box.appendChild(stat('Active DReps', fmtInt(cur.activeDreps), null, null, ch('activeDreps')));
          box.appendChild(stat('Voting power', fmtNum(Number(cur.totalVotingPowerAda)), ada.label, null, ch('totalVotingPowerAda')));
          root.querySelectorAll('[data-epoch]').forEach((e) => { e.textContent = `epoch ${fmtInt(cur.epoch)}`; });
        } catch (err) { errorState(box, err); }
      })(),
      chart('delegations', (card) => sumChart(card, 'cardano', 'blocks.count', [
        ['certs.poolDelegations', 'pool delegations'], ['certs.voteDelegations', 'vote delegations'],
        ['certs.stakeRegistrations', 'stake registrations'], ['certs.stakeDeregistrations', 'stake deregistrations'],
      ], { unit: 'certs', empty: 'No certificates in this window yet.' })),
      chart('lifecycle', (card) => sumChart(card, 'cardano', 'blocks.count', [
        ['certs.poolRegistrations', 'pool registrations'], ['certs.poolRetirements', 'pool retirements'],
        ['certs.drepRegistrations', 'DRep registrations'], ['certs.drepRetirements', 'DRep retirements'],
      ], { unit: 'certs', empty: 'No certificates in this window yet.' })),
      chart('withdrawn', (card) => sumChart(card, 'cardano', 'blocks.count', [['withdrawals.value', 'withdrawn']], { kind: 'bar', unit: ada.label, fmt: fmtAda, empty: 'No withdrawals in this window yet.' })),
      chart('withdrawals', (card) => sumChart(card, 'cardano', 'blocks.count', [['withdrawals.count', 'withdrawals'], ['withdrawals.zero', 'zero ADA']], { unit: 'withdrawals', empty: 'No withdrawals in this window yet.' })),
    ];
    // holdings of the newest epoch; the window switch does not apply
    const holdings = [
      ['pools', 'TopPools', 'pool', 'stake.live', 'Pool', 'Live stake', 'Pools', 'pools for 51 %'],
      ['dreps', 'TopDReps', 'drep', 'governance.votingPower', 'DRep', 'Voting power', 'DReps', 'DReps for 51 %'],
    ];
    for (const [name, entity, dim, metric, head, amount, countLabel, nakHint] of holdings) {
      jobs.push((async () => {
        const card = root.querySelector(`[data-board="${name}"]`);
        const tbl = card.querySelector('[data-table]'), conc = card.querySelector('[data-conc]');
        const concPath = `/getConcentration(chain='cardano',dimension='${dim}',metric='${metric}',window='epoch',by='sum',subject='')`;
        try {
          const [list, c] = await Promise.all([api(filter(entity, `chain eq 'cardano' and rank le 10`)), api(concPath).catch(() => null)]);
          clear(conc);
          if (c && Number(c.entities) > 0) {
            conc.appendChild(stat(countLabel, fmtInt(c.entities)));
            conc.appendChild(stat('Top 10 share', fmtPct(Number(c.top10Share) * 100)));
            conc.appendChild(stat('Nakamoto', fmtInt(c.nakamoto), null, nakHint));
            conc.appendChild(stat('Gini', fmtNum(Number(c.gini), 2), null, '0 = even'));
          }
          const total = c ? Number(c.total) : 0;
          if (!boardTable(tbl, list.value, [
            { head, key: 'entityId', id: true, fmt: (v) => short(v, 16, 8) },
            { head: amount, key: 'sum', num: true, fmt: fmtAda, bar: true },
            { head: 'Share', key: 'sum', num: true, fmt: (v) => (total ? fmtPct((Number(v) / total) * 100) : '–') },
          ])) emptyState(tbl, 'No ranking for the latest epoch yet.');
        } catch (err) { errorState(tbl, err); }
      })());
    }
    const flows = [
      ['delegatedPools', 'TopDelegatedPools', 'Pool'],
      ['votedDReps', 'TopVotedDReps', 'DRep'],
    ];
    for (const [name, entity, head] of flows) {
      jobs.push((async () => {
        const tbl = root.querySelector(`[data-board="${name}"] [data-table]`);
        try {
          const { value } = await api(filter(entity, `chain eq 'cardano' and window eq '${W}' and rank le 10`));
          if (!boardTable(tbl, value, [{ head, key: 'entityId', id: true, fmt: (v) => short(v, 16, 8) }, { head: 'Delegations', key: 'count', num: true, fmt: fmtInt, bar: true }])) emptyState(tbl, 'No delegations in this window yet.');
        } catch (err) { errorState(tbl, err); }
      })());
    }
    await Promise.allSettled(jobs);
    cards.forEach((c) => c.classList.remove('loading'));
  }

  // ── Rankings ──────────────────────────────────────────────

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
  async function loadRankings() {
    const W = state.window;
    const boards = [...document.querySelectorAll('[data-board]')];
    boards.forEach((b) => b.classList.add('loading'));
    const jobs = [];
    for (const chain of CHAINS) {
      jobs.push((async () => {
        const card = document.querySelector(`[data-board="producers${CHAIN_NAME[chain]}"]`);
        const tbl = card.querySelector('[data-table]'), conc = card.querySelector('[data-conc]');
        const listPath = filter('TopBlockProducers', `chain eq '${chain}' and window eq '${W}' and rank le 10`);
        const concPath = `/getConcentration(chain='${chain}',dimension='producer',metric='blocks.produced',window='${W}',by='count',subject='')`;
        try {
          const [list, c] = await Promise.all([api(listPath), api(concPath).catch(() => null)]);
          clear(conc);
          if (c && Number(c.entities) > 0) {
            conc.appendChild(stat('Producers', fmtInt(c.entities), null, `${fmtInt(c.total)} blocks`));
            conc.appendChild(stat('Top 10 share', fmtPct(Number(c.top10Share) * 100), null, 'of blocks'));
            conc.appendChild(stat('Nakamoto', fmtInt(c.nakamoto), null, 'producers for 51 %'));
            conc.appendChild(stat('Gini', fmtNum(Number(c.gini), 2), null, '0 = even'));
          }
          const total = c ? Number(c.total) : 0;
          if (!boardTable(tbl, list.value, [
            { head: chain === 'cardano' ? 'Pool' : 'Author', key: 'entityId', id: true, fmt: (v) => short(v, 16, 8) },
            { head: 'Blocks', key: 'count', num: true, fmt: fmtInt, bar: true },
            { head: 'Share', key: 'count', num: true, fmt: (v) => (total ? fmtPct((Number(v) / total) * 100) : '–') },
          ])) emptyState(tbl, 'No blocks in this window yet.');
        } catch (err) { errorState(tbl, err); }
      })());
    }
    const simple = [
      ['tokens', filter('TopTokens', `chain eq 'cardano' and window eq '${W}' and rank le 10`), [{ head: 'Unit', key: 'entityId', id: true, fmt: (v) => short(v, 14, 10) }, { head: 'Transfers', key: 'count', num: true, fmt: fmtInt, bar: true }], 'No token transfers in this window yet.'],
      ['policies', filter('TopPolicies', `chain eq 'cardano' and window eq '${W}' and rank le 10`), [{ head: 'Policy', key: 'entityId', id: true, fmt: (v) => short(v, 14, 10) }, { head: 'Transfers', key: 'count', num: true, fmt: fmtInt, bar: true }], 'No token transfers in this window yet.'],
      ['addresses', filter('TopAddresses', `chain eq 'cardano' and window eq '${W}' and rank le 10`), [{ head: 'Address', key: 'entityId', id: true, fmt: (v) => short(v, 14, 10) }, { head: 'Received', key: 'sum', num: true, fmt: (v, r) => `${fmtNum(Number(v), 0)} ${feeUnit(r.unit)}`, bar: true }, { head: 'Outputs', key: 'count', num: true, fmt: fmtInt }], 'No value received in this window yet.'],
      ['scripts', filter('TopScripts', `chain eq 'cardano' and window eq '${W}' and rank le 10`), [{ head: 'Script address', key: 'entityId', id: true, fmt: (v) => short(v, 14, 10) }, { head: 'Received', key: 'sum', num: true, fmt: (v, r) => `${fmtNum(Number(v), 0)} ${feeUnit(r.unit)}`, bar: true }, { head: 'Outputs', key: 'count', num: true, fmt: fmtInt }], 'No value received by a script in this window yet.'],
    ];
    for (const [name, path, cols, empty] of simple) {
      jobs.push((async () => {
        const card = document.querySelector(`[data-board="${name}"]`);
        const tbl = card.querySelector('[data-table]');
        try { const { value } = await api(path); if (!boardTable(tbl, value, cols)) emptyState(tbl, empty); }
        catch (err) { errorState(tbl, err); }
      })());
    }
    await Promise.allSettled(jobs);
    boards.forEach((b) => b.classList.remove('loading'));
  }

  // ── orchestration ─────────────────────────────────────────
  /** quiet: the background refresh swaps the values in without dimming the cards. */
  async function loadAll(quiet = false) {
    if (state.loading) return;
    state.loading = true;
    state.cache.clear();
    $('refresh').disabled = true;
    document.body.classList.toggle('quiet', quiet);
    try {
      await loadOverview();
      await Promise.allSettled([loadHeartbeat(), loadKeyFigures(), loadActivity(), loadLedger(), loadStake(), loadRankings()]);
      $('updated').textContent = `updated ${new Date().toISOString().slice(11, 19)} UTC`;
    } finally { state.loading = false; $('refresh').disabled = false; document.body.classList.remove('quiet'); }
  }
  function setWindow(w) {
    if (w === state.window) return;
    state.window = w;
    state.gen++;
    // a refresh still waiting on the old window's answers will never finish; let the next one run
    state.loading = false; $('refresh').disabled = false; document.body.classList.remove('quiet');
    try { localStorage.setItem('astra.window', w); } catch { /* private mode */ }
    document.querySelectorAll('#windowSeg button').forEach((b) => b.classList.toggle('on', b.dataset.window === w));
    state.cache.clear();
    Promise.allSettled([loadKeyFigures(), loadActivity(), loadLedger(), loadStake(), loadRankings()]);
  }
  document.querySelectorAll('#windowSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.window === state.window); b.addEventListener('click', () => setWindow(b.dataset.window)); });
  $('refresh').addEventListener('click', () => loadAll());
  $('heroBase').textContent = new URL(API, location.href).href;
  // "API" leads to the readable reference on the network's API pages (astra.<net> -> api.<net>,
  // the ASTRA section); $metadata is the fallback for a host without that twin (local work).
  $('apiLink').href = /^astra\./.test(location.hostname) ? `https://api.${location.hostname.slice(6)}/reference#AstraService` : url('/$metadata');
  const schedule = () => { clearInterval(state.timer); state.timer = setInterval(() => { if (!document.hidden) loadAll(true); }, CFG.refreshMs || 60000); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll(true); });

  // ── chrome: theme, burger, pointer glow (same as the API pages) ─
  const themeBtn = $('theme');
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('odatano.theme', next); } catch { /* private mode */ }
  });
  const burger = $('burger');
  const header = burger.closest('header.top');
  const setOpen = (open) => { header.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); };
  burger.addEventListener('click', () => setOpen(!header.classList.contains('open')));
  header.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); hideTip(); } });
  window.addEventListener('resize', () => { if (window.innerWidth > 1100) setOpen(false); });
  document.querySelectorAll('.card').forEach((c) => c.addEventListener('pointermove', (ev) => { const r = c.getBoundingClientRect(); c.style.setProperty('--mx', ev.clientX - r.left + 'px'); c.style.setProperty('--my', ev.clientY - r.top + 'px'); }));

  // ── chain logos on cards and section heads (data-mark), day and night variant ─
  const LOGO = { cardano: ['cardano-horizontal-blue', 'cardano-horizontal-white'], midnight: ['midnight-logo-horizontal-dark', 'midnight-logo-horizontal-white'] };
  document.querySelectorAll('[data-mark]').forEach((host) => {
    const chain = host.dataset.mark;
    const head = host.classList.contains('section-head') ? host : host.querySelector('.chart-head');
    if (!LOGO[chain] || !head) return;
    const mark = el('span', 'chain-mark');
    LOGO[chain].forEach((file, i) => { const img = el('img', i ? 'only-night' : 'only-day'); img.src = `/brand/logos/${file}.svg`; img.alt = CHAIN_NAME[chain]; mark.appendChild(img); });
    if (head === host) head.appendChild(mark); else head.insertBefore(mark, head.firstChild);
  });

  // ── sections fold open and closed; the choice is kept per viewer ─
  const FOLD_KEY = 'astra.folded';
  let folded = [];
  try { folded = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch { folded = []; }
  const setFolded = (section, fold) => {
    section.classList.toggle('folded', fold);
    section.querySelector('.fold')?.setAttribute('aria-expanded', String(!fold));
    folded = fold ? [...new Set([...folded, section.id])] : folded.filter((id) => id !== section.id);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folded)); } catch { /* private mode */ }
  };
  document.querySelectorAll('main > .section[id]').forEach((section) => {
    const h2 = section.querySelector('.section-head h2');
    if (!h2) return;
    const btn = el('button', 'fold');
    btn.type = 'button';
    btn.setAttribute('aria-controls', section.id);
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    // a single-chain section is titled by the chain's logo alone
    const mark = section.querySelector('.section-head > .chain-mark');
    btn.appendChild(mark || document.createTextNode(h2.textContent));
    clear(h2).appendChild(btn);
    // the whole head bar toggles, the button inside keeps it reachable by keyboard
    section.querySelector('.section-head').addEventListener('click', () => setFolded(section, !section.classList.contains('folded')));
    if (folded.includes(section.id)) setFolded(section, true); else btn.setAttribute('aria-expanded', 'true');
  });
  // a menu link opens its section
  document.querySelectorAll('nav a[href^="#"]').forEach((a) => a.addEventListener('click', () => { const s = document.querySelector(a.getAttribute('href')); if (s?.classList.contains('folded')) setFolded(s, false); }));

  loadAll().then(schedule);
})();
