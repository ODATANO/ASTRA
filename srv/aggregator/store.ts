/**
 * Persistence of buckets in ASTRA's own database (cds.db):
 * merge minute deltas into existing buckets, roll minutes up to hours and
 * hours up to days, and read buckets back for windows and series.
 */
import cds from '@sap/cds';
import type { Chain } from '../sources/types';
import { emptyHistogram, mergeInto, parseHistogram, serializeHistogram, type Histogram } from './histogram';
import type { BucketAcc, DeltaMap, EntityDeltaMap } from './samples';
import { GRAN_MS, ROLLUP_OF, bucketStart, iso, parseMs, type Granularity } from './time';

const { SELECT, UPSERT, DELETE } = cds.ql;
export const BUCKETS = 'odatano.astra.MetricBuckets';
export const ENTITIES = 'odatano.astra.EntityBuckets';

export interface BucketRow {
  chain: Chain;
  metricId: string;
  granularity: Granularity;
  bucketStart: string;
  count: number;
  sum: number;
  sumSq: number;
  min: number | null;
  max: number | null;
  histogram: string | null;
  fromHeight: number | null;
  toHeight: number | null;
  computedAt: string;
}

/** Normalises a DB row (Decimal strings, Integer64 strings) into numbers. */
export function normalizeRow(r: any): BucketRow {
  const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    chain: r.chain,
    metricId: r.metricId,
    granularity: r.granularity,
    bucketStart: r.bucketStart,
    count: n(r.count) ?? 0,
    sum: n(r.sum) ?? 0,
    sumSq: n(r.sumSq) ?? 0,
    min: n(r.min),
    max: n(r.max),
    histogram: r.histogram ?? null,
    fromHeight: n(r.fromHeight),
    toHeight: n(r.toHeight),
    computedAt: r.computedAt,
  };
}

/** Mutable accumulator used for merging rows and deltas. */
export interface Merged {
  count: number; sum: number; sumSq: number;
  min: number | null; max: number | null;
  hist: Histogram;
  fromHeight: number | null; toHeight: number | null;
}

export function newMerged(): Merged {
  return { count: 0, sum: 0, sumSq: 0, min: null, max: null, hist: emptyHistogram(), fromHeight: null, toHeight: null };
}

export function mergeRow(m: Merged, r: BucketRow): Merged {
  m.count += r.count;
  m.sum += r.sum;
  m.sumSq += r.sumSq;
  if (r.min !== null && (m.min === null || r.min < m.min)) m.min = r.min;
  if (r.max !== null && (m.max === null || r.max > m.max)) m.max = r.max;
  if (r.fromHeight !== null && (m.fromHeight === null || r.fromHeight < m.fromHeight)) m.fromHeight = r.fromHeight;
  if (r.toHeight !== null && (m.toHeight === null || r.toHeight > m.toHeight)) m.toHeight = r.toHeight;
  mergeInto(m.hist, parseHistogram(r.histogram));
  return m;
}

export function mergeAcc(m: Merged, a: BucketAcc): Merged {
  m.count += a.count;
  m.sum += a.sum;
  m.sumSq += a.sumSq;
  if (m.min === null || a.min < m.min) m.min = a.min;
  if (m.max === null || a.max > m.max) m.max = a.max;
  if (m.fromHeight === null || a.fromHeight < m.fromHeight) m.fromHeight = a.fromHeight;
  if (m.toHeight === null || a.toHeight > m.toHeight) m.toHeight = a.toHeight;
  mergeInto(m.hist, a.hist);
  return m;
}

const dec = (v: number | null) => (v === null ? null : Number.isInteger(v) ? String(v) : v.toFixed(6));

export function toRow(chain: Chain, metricId: string, granularity: Granularity, startMs: number, m: Merged, now: string): Record<string, unknown> {
  return {
    chain, metricId, granularity,
    bucketStart: iso(startMs),
    count: m.count,
    sum: dec(m.sum),
    sumSq: dec(m.sumSq),
    min: dec(m.min),
    max: dec(m.max),
    histogram: serializeHistogram(m.hist),
    fromHeight: m.fromHeight,
    toHeight: m.toHeight,
    computedAt: now,
  };
}

