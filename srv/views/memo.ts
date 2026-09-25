/**
 * Memo for the computed views: one computation per key for `ASTRA_VIEW_CACHE_MS`
 * (default 5 s, 0 = off); readers that arrive while it runs share the promise.
 * A failed computation is not kept.
 */

interface Entry<T> { promise: Promise<T>; until: number }

export class ViewMemo {
  private entries = new Map<string, Entry<unknown>>();

  constructor(private readonly ttlMs: () => number, private readonly now: () => number = Date.now) {}

  async get<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const ttl = this.ttlMs();
    if (!(ttl > 0)) return compute();
    const hit = this.entries.get(key) as Entry<T> | undefined;
    if (hit && hit.until > this.now()) return hit.promise;
    const entry: Entry<T> = { promise: compute(), until: Number.POSITIVE_INFINITY };
    this.entries.set(key, entry);
    try {
      const value = await entry.promise;
      entry.until = this.now() + ttl;
      return value;
    } catch (err) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw err;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const viewMemo = new ViewMemo(() => {
  const raw = process.env.ASTRA_VIEW_CACHE_MS;
  const n = raw === undefined || raw === '' ? 5000 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
});
