/**
 * Anomalies: a day is flagged when it sits more than `threshold` standard deviations from the
 * mean of the preceding N day buckets of the same metric. Every number used is in the response.
 *
 * No verdict when fewer than `minBaseline` prior days exist, or when the baseline has no spread
 * (stddev 0).
 */
import type { Chain } from '../sources/types';
import { readBuckets } from './store';
import { GRAN_MS, bucketStart, parseMs } from './time';
import { getMetric, type MetricInfo } from './windows';

export interface Anomaly {
  metric: string;
  unit: string;
  /** Day that stands out. */
  day: string;
  /** Headline value of that day: sum for counters, average for distributions. */
  value: number;
  /** Mean of the baseline days. */
  baseline: number;
  stddev: number;
  /** (value − baseline) / stddev. Negative means unusually quiet. */
  z: number;
  direction: 'high' | 'low';
  baselineDays: number;
}

export interface AnomalyReport {
  chain: Chain;
  threshold: number;
  baselineDays: number;
  /** Day the check looked at — the last COMPLETE day, never the running one. */
  day: string;
  anomalies: Anomaly[];
}

const headlineOf = (info: MetricInfo | null, count: number, sum: number): number | null => {
  if (count === 0) return null;
  return info?.kind === 'distribution' ? sum / count : sum;
};

/**
 * @param baselineDays how many completed days form the baseline (default 14)
 * @param threshold    z above which a day is reported (default 3)
 */
export async function findAnomalies(
  db: any,
  chain: Chain,
  metricIds: string[],
  baselineDays = 14,
  threshold = 3,
  minBaseline = 7,
  now = Date.now(),
): Promise<AnomalyReport> {
  // the current day is still filling; comparing a half day against full ones invents anomalies
  const today = bucketStart(now, 'day');
  const target = today - GRAN_MS.day;
  const from = target - baselineDays * GRAN_MS.day;

  const anomalies: Anomaly[] = [];
  for (const metricId of metricIds) {
    const info = await getMetric(db, chain, metricId);
    if (!info || info.scope === 'entity') continue;

    const rows = await readBuckets(db, chain, 'day', from, today, [metricId]);
    const byDay = new Map<number, { count: number; sum: number }>();
    for (const r of rows) {
      const ms = parseMs(r.bucketStart);
      if (ms === null) continue;
      byDay.set(ms, { count: r.count, sum: r.sum });
    }

    const targetRow = byDay.get(target);
    if (!targetRow) continue;
    const value = headlineOf(info, targetRow.count, targetRow.sum);
    if (value === null) continue;

    const baseline: number[] = [];
    for (let d = target - GRAN_MS.day; d >= from; d -= GRAN_MS.day) {
      const row = byDay.get(d);
      const v = row ? headlineOf(info, row.count, row.sum) : null;
      if (v !== null) baseline.push(v);
    }
    if (baseline.length < minBaseline) continue;

    const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
    const variance = baseline.reduce((s, v) => s + (v - mean) * (v - mean), 0) / baseline.length;
    const sd = Math.sqrt(variance);
    if (!(sd > 0)) continue;

    const z = (value - mean) / sd;
    if (Math.abs(z) < threshold) continue;

    anomalies.push({
      metric: metricId,
      unit: info.unit,
      day: new Date(target).toISOString(),
      value,
      baseline: mean,
      stddev: sd,
      z,
      direction: z > 0 ? 'high' : 'low',
      baselineDays: baseline.length,
    });
  }

  anomalies.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { chain, threshold, baselineDays, day: new Date(target).toISOString(), anomalies };
}
