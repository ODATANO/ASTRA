import cds from '@sap/cds';
import type { Chain } from './sources/types';
import { changePct, computeSeries, computeWindow, getMetric } from './aggregator/windows';
import { getLeaderboard, isLeaderboardWindow, type Dimension } from './aggregator/leaderboards';
import { getConcentration } from './aggregator/concentration';
import { getDistribution } from './aggregator/distribution';
import { findAnomalies } from './aggregator/anomalies';
import { verifySample } from './verification/sampling';
import { getSource } from './aggregator/scheduler';
import { isWindow, type Window } from './aggregator/time';
import { activeChains, getAggregator, runNow } from './aggregator/scheduler';
import { applyQuery, bounds, parseQuery, pinned, type ParsedQuery } from './views/query';
import { DAILY_VIEWS, readDailyView, readStakeEpochs } from './views/daily';
import { RANKINGS, readKeyFigures, readRanking } from './views/figures';
import { viewMemo } from './views/memo';
import type { LeaderboardWindow } from './aggregator/leaderboards';

const { SELECT } = cds.ql;
const CHAINS: Chain[] = ['cardano', 'midnight'];
const DIMENSIONS: Dimension[] = ['token', 'policy', 'script', 'address', 'producer', 'pool', 'drep', 'tokenHolder'];
/** Fee figures of the overview are reported while the fee data reaches to within this of the newest block. */
const FEES_CURRENT_SEC = 3600;