export async function readBuckets(tx: any, chain: Chain, granularity: Granularity, fromMs: number, toMsExclusive: number, metricIds?: string[]): Promise<BucketRow[]> {
  // cds.ql takes one operator per column object → chain .where() calls (they are AND-ed)
  let q = SELECT.from(BUCKETS)
    .where({ chain, granularity })
    .where({ bucketStart: { '>=': iso(fromMs) } })
    .where({ bucketStart: { '<': iso(toMsExclusive) } });
  if (metricIds?.length) q = q.where({ metricId: { in: metricIds } });
  const rows = await tx.run(q.orderBy('bucketStart asc'));
  return rows.map(normalizeRow);
}

/**
 * Merges deltas into the stored buckets of all granularities (minute, hour, day). Each block is
 * processed once (cursor), so merging the same delta into all three is exact and survives the
 * retention of the finer levels. Rollups from the finer level are used by reorg rewinds only.
 *
 * Runs inside the caller's transaction.
 */
export async function applyDeltas(tx: any, chain: Chain, deltas: DeltaMap, now = new Date().toISOString()): Promise<{ minutes: number; hours: number; days: number }> {
  if (deltas.size === 0) return { minutes: 0, hours: 0, days: 0 };
  const written = { minutes: 0, hours: 0, days: 0 };
  for (const granularity of ['minute', 'hour', 'day'] as const) {
    // aggregate the minute deltas into (metric, period) accumulators of this granularity
    const perKey = new Map<string, { metricId: string; start: number; acc: BucketAcc[] }>();
    let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
    const metricIds = new Set<string>();
    for (const d of deltas.values()) {
      const start = bucketStart(d.bucketStart, granularity);
      const key = `${d.metricId}|${start}`;
      let e = perKey.get(key);
      if (!e) perKey.set(key, (e = { metricId: d.metricId, start, acc: [] }));
      e.acc.push(d);
      if (start < lo) lo = start;
      if (start > hi) hi = start;
      metricIds.add(d.metricId);
    }
    const existing = await readBuckets(tx, chain, granularity, lo, hi + GRAN_MS[granularity], [...metricIds]);
    const byKey = new Map<string, BucketRow>();
    for (const r of existing) byKey.set(`${r.metricId}|${parseMs(r.bucketStart)}`, r);

    const rows: Record<string, unknown>[] = [];
    for (const [key, e] of perKey) {
      const m = newMerged();
      const prev = byKey.get(key);
      if (prev) mergeRow(m, prev);
      for (const a of e.acc) mergeAcc(m, a);
      rows.push(toRow(chain, e.metricId, granularity, e.start, m, now));
    }
    await upsertRows(tx, rows);
    if (granularity === 'minute') written.minutes = rows.length;
    else if (granularity === 'hour') written.hours = rows.length;
    else written.days = rows.length;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Entity buckets (leaderboards)
// ---------------------------------------------------------------------------

const entityKey = (r: { dimension: string; entityId: string; subjectId?: string; metricId: string }, startMs: number) =>
  `${r.dimension}|${r.entityId}|${r.subjectId ?? ''}|${r.metricId}|${startMs}`;

async function readEntityRows(tx: any, chain: Chain, granularity: Granularity, fromMs: number, toMsExclusive: number): Promise<any[]> {
  return await tx.run(
    SELECT.from(ENTITIES)
      .where({ chain, granularity })
      .where({ bucketStart: { '>=': iso(fromMs) } })
      .where({ bucketStart: { '<': iso(toMsExclusive) } }),
  );
}

/**
 * Writes entity deltas at hour granularity only; day rows are rebuilt from the hours by
 * rollupEntityDays() once per cycle (merging per chunk would re-read every entity row of the day).
 */
export async function applyEntityDeltas(tx: any, chain: Chain, entities: EntityDeltaMap, now = new Date().toISOString()): Promise<number> {
  if (entities.size === 0) return 0;
  let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
  for (const e of entities.values()) {
    if (e.bucketStart < lo) lo = e.bucketStart;
    if (e.bucketStart > hi) hi = e.bucketStart;
  }
  const existing = await readEntityRows(tx, chain, 'hour', lo, hi + GRAN_MS.hour);
  const byKey = new Map<string, any>();
  for (const r of existing) byKey.set(entityKey(r, parseMs(r.bucketStart) ?? 0), r);

  const rows: Record<string, unknown>[] = [];
  for (const e of entities.values()) {
    const prev = byKey.get(entityKey(e, e.bucketStart));
    const count = Number(prev?.count ?? 0) + e.count;
    const sum = Number(prev?.sum ?? 0) + e.sum;
    const fromHeight = prev ? Math.min(Number(prev.fromHeight), e.fromHeight) : e.fromHeight;
    const toHeight = prev ? Math.max(Number(prev.toHeight), e.toHeight) : e.toHeight;
    rows.push({
      chain, dimension: e.dimension, entityId: e.entityId, subjectId: e.subjectId ?? '', metricId: e.metricId,
      granularity: 'hour', bucketStart: iso(e.bucketStart),
      count, sum: dec(sum), fromHeight, toHeight, computedAt: now,
    });
  }
  await upsertRows(tx, rows, ENTITIES);
  return rows.length;
}

/** Rebuilds the day rows of the given days from their hour rows. */
export async function rollupEntityDays(tx: any, chain: Chain, dayStarts: number[], now = new Date().toISOString()): Promise<number> {
  let written = 0;
  for (const start of dayStarts) {
    const hours = await readEntityRows(tx, chain, 'hour', start, start + GRAN_MS.day);
    if (!hours.length) continue;
    const per = new Map<string, Record<string, unknown>>();
    for (const h of hours) {
      const key = `${h.dimension}|${h.entityId}|${h.subjectId ?? ''}|${h.metricId}`;
      const prev = per.get(key);
      if (!prev) {
        per.set(key, {
          chain, dimension: h.dimension, entityId: h.entityId, subjectId: h.subjectId ?? '', metricId: h.metricId,
          granularity: 'day', bucketStart: iso(start),
          count: Number(h.count), sum: Number(h.sum ?? 0),
          fromHeight: Number(h.fromHeight), toHeight: Number(h.toHeight), computedAt: now,
        });
        continue;
      }
      prev.count = Number(prev.count) + Number(h.count);
      prev.sum = Number(prev.sum) + Number(h.sum ?? 0);
      prev.fromHeight = Math.min(Number(prev.fromHeight), Number(h.fromHeight));
      prev.toHeight = Math.max(Number(prev.toHeight), Number(h.toHeight));
    }
    const rows = [...per.values()].map(r => ({ ...r, sum: dec(Number(r.sum)) }));
    await upsertRows(tx, rows, ENTITIES);
    written += rows.length;
  }
  return written;
}

/**
 * Recomputes the buckets of `granularity` that start at `periodStarts` from the next
 * finer level. Only valid where the finer level is complete (recent periods, i.e. reorg
 * rewinds); never used for normal ingestion – see applyDeltas.
 */
export async function rollup(tx: any, chain: Chain, granularity: Exclude<Granularity, 'minute'>, periodStarts: number[], now = new Date().toISOString()): Promise<number> {
  const finer = ROLLUP_OF[granularity];
  const size = GRAN_MS[granularity];
  let written = 0;
  for (const start of periodStarts) {
    const fine = await readBuckets(tx, chain, finer, start, start + size);
    const perMetric = new Map<string, Merged>();
    for (const r of fine) {
      let m = perMetric.get(r.metricId);
      if (!m) perMetric.set(r.metricId, (m = newMerged()));
      mergeRow(m, r);
    }
    const rows: Record<string, unknown>[] = [];
    for (const [metricId, m] of perMetric) rows.push(toRow(chain, metricId, granularity, start, m, now));
    // metrics that vanished from the period (after a reorg) must not keep a stale rollup
    await tx.run(DELETE.from(BUCKETS).where({ chain, granularity, bucketStart: iso(start), ...(rows.length ? { metricId: { 'not in': [...perMetric.keys()] } } : {}) }));
    await upsertRows(tx, rows);
    written += rows.length;
  }
  return written;
}

async function upsertRows(tx: any, rows: Record<string, unknown>[], entity: string = BUCKETS): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.run(UPSERT.into(entity).entries(rows.slice(i, i + CHUNK)));
  }
}

