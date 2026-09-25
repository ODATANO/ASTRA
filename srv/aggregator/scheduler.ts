/**
 * Poll loop: one ChainAggregator per configured source, started on `served`.
 *
 * There is no event hook into the source crawlers (they run in other
 * containers), so ASTRA polls their SyncState every `pollMs`. That query is a
 * single-row primary-key read – cheap enough for a 10 s cadence – and while
 * backfilling, cycles run back to back until caught up.
 */
import cds from '@sap/cds';
import type { Chain, ChainSource } from '../sources/types';
import { configuredChains, openChainSource, reopenChainSource } from '../sources';
import { ChainAggregator } from './engine';

export interface AstraConfig {
  pollMs: number;
  chunkBlocks: number;
  startTime: string;
  retention: { minuteHours: number; hourDays: number };
  cycleBudgetMs?: number;
  /**
   * A cycle that has not returned after this long is given up: its error is
   * recorded on the cursor, the source connection is reopened and the chain is
   * rescheduled. Default: six budgets, at least two minutes. Guards against a
   * source connection that stops answering.
   */
  cycleTimeoutMs?: number;
}

export function astraConfig(): AstraConfig {
  const c = ((cds.env as any).astra || {}) as Partial<AstraConfig>;
  const env = process.env;
  return {
    pollMs: Number(env.ASTRA_POLL_MS || c.pollMs || 10000),
    chunkBlocks: Number(env.ASTRA_CHUNK_BLOCKS || c.chunkBlocks || 200),
    startTime: String(env.ASTRA_START_TIME || c.startTime || '2026-01-01T00:00:00Z'),
    retention: {
      minuteHours: Number(env.ASTRA_RETENTION_MINUTE_HOURS || c.retention?.minuteHours || 48),
      hourDays: Number(env.ASTRA_RETENTION_HOUR_DAYS || c.retention?.hourDays || 90),
    },
    cycleBudgetMs: Number(env.ASTRA_CYCLE_BUDGET_MS || c.cycleBudgetMs || 20000),
    cycleTimeoutMs: Number(env.ASTRA_CYCLE_TIMEOUT_MS || c.cycleTimeoutMs || 0) || undefined,
  };
}

/** The effective give-up time for one cycle. */
export function cycleTimeoutMs(cfg: Pick<AstraConfig, 'cycleBudgetMs' | 'cycleTimeoutMs'>): number {
  return cfg.cycleTimeoutMs ?? Math.max(120_000, (cfg.cycleBudgetMs ?? 20000) * 6);
}

export class CycleTimeoutError extends Error {
  constructor(readonly chain: Chain, readonly afterMs: number) {
    super(`[${chain}] cycle did not return within ${afterMs} ms`);
    this.name = 'CycleTimeoutError';
  }
}

/** Resolves with the cycle's result, or rejects with CycleTimeoutError once `timeoutMs` passed without one. */
export function withCycleTimeout<T>(chain: Chain, cycle: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new CycleTimeoutError(chain, timeoutMs)), timeoutMs);
    t.unref?.();
    cycle.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const LOG = cds.log('astra');
const aggregators = new Map<Chain, ChainAggregator>();
const timers = new Map<Chain, NodeJS.Timeout>();
let stopping = false;

export function getAggregator(chain: Chain): ChainAggregator | undefined {
  return aggregators.get(chain);
}

/** The read-only source behind a chain's aggregator, for callers that need the raw tables. */
export function getSource(chain: Chain): ChainSource | undefined {
  return aggregators.get(chain)?.source;
}

export function activeChains(): Chain[] {
  return [...aggregators.keys()];
}

export async function startScheduler(cfg = astraConfig()): Promise<Chain[]> {
  stopping = false;
  const chains = configuredChains();
  if (!chains.length) {
    LOG.warn('no chain sources configured – set ASTRA_CARDANO_DB_URL / ASTRA_MIDNIGHT_DB_URL or cds.astra.sources');
    return [];
  }
  for (const chain of chains) {
    try {
      const source = await openChainSource(chain);
      const agg = new ChainAggregator(chain, source, {
        chunkBlocks: cfg.chunkBlocks,
        startTime: cfg.startTime,
        leaseMs: Math.max(60000, cfg.pollMs * 6),
        retention: cfg.retention,
        log: LOG,
      });
      aggregators.set(chain, agg);
      schedule(chain, 0, cfg);
      LOG.info(`[${chain}] aggregator scheduled (poll ${cfg.pollMs} ms, chunk ${cfg.chunkBlocks} blocks, from ${cfg.startTime})`);
    } catch (e: any) {
      LOG.error(`[${chain}] source unavailable: ${e?.message ?? e}`);
    }
  }
  return [...aggregators.keys()];
}

function schedule(chain: Chain, delayMs: number, cfg: AstraConfig): void {
  if (stopping) return;
  const t = setTimeout(() => void tick(chain, cfg), delayMs);
  t.unref?.();
  timers.set(chain, t);
}

let inFlight = new Map<Chain, Promise<unknown>>();

async function tick(chain: Chain, cfg: AstraConfig): Promise<void> {
  const agg = aggregators.get(chain);
  if (!agg || stopping) return;
  let delay = cfg.pollMs;
  const run = (async () => {
    const cycle = agg.runCycle(cfg.cycleBudgetMs);
    cycle.catch(() => undefined); // an abandoned cycle's late rejection is reported where it happened
    try {
      const r = await withCycleTimeout(chain, cycle, cycleTimeoutMs(cfg));
      if (r.skipped === 'no-lease') delay = cfg.pollMs * 3;
      else if (!r.caughtUp && !r.skipped) delay = 50; // backfilling: keep going
      if (r.chunks) LOG.info(`[${chain}] +${r.blocks} blocks, +${r.txs} tx (${r.fromHeight}..${r.toHeight}) in ${r.ms} ms${r.caughtUp ? '' : ' – backfilling'}${r.reorgs ? `, ${r.reorgs} reorg(s)` : ''}`);
    } catch (e) {
      delay = Math.min(cfg.pollMs * 6, 60000);
      if (e instanceof CycleTimeoutError) {
        // The cycle is still "running" on a connection that does not answer. Fence it off,
        // say so on the cursor, and read through a fresh connection next time.
        agg.abandonCycle();
        LOG.error(`${e.message}; abandoning it and reopening the ${chain} source`);
        await agg.noteFailure(e.message);
        try {
          agg.replaceSource(await reopenChainSource(chain));
        } catch (re: any) {
          LOG.error(`[${chain}] source could not be reopened: ${re?.message ?? re}`);
        }
      }
    }
  })();
  inFlight.set(chain, run);
  await run;
  inFlight.delete(chain);
  schedule(chain, delay, cfg);
}

/** Runs one cycle for a chain right away (admin action). */
export async function runNow(chain: Chain): Promise<void> {
  const agg = aggregators.get(chain);
  if (!agg) throw new Error(`chain '${chain}' has no active aggregator`);
  const pending = inFlight.get(chain);
  if (pending) await pending.catch(() => undefined);
  await agg.runCycle(astraConfig().cycleBudgetMs);
}

export async function stopScheduler(): Promise<void> {
  stopping = true;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  await Promise.allSettled([...inFlight.values()]);
  for (const agg of aggregators.values()) await agg.releaseLease().catch(() => undefined);
  aggregators.clear();
}
