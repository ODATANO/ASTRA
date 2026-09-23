/**
 * Concentration of a dimension: Gini, Nakamoto coefficient and the share of the largest entities,
 * computed over every entity in the window (`collectEntities`), not over a stored top-N.
 *
 * Flow metrics (`value.received`, ...) describe how unevenly volume moved in the window; only the
 * epoch snapshots (`stake.live`, `governance.votingPower`) are holdings. `basis` says which.
 */
import type { Chain } from '../sources/types';
import { collectEntities, type Dimension, type LeaderboardWindow, type LeaderRow } from './leaderboards';

export interface ConcentrationResult {
  chain: Chain;
  dimension: Dimension;
  metric: string;
  window: LeaderboardWindow;
  /** 'holding' when the metric is a stock (pool stake), 'flow' when it is movement in the window. */
  basis: 'holding' | 'flow';
  entities: number;
  total: number;
  /** 0 = everyone equal, 1 = one entity holds everything. Null when there is nothing to divide. */
  gini: number | null;
  /** Smallest number of entities that together exceed half the total. */
  nakamoto: number | null;
  top1Share: number | null;
  top10Share: number | null;
  top100Share: number | null;
  windowStart: string;
  windowEnd: string;
}

/** Metrics that measure a stock rather than movement — the only ones where "concentration of the chain" is literal. */
const HOLDING_METRICS = new Set(['stake.live', 'stake.active', 'governance.votingPower']);

/**
 * Gini over non-negative values.
 *
 * Sorted-rank form: G = (2·Σ i·x_i) / (n·Σ x_i) − (n+1)/n, x ascending, i from 1. Zero values
 * are kept.
 */
export function gini(valuesAscending: number[]): number | null {
  const n = valuesAscending.length;
  if (n === 0) return null;
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    const v = valuesAscending[i];
    total += v;
    weighted += (i + 1) * v;
  }
  if (total <= 0) return null;
  const g = (2 * weighted) / (n * total) - (n + 1) / n;
  // floating point can push a perfectly equal distribution a hair below zero
  return Math.min(1, Math.max(0, g));
}

/** Smallest count of the largest entities whose sum passes half the total. */
export function nakamoto(valuesDescending: number[], total: number): number | null {
  if (total <= 0) return null;
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < valuesDescending.length; i++) {
    acc += valuesDescending[i];
    if (acc > half) return i + 1;
  }
  return null;
}

const shareOfTop = (descending: number[], k: number, total: number): number | null => {
  if (total <= 0 || descending.length === 0) return null;
  let acc = 0;
  for (let i = 0; i < Math.min(k, descending.length); i++) acc += descending[i];
  return acc / total;
};

export async function getConcentration(
  db: any,
  chain: Chain,
  dimension: Dimension,
  metricId: string,
  window: LeaderboardWindow,
  by: 'sum' | 'count' = 'sum',
  now = Date.now(),
  subjectId?: string | null,
): Promise<ConcentrationResult> {
  const set = await collectEntities(db, chain, dimension, metricId, window, by, now, subjectId);
  const pick = (r: LeaderRow) => (by === 'count' ? r.count : r.sum);

  // collectEntities already sorted descending by the chosen measure
  const descending = set.rows.map(pick).filter(v => Number.isFinite(v) && v >= 0);
  const total = descending.reduce((s, v) => s + v, 0);
  const ascending = [...descending].reverse();

  return {
    chain,
    dimension,
    metric: metricId,
    window,
    basis: HOLDING_METRICS.has(metricId) ? 'holding' : 'flow',
    entities: descending.length,
    total,
    gini: gini(ascending),
    nakamoto: nakamoto(descending, total),
    top1Share: shareOfTop(descending, 1, total),
    top10Share: shareOfTop(descending, 10, total),
    top100Share: shareOfTop(descending, 100, total),
    windowStart: set.windowStart,
    windowEnd: set.windowEnd,
  };
}