/**
 * Reorg and recompute: drops every bucket of all three granularities that contains a block above
 * `forkHeight` and returns the lowest `fromHeight` among them (a bucket straddling the fork is
 * rebuilt whole). Hour and day must be dropped too: minute buckets are pruned after
 * `minuteHours`, so they cannot be rebuilt from below, and re-aggregating would add to them.
 */
export async function rewindTo(tx: any, chain: Chain, forkHeight: number, _now = new Date().toISOString()): Promise<{ resumeFrom: number; dropped: number }> {
  // Both stores, or a reorg would leave the leaderboards counting orphaned blocks.
  const [rows, entityRows] = await Promise.all([
    tx.run(SELECT.from(BUCKETS).columns('fromHeight').where({ chain, toHeight: { '>': forkHeight } })),
    tx.run(SELECT.from(ENTITIES).columns('fromHeight').where({ chain, toHeight: { '>': forkHeight } })),
  ]);
  if (!rows.length && !entityRows.length) return { resumeFrom: forkHeight + 1, dropped: 0 };

  let resumeFrom = forkHeight + 1;
  for (const r of [...rows, ...entityRows]) {
    const from = Number(r.fromHeight);
    if (Number.isFinite(from) && from < resumeFrom) resumeFrom = from;
  }
  // Delete from resumeFrom, not from the fork: the coarsest affected bucket starts there and
  // is rebuilt whole, so the finer buckets inside it have to go too — leaving them would make
  // the re-aggregation add to them a second time. Buckets are contiguous, so the period before
  // resumeFrom ends at resumeFrom - 1 and is never touched.
  const dropped = await tx.run(DELETE.from(BUCKETS).where({ chain, toHeight: { '>=': resumeFrom } }));
  await tx.run(DELETE.from(ENTITIES).where({ chain, toHeight: { '>=': resumeFrom } }));
  // No rollup here: everything from resumeFrom on is gone, and the aggregation that follows
  // rebuilds minute, hour and day from the source as it walks forward.
  return { resumeFrom, dropped: Number(dropped) || rows.length };
}

/** Deletes all buckets of a chain (full recompute), or those touching heights >= fromHeight. */
export async function dropBuckets(tx: any, chain: Chain, fromHeight: number | null): Promise<void> {
  if (fromHeight === null) {
    await tx.run(DELETE.from(BUCKETS).where({ chain }));
    await tx.run(DELETE.from(ENTITIES).where({ chain }));
    return;
  }
  await rewindTo(tx, chain, fromHeight - 1);
}

/** Retention: minute buckets older than `minuteHours`, hour buckets older than `hourDays`. */
export async function prune(tx: any, chain: Chain, minuteHours: number, hourDays: number, now = Date.now()): Promise<void> {
  await tx.run(DELETE.from(BUCKETS).where({ chain, granularity: 'minute', bucketStart: { '<': iso(now - minuteHours * GRAN_MS.hour) } }));
  await tx.run(DELETE.from(BUCKETS).where({ chain, granularity: 'hour', bucketStart: { '<': iso(now - hourDays * GRAN_MS.day) } }));
}
