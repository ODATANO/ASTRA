import { describe, expect, it } from 'vitest';
import { addSample, emptyHistogram, mergeInto, parseHistogram, quantile, serializeHistogram, totalCount } from '../srv/aggregator/histogram';

describe('histogram', () => {
  it('estimates median and p95 within the bin tolerance', () => {
    const h = emptyHistogram();
    const values: number[] = [];
    for (let i = 1; i <= 1000; i++) { values.push(i * 1000); addSample(h, i * 1000); }
    expect(totalCount(h)).toBe(1000);
    const p50 = quantile(h, 0.5)!;
    const p95 = quantile(h, 0.95)!;
    expect(Math.abs(p50 - 500_000) / 500_000).toBeLessThan(0.05);
    expect(Math.abs(p95 - 950_000) / 950_000).toBeLessThan(0.05);
  });

  it('clamps to exact min/max and handles zeros and negatives', () => {
    const h = emptyHistogram();
    for (const v of [-50, -10, 0, 0, 3, 7, 100]) addSample(h, v);
    expect(quantile(h, 0, -50, 100)).toBe(-50);
    expect(quantile(h, 1, -50, 100)).toBe(100);
    expect(quantile(h, 0.5)).toBe(0);
  });

  it('merges exactly and survives JSON round trips', () => {
    const a = emptyHistogram(), b = emptyHistogram();
    for (const v of [1, 2, 4, 8]) addSample(a, v);
    for (const v of [16, 32, 0, -4]) addSample(b, v);
    const merged = mergeInto(parseHistogram(serializeHistogram(a))!, parseHistogram(serializeHistogram(b)));
    expect(totalCount(merged)).toBe(8);
    expect(merged.z).toBe(1);
    expect(Object.values(merged.m).reduce((x, y) => x + y, 0)).toBe(1);
  });
});