export default class AstraService extends cds.ApplicationService {
  async init() {
    this.on('READ', 'ChainOverview', req => this.readOverview(req));
    // ready-made views: computed on read, query options applied by srv/views/query.ts
    this.on('READ', 'KeyFigures', req => this.readKeyFigures(req));
    for (const view of Object.keys(DAILY_VIEWS)) this.on('READ', view, req => this.readDaily(req, view));
    this.on('READ', 'StakeEpochs', req => this.readEpochs(req));
    for (const name of Object.keys(RANKINGS)) this.on('READ', name, req => this.readRanking(req, name));

    this.on('getWindow', async req => {
      const { chain, metric, window } = req.data as { chain: Chain; metric: string; window: Window };
      this.validate(req, chain, metric, window);
      const info = await getMetric(cds.db, chain, metric);
      if (!info) return req.reject(404, `unknown metric '${metric}' for chain '${chain}'`);
      if (info.scope === 'entity') return req.reject(400, entityOnly(metric));
      return computeWindow(cds.db, chain, metric, window, Date.now(), info);
    });

    this.on('getSeries', async req => {
      const { chain, metric, window } = req.data as { chain: Chain; metric: string; window: Window };
      this.validate(req, chain, metric, window);
      const info = await getMetric(cds.db, chain, metric);
      if (!info) return req.reject(404, `unknown metric '${metric}' for chain '${chain}'`);
      if (info.scope === 'entity') return req.reject(400, entityOnly(metric));
      const s = await computeSeries(cds.db, chain, metric, window);
      return { chain, metric, window, granularity: s.granularity, unit: info.unit, points: s.points };
    });

    this.on('compare', async req => {
      const { metric, window } = req.data as { metric: string; window: Window };
      if (!isWindow(window)) return req.reject(400, `window must be one of 1h, 24h, 7d, 14d, 30d`);
      const out = [];
      for (const chain of CHAINS) {
        const info = await getMetric(cds.db, chain, metric);
        if (info) out.push(await computeWindow(cds.db, chain, metric, window, Date.now(), info));
      }
      if (!out.length) return req.reject(404, `unknown metric '${metric}'`);
      return out;
    });

    this.on('getTop', async req => {
      const { chain, dimension, metric, window, limit, by, subject } = req.data as {
        chain: Chain; dimension: Dimension; metric: string; window: string;
        limit?: number | null; by?: 'sum' | 'count' | null; subject?: string | null;
      };
      if (!CHAINS.includes(chain)) return req.reject(400, `chain must be cardano or midnight`);
      if (!DIMENSIONS.includes(dimension)) return req.reject(400, `dimension must be one of ${DIMENSIONS.join(', ')}`);
      if (!metric) return req.reject(400, `metric is required`);
      if (!isLeaderboardWindow(window)) return req.reject(400, `window must be one of 24h, 7d, 14d, 30d, epoch`);
      const info = await getMetric(cds.db, chain, metric);
      if (!info) return req.reject(404, `unknown metric '${metric}' for chain '${chain}'`);
      if (info.scope === 'chain') {
        return req.reject(400, `metric '${metric}' is a chain-wide total with no per-entity breakdown — use getWindow or getSeries`);
      }
      if (dimension === 'tokenHolder' && !subject) {
        return req.reject(400, `dimension 'tokenHolder' needs a subject: the token unit to rank addresses within`);
      }
      return getLeaderboard(cds.db, chain, dimension, metric, window, limit ?? 20, by ?? 'sum', Date.now(), subject);
    });

    this.on('getConcentration', async req => {
      const { chain, dimension, metric, window, by, subject } = req.data as {
        chain: Chain; dimension: Dimension; metric: string; window: string;
        by?: 'sum' | 'count' | null; subject?: string | null;
      };
      if (!CHAINS.includes(chain)) return req.reject(400, `chain must be cardano or midnight`);
      if (!DIMENSIONS.includes(dimension)) return req.reject(400, `dimension must be one of ${DIMENSIONS.join(', ')}`);
      if (!isLeaderboardWindow(window)) return req.reject(400, `window must be one of 24h, 7d, 14d, 30d, epoch`);
      const info = await getMetric(cds.db, chain, metric);
      if (!info) return req.reject(404, `unknown metric '${metric}' for chain '${chain}'`);
      if (info.scope === 'chain') return req.reject(400, `metric '${metric}' has no per-entity breakdown to measure concentration over`);
      if (dimension === 'tokenHolder' && !subject) {
        return req.reject(400, `dimension 'tokenHolder' needs a subject: the token unit to measure within`);
      }
      return getConcentration(cds.db, chain, dimension, metric, window, by ?? 'sum', Date.now(), subject);
    });

    this.on('getDistribution', async req => {
      const { chain, metric, window } = req.data as { chain: Chain; metric: string; window: Window };
      this.validate(req, chain, metric, window);
      const info = await getMetric(cds.db, chain, metric);
      if (!info) return req.reject(404, `unknown metric '${metric}' for chain '${chain}'`);
      if (info.scope === 'entity') return req.reject(400, entityOnly(metric));
      return getDistribution(cds.db, chain, metric, window);
    });

    this.on('getAnomalies', async req => {
      const { chain, threshold, baselineDays } = req.data as {
        chain: Chain; threshold?: number | null; baselineDays?: number | null;
      };
      if (!CHAINS.includes(chain)) return req.reject(400, `chain must be cardano or midnight`);
      const catalogue: any[] = await cds.db.run(
        SELECT.from('odatano.astra.Metrics').columns('ID').where({ chain }),
      );
      return findAnomalies(
        cds.db, chain, catalogue.map(m => String(m.ID)),
        baselineDays ?? 14, threshold ?? 3,
      );
    });

    this.on('verifyNow', async req => {
      const { chain, samples } = req.data as { chain: Chain; samples?: number | null };
      if (!CHAINS.includes(chain)) return req.reject(400, `chain must be cardano or midnight`);
      const source = getSource(chain);
      if (!source) return req.reject(409, `chain '${chain}' has no configured source`);
      const tip = await source.getTip();
      const network = tip?.network;
      if (!network) return req.reject(409, `source for '${chain}' does not report which network it indexes`);
      return verifySample(cds.db, source, chain, network, Math.min(Math.max(samples ?? 100, 1), 500));
    });

    this.on('recompute', async req => {
      const { chain, fromHeight } = req.data as { chain: Chain; fromHeight: number | null };
      const agg = getAggregator(chain);
      if (!agg) return req.reject(409, `chain '${chain}' has no active aggregator (source not configured)`);
      await agg.recompute(fromHeight ?? null);
      viewMemo.clear();
      return this.status(chain);
    });

    this.on('runNow', async req => {
      const { chain } = req.data as { chain: Chain };
      if (!getAggregator(chain)) return req.reject(409, `chain '${chain}' has no active aggregator (source not configured)`);
      await runNow(chain);
      viewMemo.clear();
      return this.status(chain);
    });

    await super.init();
  }

