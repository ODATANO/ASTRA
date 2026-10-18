/* Browser side of the ODATANO ASTRA dashboard: reads /odata/v4/analytics, draws the
   charts as inline SVG (no framework, no chart library). One instance = one network; the
   path picks the chain (/cardano, /midnight; / compares both) and the filter row's window
   scopes every chart and ranking below it. */
(function () {
  'use strict';
  const CFG = window.ASTRA_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const API = (params.get('api') || CFG.api || '/odata/v4/analytics').replace(/\/+$/, '');
  const CHAINS = ['cardano', 'midnight'];
  const CHAIN_NAME = { cardano: 'Cardano', midnight: 'Midnight' };
  const COLOR = { cardano: 'var(--series-cardano)', midnight: 'var(--series-midnight)', mute: 'var(--series-mute)' };
  const SLOT = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
  const $ = (id) => document.getElementById(id);
  const { fmtNum, fmtInt, fmtPct, pad, utc, MON, fmtAxisTime, fmtFullTime, fmtWhen, ago, short, el, svg, clear, emptyState, errorState, stat, showTip, hideTip, niceTicks, chartCard, draw, boardTable, ro } = window.AstraCharts;

  // ── state ─────────────────────────────────────────────────
  // `gen` counts window changes; an answer requested under an older one is dropped, never drawn.
  const state = { window: '7d', network: null, overview: {}, loaded: false, cache: new Map(), timer: null, loading: false, gen: 0 };
  try { const w = localStorage.getItem('astra.window'); if (['24h', '7d', '30d'].includes(w)) state.window = w; } catch { /* private mode */ }

  // ── view ──────────────────────────────────────────────────
  const PAGE = CHAINS.find((c) => location.pathname.replace(/\/+$/, '') === `/${c}`) || null;
  const inView = (chain) => !PAGE || PAGE === chain;
  const ACTIVE = CHAINS.filter(inView);
  const pageHref = (chain) => (chain ? `/${chain}` : '/') + location.search;
  const has = (chain) => !!state.overview[chain];
  const shown = (chain) => has(chain) && inView(chain);
  const visible = (e) => !!e && !e.hidden && !e.closest('[hidden]');
  /**
   * What the page shows. data-view: `all` only at /, `chain` only on a chain page, or one
   * chain's name. data-chain, data-kf and marked cards need their chain in view and, once
   * the overview answered, a source for it; data-ov (overview card, hero fact) only the view.
   */
  function applyVisibility() {
    const byView = (v) => (v === 'all' ? !PAGE : v === 'chain' ? !!PAGE : v === PAGE);
    document.querySelectorAll('[data-view], [data-chain], [data-kf], [data-ov], .card[data-mark]').forEach((e) => {
      const d = e.dataset, chain = d.chain || d.kf || d.ov || d.mark;
      const chainOk = !chain || (inView(chain) && (d.ov != null || !state.loaded || has(chain)));
      e.hidden = !((d.view ? byView(d.view) : true) && chainOk);
    });
    document.querySelectorAll('[data-page]').forEach((a) => { a.href = pageHref(a.dataset.page); });
    document.querySelectorAll('[data-nav]').forEach((a) => { a.href = pageHref(a.dataset.nav); a.hidden = state.loaded && !has(a.dataset.nav); a.classList.toggle('on', a.dataset.nav === PAGE); });
    // a grid keeps its two columns only while two cards show; an emptied grid leaves no gap
    document.querySelectorAll('.grid').forEach((g) => { const n = [...g.children].filter((c) => !c.hidden).length; g.classList.toggle('one', n === 1); g.hidden = n === 0; });
    document.title = PAGE ? `ODATANO ASTRA · ${CHAIN_NAME[PAGE]}` : 'ODATANO ASTRA';
    renderChainSwitch();
  }
  function renderChainSwitch() {
    const sw = $('chainSwitch');
    clear(sw);
    for (const [id, label] of [[null, 'compare'], ...CHAINS.map((c) => [c, c])]) {
      if (id && state.loaded && !has(id)) continue;
      if (id === PAGE) sw.appendChild(el('span', 'on', label));
      else { const a = el('a', null, label); a.href = pageHref(id); sw.appendChild(a); }
    }
  }

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
  const granOf = (w) => (w === '1h' ? 'minute' : w === '24h' ? 'hour' : 'day');
  const perOf = (w) => (w === '1h' ? 'per minute' : w === '24h' ? 'per hour' : 'per day');

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

  // ── network switch, badge, hero ───────────────────────────
  function renderNetwork(overview) {
    const nets = [...new Set(overview.map((o) => o.network).filter(Boolean))];
    state.network = nets[0] || null;
    const badge = $('netBadge');
    badge.textContent = nets.length ? nets.join(' / ') : 'no source';
    badge.classList.toggle('off', !nets.length);
    badge.classList.toggle('warn', overview.some((o) => o.backfilling));
    $('factNetwork').textContent = state.network ? `${state.network} network` : 'no network yet';
    renderSwitch(state.network ? [{ id: state.network }] : []);
    // The server probes the sister instances and says which are up; a network that is not
    // reachable stays a label, not a dead link. It also names the readable API reference, if any.
    fetch(new URL('/api/networks', new URL(API, location.href)).href, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rep) => {
        if (!rep) return;
        if (Array.isArray(rep.networks) && rep.networks.length) renderSwitch(rep.networks.map((n) => ({ id: n.id, url: n.up ? n.url : '' })));
        if (rep.apiReference) $('apiLink').href = rep.apiReference;
      })
      .catch(() => {});
  }
  function renderSwitch(networks) {
    const sw = $('netSwitch');
    clear(sw);
    for (const n of networks) {
      if (n.id === state.network) sw.appendChild(el('span', 'on', n.id));
      else if (n.url) { const a = el('a', null, n.id); a.href = n.url + (PAGE ? `/${PAGE}` : '/'); sw.appendChild(a); }
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
      state.loaded = true;
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
      applyVisibility();
    } catch (err) {
      Object.values(cards).forEach((c) => errorState(c.querySelector('[data-stats]'), err));
      $('netBadge').textContent = 'offline'; $('netBadge').classList.add('off');
    } finally { Object.values(cards).forEach((c) => c.classList.remove('loading')); }
  }

  const setSubs = (root, W) => root.querySelectorAll('[data-sub]').forEach((e) => { e.textContent = perOf(W); });

  // ── Heartbeat ─────────────────────────────────────────────
  async function loadHeartbeat() {
    for (const chain of ACTIVE) {
      const card = document.querySelector(`[data-chart="hb${CHAIN_NAME[chain]}"]`);
      if (!visible(card)) continue;
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
    const cards = ACTIVITY.map((n) => document.querySelector(`[data-chart="${n}"]`)).filter(visible);
    cards.forEach((c) => c.classList.add('loading'));
    const jobs = [];
    // transactions, the chains in view on one axis
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="tx"]');
      try {
        const r = await Promise.all(ACTIVE.map((ch) => series(ch, 'tx.count', W).catch(() => null)));
        const x = unionX(...r.map(pts));
        draw(card, { kind: 'bar', gran, x, unit: 'tx', fmt: fmtInt, series: ACTIVE.map((ch, i) => ({ name: CHAIN_NAME[ch], color: COLOR[ch], values: alignOn(x, pts(r[i]), (p) => Number(p.sum)) })) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    for (const chain of ACTIVE) {
      const N = CHAIN_NAME[chain];
      // fees: median in the chain hue, p95 as context
      jobs.push((async () => {
        const card = document.querySelector(`[data-chart="fees${N}"]`);
        if (!visible(card)) return;
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
        if (!visible(card)) return;
        const path = `/getDistribution(chain='${chain}',metric='fees.paid',window='${W}')`;
        try { const d = await api(path); drawHist(card, d, d.unit); }
        catch (err) { errorState(chartCard(card), err); }
      })());
      // transaction mix as shares of all transactions
      jobs.push((async () => {
        const card = document.querySelector(`[data-chart="mix${N}"]`);
        if (!visible(card)) return;
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
    // empty blocks share and transactions per block, the chains in view
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="empty"]');
      try {
        const r = await Promise.all(ACTIVE.map((ch) => Promise.all([series(ch, 'blocks.count', W), series(ch, 'blocks.empty', W)]).catch(() => null)));
        const x = unionX(...r.map((p) => (p ? pts(p[0]) : [])));
        const shares = r.map((p) => { if (!p) return x.map(() => null); const tot = new Map(pts(p[0]).map((q) => [q.bucketStart, Number(q.sum)])); return alignOn(x, pts(p[1]), (q) => Number(q.sum)).map((v, i) => (tot.get(x[i]) ? ((v ?? 0) / tot.get(x[i])) * 100 : null)); });
        draw(card, { kind: 'line', gran, x, unit: '%', fmt: (v) => fmtPct(v), fmtAxis: (v) => `${fmtNum(v)}%`, area: false, series: ACTIVE.map((ch, i) => ({ name: CHAIN_NAME[ch], color: COLOR[ch], values: shares[i] })) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="txPerBlock"]');
      try {
        const r = await Promise.all(ACTIVE.map((ch) => series(ch, 'blocks.txCount', W).catch(() => null)));
        const x = unionX(...r.map((s) => pts(s)));
        draw(card, { kind: 'line', gran, x, unit: 'tx', fmt: (v) => fmtNum(v, 2), area: false, series: ACTIVE.map((ch, i) => ({ name: CHAIN_NAME[ch], color: COLOR[ch], values: alignOn(x, pts(r[i]), (p) => (p.avg == null ? null : Number(p.avg))) })) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    // block interval: median solid, p95 dashed, per chain
    jobs.push((async () => {
      const card = document.querySelector('[data-chart="interval"]');
      try {
        const r = await Promise.all(ACTIVE.map((ch) => (has(ch) ? series(ch, 'blocks.interval', W).catch(() => null) : null)));
        const x = unionX(...r.map((s) => pts(s)));
        const pick = (i, k) => alignOn(x, pts(r[i]), (p) => (p[k] == null ? null : Number(p[k])));
        draw(card, { kind: 'line', gran, x, unit: 's', fmt: (v) => `${fmtNum(v, 1)} s`, area: false, series: ACTIVE.flatMap((ch, i) => (r[i] ? [
          { name: `${CHAIN_NAME[ch]} median`, color: COLOR[ch], values: pick(i, 'p50') },
          { name: `${CHAIN_NAME[ch]} p95`, color: COLOR[ch], dash: true, values: pick(i, 'p95') },
        ] : [])) });
      } catch (err) { errorState(chartCard(card), err); }
    })());
    if (shown('midnight')) jobs.push((async () => {
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
    const job = (name, fn) => jobs.push((async () => { const card = document.querySelector(`[data-chart="${name}"]`); if (!visible(card)) return; try { await fn(card); } catch (err) { errorState(chartCard(card), err); } })());
    if (shown('cardano')) {
      job('tokenTransfers', (card) => sumChart(card, 'cardano', 'blocks.count', [['tokens.transfers', 'transfers']], { kind: 'bar', unit: 'moves', empty: 'No token transfers in this window yet.' }));
      job('utxoFlow', (card) => sumChart(card, 'cardano', 'blocks.count', [['utxo.created', 'created'], ['utxo.spent', 'spent']], { unit: 'utxo' }));
      job('blockSize', (card) => sizeChart(card, 'cardano', 'blocks.size'));
    }
    if (shown('midnight')) {
      job('contractTx', (card) => sumChart(card, 'midnight', 'blocks.count', [['tx.contractCalls', 'calls'], ['tx.contractDeploys', 'deploys']], { unit: 'tx', empty: 'No contract transactions in this window yet.' }));
      job('txSize', (card) => sizeChart(card, 'midnight', 'tx.size'));
    }
    if (shown('cardano')) {
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
    const cards = [...document.querySelectorAll('[data-kf]')].filter(visible);
    if (!cards.length) return;
    cards.forEach((c) => c.classList.add('loading'));
    const metrics = [...new Set(cards.flatMap((c) => KEY_FIGURES[c.dataset.kf] || []).map(([m]) => m))];
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
    if (!shown('midnight')) return;
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
    if (!shown('cardano')) return;
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

  async function loadRankings() {
    const W = state.window;
    const boards = [...document.querySelectorAll('[data-board]')].filter(visible);
    boards.forEach((b) => b.classList.add('loading'));
    const jobs = [];
    for (const chain of ACTIVE) {
      jobs.push((async () => {
        const card = document.querySelector(`[data-board="producers${CHAIN_NAME[chain]}"]`);
        if (!visible(card)) return;
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
        if (!visible(card)) return;
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
  // "API" opens $metadata until /api/networks names a readable reference (ASTRA_API_REFERENCE_URL).
  $('apiLink').href = url('/$metadata');
  const schedule = () => { clearInterval(state.timer); state.timer = setInterval(() => { if (!document.hidden) loadAll(true); }, CFG.refreshMs || 60000); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll(true); });

  applyVisibility();

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
    const h2 = section.querySelector('.section-head h2:not([hidden])');
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

  loadAll().then(schedule);
})();
