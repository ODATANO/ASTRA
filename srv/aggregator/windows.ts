/**
 * Read side: rolling windows, series and change-vs-previous, computed from
 * stored buckets only (no raw rows are read here).
 */
import cds from '@sap/cds';
import type { Chain } from '../sources/types';
import { quantile } from './histogram';
import { mergeRow, newMerged, readBuckets, type BucketRow, type Merged } from './store';
import { iso, windowRange, type Window } from './time';

const { SELECT } = cds.ql;

export interface MetricInfo { chain: Chain; ID: string; name: string; kind: 'counter' | 'distribution' | 'gauge'; unit: string; scope?: 'chain' | 'entity' | 'both' }

export async function getMetric(db: any, chain: Chain, metricId: string): Promise<MetricInfo | null> {
  const m = await db.run(SELECT.one.from('odatano.astra.Metrics').where({ chain, ID: metricId }));
  return m ?? null;
}

export function headline(kind: MetricInfo['kind'] | undefined, m: Merged): number | null {
  if (m.count === 0) return null;
  if (kind === 'distribution') return m.sum / m.count;
  return m.sum;
}

export function stddev(m: Merged): number | null {
  if (m.count < 2) return null;
  const mean = m.sum / m.count;
  const v = m.sumSq / m.count - mean * mean;
  return v > 0 ? Math.sqrt(v) : 0;
}

export function changePct(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 10000) / 100;
}

export interface WindowStats {
  chain: Chain; metric: string; window: Window; unit: string | null; kind: MetricInfo['kind'] | null;
  windowStart: string; windowEnd: string;
  value: number | null; count: number; sum: number; avg: number | null; min: number | null; max: number | null;
  p50: number | null; p95: number | null; stddev: number | null;
  prevValue: number | null; prevSum: number; prevCount: number; changePct: number | null;
  fromHeight: number | null; toHeight: number | null; bucketsUsed: number; computedAt: string | null;
}

function summarize(rows: BucketRow[]): { m: Merged; computedAt: string | null } {
  const m = newMerged();
  let computedAt: string | null = null;
  for (const r of rows) {
    mergeRow(m, r);
    if (!computedAt || (r.computedAt && r.computedAt > computedAt)) computedAt = r.computedAt;
  }
  return { m, computedAt };
}

export async function computeWindow(db: any, chain: Chain, metricId: string, window: Window, now = Date.now(), info?: MetricInfo | null): Promise<WindowStats> {
  info ??= await getMetric(db, chain, metricId);
  const r = windowRange(window, now);
  const [cur, prev] = await Promise.all([
    readBuckets(db, chain, r.granularity, r.start, r.end, [metricId]),
    readBuckets(db, chain, r.granularity, r.prevStart, r.prevEnd, [metricId]),
  ]);
  const { m, computedAt } = summarize(cur);
  const { m: pm } = summarize(prev);
  const value = headline(info?.kind, m);
  const prevValue = headline(info?.kind, pm);
  return {
    chain, metric: metricId, window, unit: info?.unit ?? null, kind: info?.kind ?? null,
    windowStart: iso(r.start), windowEnd: iso(r.end),
    value, count: m.count, sum: m.sum, avg: m.count ? m.sum / m.count : null, min: m.min, max: m.max,
    p50: quantile(m.hist, 0.5, m.min, m.max), p95: quantile(m.hist, 0.95, m.min, m.max), stddev: stddev(m),
    prevValue, prevSum: pm.sum, prevCount: pm.count, changePct: changePct(value, prevValue),
    fromHeight: m.fromHeight, toHeight: m.toHeight, bucketsUsed: cur.length, computedAt,
  };
}

export interface SeriesPoint {
  bucketStart: string; count: number; sum: number; avg: number | null; min: number | null; max: number | null;
  p50: number | null; p95: number | null; fromHeight: number | null; toHeight: number | null;
}

export async function computeSeries(db: any, chain: Chain, metricId: string, window: Window, now = Date.now()): Promise<{ granularity: string; windowStart: string; windowEnd: string; points: SeriesPoint[] }> {
  const r = windowRange(window, now);
  const rows = await readBuckets(db, chain, r.granularity, r.start, r.end, [metricId]);
  const points = rows.map(b => {
    const m = mergeRow(newMerged(), b);
    return {
      bucketStart: iso(Date.parse(b.bucketStart)), count: b.count, sum: b.sum,
      avg: b.count ? b.sum / b.count : null, min: b.min, max: b.max,
      p50: quantile(m.hist, 0.5, b.min, b.max), p95: quantile(m.hist, 0.95, b.min, b.max),
      fromHeight: b.fromHeight, toHeight: b.toHeight,
    };
  });
  return { granularity: r.granularity, windowStart: iso(r.start), windowEnd: iso(r.end), points };
}