  private validate(req: any, chain: Chain, metric: string, window: Window) {
    if (!CHAINS.includes(chain)) req.reject(400, `chain must be cardano or midnight`);
    if (!metric) req.reject(400, `metric is required`);
    if (!isWindow(window)) req.reject(400, `window must be one of 1h, 24h, 7d, 14d, 30d`);
  }

  private status(chain: Chain) {
    return cds.db.run(SELECT.one.from('AstraService.SyncStatus').where({ chain }));
  }

  /** Chains a request asks for: pinned by the filter or the key, else all. */
  private chainsOf(q: ParsedQuery): Chain[] {
    const want = pinned<string>(q, 'chain');
    return want ? CHAINS.filter(c => want.includes(c)) : CHAINS;
  }

  private async readKeyFigures(req: any) {
    const q = parseQuery(req);
    const windows = (pinned<string>(q, 'window') ?? []).filter(isWindow);
    const chains = this.chainsOf(q), metrics = pinned<string>(q, 'metric');
    const rows = await viewMemo.get(`figures|${chains}|${metrics}|${windows}`, () => readKeyFigures(cds.db, chains, metrics, windows.length ? windows : null));
    return applyQuery(rows, q, [{ column: 'chain' }, { column: 'metric' }, { column: 'window' }]);
  }

  private async readDaily(req: any, view: string) {
    const q = parseQuery(req);
    // a pinned or bounded day narrows what is read; the predicate still decides row by row
    const day = pinned<string>(q, 'day')?.[0];
    const b = bounds(q, 'day');
    const from = day ?? (typeof b.min === 'string' ? b.min : null);
    const to = day ?? (typeof b.max === 'string' ? b.max : null);
    const chains = this.chainsOf(q);
    const rows = await viewMemo.get(`daily|${view}|${chains}|${from}|${to}`, () => readDailyView(cds.db, view, chains, from, to));
    return applyQuery(rows, q, [{ column: 'day', desc: true }, { column: 'chain' }]);
  }

  private async readEpochs(req: any) {
    const q = parseQuery(req);
    const chains = this.chainsOf(q);
    const rows = await viewMemo.get(`epochs|${chains}`, () => readStakeEpochs(cds.db, chains));
    return applyQuery(rows, q, [{ column: 'epoch', desc: true }, { column: 'chain' }]);
  }

  private async readRanking(req: any, name: string) {
    const q = parseQuery(req);
    const windows = (pinned<string>(q, 'window') ?? []).filter(isLeaderboardWindow) as LeaderboardWindow[];
    // how deep to rank: 20 unless the filter bounds the rank (rank le 50, rank eq 7)
    let limit = 20;
    const rb = bounds(q, 'rank');
    if (rb.max !== undefined) limit = Number(rb.max) - (rb.maxExclusive ? 1 : 0);
    const eqRank = pinned<number>(q, 'rank');
    if (eqRank) limit = Math.max(...eqRank.map(Number));
    limit = Math.max(1, Math.min(200, Number.isFinite(limit) ? limit : 20));
    const chains = this.chainsOf(q), depth = limit;
    const rows = await viewMemo.get(`ranking|${name}|${chains}|${windows}|${depth}`, () => readRanking(cds.db, name, chains, windows.length ? windows : null, depth));
    return applyQuery(rows, q, [{ column: 'chain' }, { column: 'window' }, { column: 'rank' }]);
  }

  private async readOverview(req: any) {
    const q = parseQuery(req);
    const wanted = pinned<string>(q, 'chain') ?? undefined;
    const rows = await viewMemo.get(`overview|${wanted}`, () => this.computeOverview(wanted));
    return applyQuery(rows, q, [{ column: 'chain' }]);
  }

