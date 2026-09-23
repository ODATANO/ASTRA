/**
 * Compact log-scale histogram, stored as JSON in MetricBuckets.histogram.
 *
 *   { b: 8, z: 12, p: { "160": 3, "161": 7 }, m: { "24": 1 } }
 *
 *   b  bins per octave (bin k covers [2^(k/b), 2^((k+1)/b)) )
 *   z  number of zero samples
 *   p  positive samples by bin          m  negative samples by bin of |value|
 *
 * With b = 8 a percentile estimate is within ±4.4 % of the true value while a
 * bucket needs only a few dozen bins. Histograms of buckets merge exactly, so
 * hour/day rollups and rolling windows keep median and P95 without re-reading
 * raw rows.
 */

export const BINS_PER_OCTAVE = 8;

export interface Histogram {
  b: number;
  z: number;
  p: Record<string, number>;
  m: Record<string, number>;
}

export function emptyHistogram(b = BINS_PER_OCTAVE): Histogram {
  return { b, z: 0, p: {}, m: {} };
}

export function binOf(abs: number, b: number): number {
  return Math.floor(Math.log2(abs) * b);
}

export function addSample(h: Histogram, v: number): void {
  if (!Number.isFinite(v) || v === 0) { h.z++; return; }
  const target = v > 0 ? h.p : h.m;
  const k = String(binOf(Math.abs(v), h.b));
  target[k] = (target[k] || 0) + 1;
}

export function mergeInto(target: Histogram, other: Histogram | null | undefined): Histogram {
  if (!other) return target;
  if (other.b !== target.b) throw new Error(`histogram bin base mismatch (${target.b} vs ${other.b})`);
  target.z += other.z || 0;
  for (const [k, c] of Object.entries(other.p || {})) target.p[k] = (target.p[k] || 0) + c;
  for (const [k, c] of Object.entries(other.m || {})) target.m[k] = (target.m[k] || 0) + c;
  return target;
}

export function totalCount(h: Histogram): number {
  let n = h.z;
  for (const c of Object.values(h.p)) n += c;
  for (const c of Object.values(h.m)) n += c;
  return n;
}

export function parseHistogram(json: string | null | undefined): Histogram | null {
  if (!json) return null;
  try {
    const h = JSON.parse(json);
    if (!h || typeof h.b !== 'number') return null;
    return { b: h.b, z: h.z || 0, p: h.p || {}, m: h.m || {} };
  } catch {
    return null;
  }
}

export function serializeHistogram(h: Histogram): string {
  return JSON.stringify(h);
}

/**
 * Estimated value at quantile q (0..1). Walks negatives (most negative first),
 * zeros, then positives, and interpolates linearly inside the hit bin.
 * `clampMin`/`clampMax` (the bucket's exact min/max) tighten the outer bins.
 */
export function quantile(h: Histogram, q: number, clampMin?: number | null, clampMax?: number | null): number | null {
  const total = totalCount(h);
  if (total === 0) return null;
  if (q <= 0 && clampMin !== null && clampMin !== undefined) return clampMin;
  if (q >= 1 && clampMax !== null && clampMax !== undefined) return clampMax;
  const rank = Math.min(total - 1, Math.max(0, q * (total - 1)));
  let seen = 0;

  const negKeys = Object.keys(h.m).map(Number).sort((a, b) => b - a); // largest |v| first = most negative
  for (let i = 0; i < negKeys.length; i++) {
    const k = negKeys[i];
    const c = h.m[String(k)];
    if (rank < seen + c) {
      // most negative bin may be tightened by the exact min
      const tightLo = i === 0 && clampMin !== null && clampMin !== undefined && clampMin < 0 ? -clampMin : null;
      return clamp(-interp(k, h.b, (rank - seen + 0.5) / c, true, tightLo), clampMin, clampMax);
    }
    seen += c;
  }
  if (rank < seen + h.z) return 0;
  seen += h.z;
  const posKeys = Object.keys(h.p).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < posKeys.length; i++) {
    const k = posKeys[i];
    const c = h.p[String(k)];
    if (rank < seen + c) {
      const tightHi = i === posKeys.length - 1 && clampMax !== null && clampMax !== undefined && clampMax > 0 ? clampMax : null;
      const tightLo = i === 0 && clampMin !== null && clampMin !== undefined && clampMin > 0 ? clampMin : null;
      return clamp(interp(k, h.b, (rank - seen + 0.5) / c, false, tightHi, tightLo), clampMin, clampMax);
    }
    seen += c;
  }
  return clamp(posKeys.length ? Math.pow(2, (posKeys[posKeys.length - 1] + 1) / h.b) : 0, clampMin, clampMax);
}

/** Linear position inside bin k; `tightHi`/`tightLo` replace the bin edges with exact bucket extremes. */
function interp(k: number, b: number, frac: number, descending: boolean, tightHi: number | null = null, tightLo: number | null = null): number {
  let lo = Math.pow(2, k / b);
  let hi = Math.pow(2, (k + 1) / b);
  if (tightHi !== null && tightHi >= lo && tightHi < hi) hi = tightHi;
  if (tightLo !== null && tightLo > lo && tightLo <= hi) lo = tightLo;
  return descending ? hi - (hi - lo) * frac : lo + (hi - lo) * frac;
}

function clamp(v: number, min?: number | null, max?: number | null): number {
  if (min !== null && min !== undefined && v < min) v = min;
  if (max !== null && max !== undefined && v > max) v = max;
  return v;
}
