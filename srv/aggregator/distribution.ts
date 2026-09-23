/**
 * The stored histogram of a window as bins (`2^(k/b) .. 2^((k+1)/b)`, b = 8 per octave), merged
 * over the window's buckets and not re-binned. Zero and negative samples get their own entries.
 */
import type { Chain } from '../sources/types';
import { emptyHistogram, mergeInto, parseHistogram, quantile, totalCount, type Histogram } from './histogram';
import { readBuckets } from './store';
import { windowRange, type Window } from './time';
import { getMetric } from './windows';

export interface DistributionBin {
  /** Lower edge, inclusive. */
  lo: number;
  /** Upper edge, exclusive. */
  hi: number;
  count: number;
  /** Share of all samples in the window. */
  share: number;
}

export interface DistributionResult {
  chain: Chain;
  metric: string;
  window: Window;
  unit: string;
  count: number;
  binsPerOctave: number;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  bins: DistributionBin[];
  windowStart: string;
  windowEnd: string;
}

const edge = (bin: number, b: number) => Math.pow(2, bin / b);

/** Bins of one merged histogram, negatives first, then zero, then positives — ascending by value. */
export function binsOf(h: Histogram): Omit<DistributionBin, 'share'>[] {
  const out: Omit<DistributionBin, 'share'>[] = [];

  const negKeys = Object.keys(h.m).map(Number).sort((a, b) => b - a);
  for (const k of negKeys) {
    out.push({ lo: -edge(k + 1, h.b), hi: -edge(k, h.b), count: h.m[String(k)] });
  }
  if (h.z > 0) out.push({ lo: 0, hi: 0, count: h.z });
  const posKeys = Object.keys(h.p).map(Number).sort((a, b) => a - b);
  for (const k of posKeys) {
    out.push({ lo: edge(k, h.b), hi: edge(k + 1, h.b), count: h.p[String(k)] });
  }
  return out;
}

export async function getDistribution(
  db: any,
  chain: Chain,
  metricId: string,
  window: Window,
  now = Date.now(),
): Promise<DistributionResult> {
  const info = await getMetric(db, chain, metricId);
  const r = windowRange(window, now);
  const rows = await readBuckets(db, chain, r.granularity, r.start, r.end, [metricId]);

  const merged = emptyHistogram();
  let min: number | null = null;
  let max: number | null = null;
  for (const row of rows) {
    mergeInto(merged, parseHistogram(row.histogram));
    if (row.min !== null && (min === null || row.min < min)) min = row.min;
    if (row.max !== null && (max === null || row.max > max)) max = row.max;
  }

  const count = totalCount(merged);
  const bins = binsOf(merged).map(b => ({ ...b, share: count > 0 ? b.count / count : 0 }));

  return {
    chain,
    metric: metricId,
    window,
    unit: info?.unit ?? '',
    count,
    binsPerOctave: merged.b,
    min,
    max,
    p50: quantile(merged, 0.5, min, max),
    p95: quantile(merged, 0.95, min, max),
    bins,
    windowStart: new Date(r.start).toISOString(),
    windowEnd: new Date(r.end).toISOString(),
  };
}