  private async computeOverview(wanted: string[] | undefined) {
    const cursors: any[] = await cds.db.run(SELECT.from('odatano.astra.ChainCursors').orderBy('chain'));
    const chains = (cursors.map(c => c.chain as Chain).length ? cursors.map(c => c.chain as Chain) : activeChains()).filter(c => !wanted || wanted.includes(c));
    const now = Date.now();
    const rows = [];
    for (const chain of chains) {
      const c = cursors.find(x => x.chain === chain) ?? {};
      const [blocks1h, tx1h, tx24h, fees24h, interval1h, txPerBlock24h] = await Promise.all([
        computeWindow(cds.db, chain, 'blocks.count', '1h', now),
        computeWindow(cds.db, chain, 'tx.count', '1h', now),
        computeWindow(cds.db, chain, 'tx.count', '24h', now),
        computeWindow(cds.db, chain, 'fees.paid', '24h', now),
        computeWindow(cds.db, chain, 'blocks.interval', '1h', now),
        computeWindow(cds.db, chain, 'blocks.txCount', '24h', now),
      ]);
      const tip = num(c.sourceTipHeight);
      const chainHeight = num(c.sourceChainHeight);
      const agg = num(c.lastHeight);
      // A chain without a fee pass has its fees with the block; one with it is only as far as that pass.
      const feePass = c.feeHeight !== null && c.feeHeight !== undefined;
      const feesThroughHeight = feePass ? num(c.feeHeight) : agg;
      const feesThroughTime = feePass ? num(c.feeBlockTime) : num(c.lastBlockTime);
      const lastBlockTime = num(c.lastBlockTime);
      const feesCurrent = !feePass || (feesThroughTime !== null && lastBlockTime !== null && lastBlockTime - feesThroughTime <= FEES_CURRENT_SEC);
      rows.push({
        chain,
        network: c.network ?? null,
        sourceSyncStatus: c.sourceSyncStatus ?? null,
        sourceTipHeight: tip,
        sourceChainHeight: chainHeight,
        // Without this a source that is weeks behind looks caught up: lagBlocks only
        // measures ASTRA against the source, never the source against the chain.
        sourceLagBlocks: chainHeight !== null && tip !== null ? chainHeight - tip : null,
        aggregatedHeight: agg,
        lagBlocks: tip !== null && agg !== null ? tip - agg : null,
        lastBlockAt: c.lastBlockTime ? new Date(Number(c.lastBlockTime) * 1000).toISOString() : null,
        backfilling: !!c.backfilling,
        blocks1h: blocks1h.count, blocks1hPrev: blocks1h.prevCount, blocks1hChangePct: changePct(blocks1h.count, blocks1h.prevCount),
        avgBlockTime1h: interval1h.avg,
        tx1h: tx1h.count, tx1hPrev: tx1h.prevCount, tx1hChangePct: changePct(tx1h.count, tx1h.prevCount),
        tx24h: tx24h.count,
        feesThroughHeight,
        feesThroughAt: feesThroughTime !== null ? new Date(feesThroughTime * 1000).toISOString() : null,
        fees24h: feesCurrent ? fees24h.sum : null,
        fees24hPrev: feesCurrent ? fees24h.prevSum : null,
        fees24hChangePct: feesCurrent ? changePct(fees24h.sum, fees24h.prevSum) : null,
        feeUnit: fees24h.unit,
        medianFee24h: feesCurrent ? fees24h.p50 : null,
        p95Fee24h: feesCurrent ? fees24h.p95 : null,
        avgTxPerBlock24h: txPerBlock24h.avg,
      });
    }
    return rows;
  }
}

/** Saying which call the number lives in beats answering a reasonable question with a zero. */
const entityOnly = (metric: string) =>
  `metric '${metric}' exists per entity only, not as a chain-wide total — use ` +
  `getTop(chain, dimension, '${metric}', window)`;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
