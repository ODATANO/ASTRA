/**
 * `KeyFigures` and the named rankings — the two entity sets a dashboard, a spreadsheet or an
 * agent reads without knowing a metric id.
 *
 * KeyFigures: one row per chain, metric and rolling window (1h, 24h, 7d, 14d, 30d) with the
 * value, the previous window and the change. It is the whole catalogue of chain-wide metrics
 * unrolled over the windows; a filter on `chain`, `metric` or `window` narrows what is computed.
 *
 * Rankings: `TopTokens`, `TopPools`, ... are the leaderboards with the question already asked.
 * Each name fixes the dimension, the metric and whether "top" means most events or most
 * quantity; the consumer only picks chain and window. Adding a ranking is one line in RANKINGS.
 */
import cds from '@sap/cds';
import type { Chain } from '../sources/types';
import { getLeaderboard, LEADERBOARD_WINDOWS, type Dimension, type LeaderboardWindow } from '../aggregator/leaderboards';
import { WINDOWS, type Window } from '../aggregator/time';
import { computeWindow, getMetric, type MetricInfo } from '../aggregator/windows';

const { SELECT } = cds.ql;

export const KEY_FIGURE_WINDOWS = Object.keys(WINDOWS) as Window[];

export interface KeyFigureRow extends Record<string, unknown> {
  chain: Chain;
  metric: string;
  window: Window;
  name: string;
  unit: string | null;
  kind: string | null;
  value: number | null;
  previous: number | null;
  changePct: number | null;
}

/** Runs `fn` over `items` with at most `width` in flight; the aggregates DB is one Postgres, not a cluster. */
async function mapLimited<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function readKeyFigures(db: any, chains: Chain[], metrics: string[] | null, windows: Window[] | null, now = Date.now()): Promise<KeyFigureRow[]> {
  let q = SELECT.from('odatano.astra.Metrics').where({ chain: { in: chains } });
  if (metrics?.length) q = q.where({ ID: { in: metrics } });
  const catalogue: MetricInfo[] = await db.run(q.orderBy('chain', 'ID'));
  // gauges are epoch state, not window sums (see StakeEpochs); entity-only metrics have no chain total
  const usable = catalogue.filter(m => m.kind !== 'gauge' && m.scope !== 'entity');
  const wins = windows?.length ? windows : KEY_FIGURE_WINDOWS;
  const jobs = usable.flatMap(m => wins.map(w => ({ m, w })));
  return mapLimited(jobs, 8, async ({ m, w }) => {
    const s = await computeWindow(db, m.chain, m.ID, w, now, m);
    return {
      chain: m.chain, metric: m.ID, window: w, name: m.name, unit: m.unit, kind: m.kind,
      value: s.value, previous: s.prevValue, changePct: s.changePct,
      count: s.count, sum: s.sum, avg: s.avg, min: s.min, max: s.max, p50: s.p50, p95: s.p95,
      windowStart: s.windowStart, windowEnd: s.windowEnd, fromHeight: s.fromHeight, toHeight: s.toHeight,
    };
  });
}

// ---------------------------------------------------------------- rankings

export interface RankingDef {
  dimension: Dimension;
  metric: string;
  /** 'count' ranks by number of events, 'sum' by quantity — quantities of different tokens are not comparable, so token rankings count. */
  by: 'sum' | 'count';
  windows: readonly LeaderboardWindow[];
  /** What `entityId` is, for the reader. */
  entity: string;
}

const FLOW = LEADERBOARD_WINDOWS.filter(w => w !== 'epoch');

export const RANKINGS: Record<string, RankingDef> = {
  TopTokens:         { dimension: 'token',    metric: 'tokens.transfers',       by: 'count', windows: FLOW,      entity: 'unit (policyId + assetNameHex)' },
  TopPolicies:       { dimension: 'policy',   metric: 'tokens.transfers',       by: 'count', windows: FLOW,      entity: 'policyId' },
  TopAddresses:      { dimension: 'address',  metric: 'value.received',         by: 'sum',   windows: FLOW,      entity: 'address' },
  TopScripts:        { dimension: 'script',   metric: 'value.received',         by: 'sum',   windows: FLOW,      entity: 'script address' },
  TopBlockProducers: { dimension: 'producer', metric: 'blocks.produced',        by: 'count', windows: FLOW,      entity: 'pool id (Cardano) / author (Midnight)' },
  TopPools:          { dimension: 'pool',     metric: 'stake.live',             by: 'sum',   windows: ['epoch'], entity: 'pool id' },
  TopDReps:          { dimension: 'drep',     metric: 'governance.votingPower', by: 'sum',   windows: ['epoch'], entity: 'DRep id' },
};

export interface RankingRow extends Record<string, unknown> {
  chain: Chain;
  window: LeaderboardWindow;
  rank: number;
  entityId: string;
  count: number;
  sum: number;
  unit: string | null;
  entities: number;
  windowStart: string;
  windowEnd: string;
  fromHeight: number | null;
  toHeight: number | null;
}

export async function readRanking(db: any, name: string, chains: Chain[], windows: LeaderboardWindow[] | null, limit = 20, now = Date.now()): Promise<RankingRow[]> {
  const def = RANKINGS[name];
  if (!def) throw new Error(`no ranking '${name}'`);
  const wins = (windows?.length ? windows : def.windows).filter(w => def.windows.includes(w));
  const out: RankingRow[] = [];
  for (const chain of chains) {
    const info = await getMetric(db, chain, def.metric);
    if (!info) continue; // this chain has no such thing (Midnight has no tokens, no pools)
    for (const w of wins) {
      const board = await getLeaderboard(db, chain, def.dimension, def.metric, w, limit, def.by, now);
      for (const r of board.rows) {
        out.push({
          chain, window: w, rank: r.rank, entityId: r.entityId, count: r.count, sum: r.sum, unit: info.unit,
          entities: board.entities, windowStart: board.windowStart, windowEnd: board.windowEnd,
          fromHeight: r.fromHeight, toHeight: r.toHeight,
        });
      }
    }
  }
  return out;
}
