import { describe, expect, it } from 'vitest';
import { ViewMemo } from '../srv/views/memo';

function harness(ttl: number) {
  let now = 1_000_000;
  let calls = 0;
  const memo = new ViewMemo(() => ttl, () => now);
  const compute = async () => { calls++; return { at: now, n: calls }; };
  return { memo, compute, calls: () => calls, tick: (ms: number) => { now += ms; } };
}

describe('ViewMemo', () => {
  it('computes once per key until the ttl passes', async () => {
    const h = harness(5000);
    const a = await h.memo.get('k', h.compute);
    const b = await h.memo.get('k', h.compute);
    expect(b).toBe(a);
    expect(h.calls()).toBe(1);
    h.tick(5001);
    const c = await h.memo.get('k', h.compute);
    expect(c).not.toBe(a);
    expect(h.calls()).toBe(2);
  });

  it('concurrent readers share one in-flight computation', async () => {
    const h = harness(5000);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0;
    const slow = async () => { calls++; await gate; return calls; };
    const all = Promise.all(Array.from({ length: 25 }, () => h.memo.get('k', slow)));
    release();
    expect(await all).toEqual(Array(25).fill(1));
    expect(calls).toBe(1);
  });

  it('keys are independent', async () => {
    const h = harness(5000);
    await h.memo.get('a', h.compute);
    await h.memo.get('b', h.compute);
    expect(h.calls()).toBe(2);
    expect(h.memo.size).toBe(2);
  });

  it('is a plain call when the ttl is 0', async () => {
    const h = harness(0);
    await h.memo.get('k', h.compute);
    await h.memo.get('k', h.compute);
    expect(h.calls()).toBe(2);
    expect(h.memo.size).toBe(0);
  });

  it('does not keep a failed computation', async () => {
    const h = harness(5000);
    let n = 0;
    const flaky = async () => { n++; if (n === 1) throw new Error('boom'); return n; };
    await expect(h.memo.get('k', flaky)).rejects.toThrow('boom');
    expect(await h.memo.get('k', flaky)).toBe(2);
    expect(h.memo.size).toBe(1);
  });

  it('clear() forgets everything', async () => {
    const h = harness(5000);
    await h.memo.get('k', h.compute);
    h.memo.clear();
    await h.memo.get('k', h.compute);
    expect(h.calls()).toBe(2);
  });
});
