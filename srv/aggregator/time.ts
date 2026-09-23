/** Bucket alignment and rolling windows. All instants are unix milliseconds. */

export type Granularity = 'minute' | 'hour' | 'day';
export type Window = '1h' | '24h' | '7d' | '14d' | '30d';

export const GRAN_MS: Record<Granularity, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export const ROLLUP_OF: Record<Exclude<Granularity, 'minute'>, Granularity> = {
  hour: 'minute',
  day: 'hour',
};

export const WINDOWS: Record<Window, { granularity: Granularity; buckets: number }> = {
  '1h': { granularity: 'minute', buckets: 60 },
  '24h': { granularity: 'hour', buckets: 24 },
  '7d': { granularity: 'day', buckets: 7 },
  '14d': { granularity: 'day', buckets: 14 },
  '30d': { granularity: 'day', buckets: 30 },
};

export function isWindow(w: unknown): w is Window {
  return typeof w === 'string' && w in WINDOWS;
}

export function bucketStart(ms: number, g: Granularity): number {
  const size = GRAN_MS[g];
  return Math.floor(ms / size) * size;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseMs(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export interface WindowRange {
  granularity: Granularity;
  /** inclusive start of the first bucket */
  start: number;
  /** exclusive end (= start of the bucket after the current one) */
  end: number;
  prevStart: number;
  prevEnd: number;
}

/**
 * Rolling window ending with the *current* (partial) bucket:
 * "last hour" = the 60 minute-buckets up to and including the running minute.
 */
export function windowRange(window: Window, now = Date.now()): WindowRange {
  const { granularity, buckets } = WINDOWS[window];
  const size = GRAN_MS[granularity];
  const end = bucketStart(now, granularity) + size;
  const start = end - buckets * size;
  return { granularity, start, end, prevStart: start - buckets * size, prevEnd: start };
}
