/**
 * Leaderboards over `odatano.astra.EntityBuckets`, ranked at read time over the full entity set
 * of the window (exact, not a stored top-N).
 *
 * 24h reads the hour rows, 7d/14d/30d the day rows; no 1h window (the entity store starts at
 * hour granularity). `epoch` reads the newest snapshot instead of a span.
 */
import cds from '@sap/cds';
import type { Chain } from '../sources/types';
import { ENTITIES } from './store';
import { GRAN_MS, bucketStart, iso, type Window } from './time';

const { SELECT } = cds.ql;

export type Dimension = 'token' | 'policy' | 'script' | 'address' | 'producer' | 'pool' | 'drep' | 'tokenHolder' | 'contract' | 'circuit';

export const LEADERBOARD_WINDOWS = ['24h', '7d', '14d', '30d', 'epoch'] as const;
export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

export function isLeaderboardWindow(w: unknown): w is LeaderboardWindow {
  return typeof w === 'string' && (LEADERBOARD_WINDOWS as readonly string[]).includes(w);
}

export interface LeaderRow {
  rank: number;
  entityId: string;
  count: number;
  sum: number;
  fromHeight: number | null;
  toHeight: number | null;
}

export interface LeaderboardResult {
  chain: Chain;
  dimension: Dimension;
  /** The second axis when the dimension has one (tokenHolder: the unit), else null. */
  subject?: string | null;
  metric: string;
  window: LeaderboardWindow;
  /** How many distinct entities the window holds — the ranking is the head of this. */
  entities: number;
  windowStart: string;
  windowEnd: string;
  rows: LeaderRow[];
}

/** Which stored granularity a leaderboard window reads, and how many periods it spans. */
function rangeFor(window: Exclude<LeaderboardWindow, 'epoch'>, now: number) {
  const spec = window === '24h'
    ? { granularity: 'hour' as const, periods: 24 }
    : { granularity: 'day' as const, periods: window === '7d' ? 7 : window === '14d' ? 14 : 30 };
  const size = GRAN_MS[spec.granularity];
  const end = bucketStart(now, spec.granularity) + size;
  return { ...spec, start: end - spec.periods * size, end };
}

/** The newest epoch snapshot: exactly one bucketStart, the latest present for dimension and metric. */
async function latestEpochStart(db: any, chain: Chain, dimension: Dimension, metricId: string, subjectId = ''): Promise<string | null> {
  const r = await db.run(
    SELECT.one.from(ENTITIES).columns('max(bucketStart) as latest')
      .where({ chain, dimension, metricId, subjectId, granularity: 'epoch' }),
  );
  return r?.latest ?? null;
}

/** Top `limit` entities of a dimension by a metric; `by` ranks by summed quantity or by event count. */
export interface EntitySet {
  rows: LeaderRow[];
  windowStart: string;
  windowEnd: string;
}

/** Every entity of a dimension in the window, summed and ranked; feeds both the leaderboard and the concentration measures. */
export async function collectEntities(
  db: any,
  chain: Chain,
  dimension: Dimension,
  metricId: string,
  window: LeaderboardWindow,
  by: 'sum' | 'count' = 'sum',
  now = Date.now(),
  subjectId?: string | null,
): Promise<EntitySet> {
  // `tokenHolder` needs one: ranking addresses across ALL tokens at once would add quantities of
  // unrelated units together, which is the same mistake the chain-wide token metrics avoid.
  const subject = subjectId ?? '';
  let rows: any[];
  let windowStart: string;
  let windowEnd: string;

  if (window === 'epoch') {
    const latest = await latestEpochStart(db, chain, dimension, metricId, subject);
    if (!latest) return { rows: [], windowStart: iso(now), windowEnd: iso(now) };
    rows = await db.run(
      SELECT.from(ENTITIES)
        .columns('entityId', 'count', 'sum', 'fromHeight', 'toHeight')
        .where({ chain, dimension, metricId, subjectId: subject, granularity: 'epoch', bucketStart: latest }),
    );
    windowStart = latest;
    windowEnd = latest;
  } else {
    const r = rangeFor(window, now);
    // summed per entity in the database: one row per entity instead of one per entity and period
    rows = await db.run(
      SELECT.from(ENTITIES)
        .columns('entityId', 'sum(count) as count', 'sum(sum) as sum', 'min(fromHeight) as fromHeight', 'max(toHeight) as toHeight')
        .where({ chain, dimension, metricId, subjectId: subject, granularity: r.granularity })
        .where({ bucketStart: { '>=': iso(r.start) } })
        .where({ bucketStart: { '<': iso(r.end) } })
        .groupBy('entityId'),
    );
    windowStart = iso(r.start);
    windowEnd = iso(r.end);
  }

  const per = new Map<string, LeaderRow>();
  for (const row of rows) {
    // tokenHolder stores `unit|address` to keep the pair unique in the key; callers get the
    // address back, since the unit they asked for is already in `subject`
    const stored = String(row.entityId);
    const id = dimension === 'tokenHolder' ? stored.slice(stored.indexOf('|') + 1) : stored;
    const count = Number(row.count ?? 0);
    const sum = Number(row.sum ?? 0);
    const from = row.fromHeight === null || row.fromHeight === undefined ? null : Number(row.fromHeight);
    const to = row.toHeight === null || row.toHeight === undefined ? null : Number(row.toHeight);
    const prev = per.get(id);
    if (!prev) {
      per.set(id, { rank: 0, entityId: id, count, sum, fromHeight: from, toHeight: to });
      continue;
    }
    prev.count += count;
    prev.sum += sum;
    if (from !== null && (prev.fromHeight === null || from < prev.fromHeight)) prev.fromHeight = from;
    if (to !== null && (prev.toHeight === null || to > prev.toHeight)) prev.toHeight = to;
  }

  const ranked = [...per.values()].sort((a, b) => {
    const primary = by === 'count' ? b.count - a.count : b.sum - a.sum;
    if (primary !== 0) return primary;
    const secondary = by === 'count' ? b.sum - a.sum : b.count - a.count;
    // entityId last, so equal rows keep a stable order across calls instead of shuffling
    return secondary !== 0 ? secondary : a.entityId.localeCompare(b.entityId);
  });
  ranked.forEach((row, i) => { row.rank = i + 1; });

  return { rows: ranked, windowStart, windowEnd };
}

export async function getLeaderboard(
  db: any,
  chain: Chain,
  dimension: Dimension,
  metricId: string,
  window: LeaderboardWindow,
  limit = 20,
  by: 'sum' | 'count' = 'sum',
  now = Date.now(),
  subjectId?: string | null,
): Promise<LeaderboardResult> {
  const set = await collectEntities(db, chain, dimension, metricId, window, by, now, subjectId);
  return {
    chain,
    dimension,
    subject: subjectId ?? null,
    metric: metricId,
    window,
    entities: set.rows.length,
    windowStart: set.windowStart,
    windowEnd: set.windowEnd,
    rows: set.rows.slice(0, Math.max(1, Math.min(limit, 200))),
  };
}
