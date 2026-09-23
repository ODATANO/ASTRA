/**
 * ChainAggregator – incremental, reorg-aware aggregation of one chain.
 *
 * Cycle:
 *   1. read the source crawler's cursor (tip)
 *   2. apply reorgs the source logged since the last cycle (rewind + recompute)
 *   3. on first run: find the start height (configured startTime, bounded by the
 *      range the source crawler actually owns)
 *   4. walk forward in chunks of `chunkBlocks`: fetch blocks + transactions of
 *      the height range, compute minute deltas, merge + roll up, advance cursor –
 *      one ASTRA transaction per chunk
 *   5. stop when caught up or when the time budget is spent; the scheduler calls again
 *
 * The cursor row (odatano.astra.ChainCursors) is the only state. Every bucket
 * carries fromHeight/toHeight, so a rewind can always find its resume point.
 */
import cds from '@sap/cds';
import type { Chain, ChainSource, ReorgRow } from '../sources/types';
import { computeAddressDeltas, computeAssetDeltas, computeDeltas, type EntityDeltaMap } from './samples';
import { applyDeltas, applyEntityDeltas, dropBuckets, prune, rewindTo, rollupEntityDays } from './store';
import { bucketStart } from './time';
import { applyEpochSnapshots, lastIngestedEpoch } from './epoch-snapshots';
import { lastVerification, verifySample } from '../verification/sampling';

const { SELECT, UPSERT, UPDATE } = cds.ql;
const CURSORS = 'odatano.astra.ChainCursors';
const REORGS = 'odatano.astra.Reorgs';

export interface AggregatorOptions {
  chunkBlocks: number;
  /** ISO time from which history is aggregated (only used when the cursor is new). */
  startTime: string;
  leaseMs: number;
  retention: { minuteHours: number; hourDays: number };
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void };
}

export interface Cursor {
  chain: Chain;
  network: string | null;
  startHeight: number | null;
  lastHeight: number | null;
  lastBlockTime: number | null;
  lastReorgDetectedAt: string | null;
  sourceTipHeight: number | null;
  sourceChainHeight: number | null;
  sourceSyncStatus: string | null;
  sourceLastIndexedAt: string | null;
  backfilling: boolean;
  lastRunAt: string | null;
  lastRunMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
}

export interface CycleResult {
  chain: Chain;
  skipped?: 'no-lease' | 'no-source-state';
  reorgs: number;
  chunks: number;
  blocks: number;
  txs: number;
  fromHeight: number | null;
  toHeight: number | null;
  caughtUp: boolean;
  ms: number;
}

const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export class ChainAggregator {
  readonly owner = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private cycles = 0;

  constructor(
    readonly chain: Chain,
    readonly source: ChainSource,
    private readonly opts: AggregatorOptions,
  ) {}

  private get log() {
    return this.opts.log ?? cds.log('astra');
  }

  /**
   * Every statement runs in its own root transaction. The engine must never bind
   * to an ambient request transaction: with SQLite's single pooled connection a
   * nested cds.tx would wait forever for the connection the request holds, and
   * on Postgres the request tx would keep row locks on the cursor row.
   */
  private run(query: unknown): Promise<any> {
    return (cds as any).tx((tx: any) => tx.run(query));
  }

  // ---------------------------------------------------------------- cursor

  async getCursor(): Promise<Cursor | null> {
    const r = await this.run(SELECT.one.from(CURSORS).where({ chain: this.chain }));
    if (!r) return null;
    return {
      chain: r.chain,
      network: r.network ?? null,
      startHeight: n(r.startHeight), lastHeight: n(r.lastHeight), lastBlockTime: n(r.lastBlockTime),
      lastReorgDetectedAt: r.lastReorgDetectedAt ?? null,
      sourceTipHeight: n(r.sourceTipHeight), sourceChainHeight: n(r.sourceChainHeight),
      sourceSyncStatus: r.sourceSyncStatus ?? null, sourceLastIndexedAt: r.sourceLastIndexedAt ?? null,
      backfilling: !!r.backfilling, lastRunAt: r.lastRunAt ?? null, lastRunMs: n(r.lastRunMs),
      lastError: r.lastError ?? null, lastErrorAt: r.lastErrorAt ?? null,
      leaseOwner: r.leaseOwner ?? null, leaseUntil: r.leaseUntil ?? null,
    };
  }

  private async ensureCursor(): Promise<Cursor> {
    const c = await this.getCursor();
    if (c) return c;
    await this.run(UPSERT.into(CURSORS).entries({ chain: this.chain, backfilling: true }));
    return (await this.getCursor())!;
  }

  /** Single-writer lease: only one process aggregates a chain at a time. */
  private async acquireLease(): Promise<boolean> {
    await this.ensureCursor();
    const now = new Date();
    const until = new Date(now.getTime() + this.opts.leaseMs).toISOString();
    const nowIso = now.toISOString();
    const q: any = UPDATE.entity(CURSORS).set({ leaseOwner: this.owner, leaseUntil: until });
    q.where`chain = ${this.chain} and (leaseUntil is null or leaseUntil < ${nowIso} or leaseOwner = ${this.owner})`;
    const affected = await this.run(q);
    return Number(affected) > 0;
  }

  private async renewLease(tx: any): Promise<void> {
    const until = new Date(Date.now() + this.opts.leaseMs).toISOString();
    await tx.run(UPDATE.entity(CURSORS).set({ leaseUntil: until }).where({ chain: this.chain, leaseOwner: this.owner }));
  }

  async releaseLease(): Promise<void> {
    await this.run(UPDATE.entity(CURSORS).set({ leaseOwner: null, leaseUntil: null }).where({ chain: this.chain, leaseOwner: this.owner }));
  }

  private async patchCursor(tx: any | null, patch: Record<string, unknown>): Promise<void> {
    const q = UPDATE.entity(CURSORS).set(patch).where({ chain: this.chain });
    await (tx ? tx.run(q) : this.run(q));
  }

  // ---------------------------------------------------------------- cycle

  async runCycle(budgetMs = 8000): Promise<CycleResult> {
    const t0 = Date.now();
    const result: CycleResult = { chain: this.chain, reorgs: 0, chunks: 0, blocks: 0, txs: 0, fromHeight: null, toHeight: null, caughtUp: false, ms: 0 };
    if (!(await this.acquireLease())) {
      result.skipped = 'no-lease';
      result.ms = Date.now() - t0;
      return result;
    }
    try {
      const tip = await this.source.getTip();
      if (!tip) {
        await this.patchCursor(null, { lastError: 'source has no sync state yet', lastErrorAt: new Date().toISOString(), lastRunAt: new Date().toISOString() });
        result.skipped = 'no-source-state';
        return result;
      }
      await this.patchCursor(null, {
        network: tip.network ?? null,
        sourceTipHeight: tip.height, sourceChainHeight: tip.chainHeight ?? null,
        sourceSyncStatus: tip.syncStatus ?? null, sourceLastIndexedAt: tip.lastIndexedAt ?? null,
      });

      let cursor = await this.ensureCursor();
      result.reorgs = await this.applyReorgs(cursor);
      cursor = await this.ensureCursor();

      if (cursor.startHeight === null || cursor.lastHeight === null) {
        const start = await this.resolveStartHeight(tip.height);
        if (start === null) {
          await this.patchCursor(null, { lastError: 'source has no blocks at or after startTime yet', lastErrorAt: new Date().toISOString(), lastRunAt: new Date().toISOString() });
          result.skipped = 'no-source-state';
          return result;
        }
        await this.patchCursor(null, { startHeight: start, lastHeight: start - 1, lastBlockTime: null });
        cursor = await this.ensureCursor();
        this.log.info(`[${this.chain}] start height ${start} (startTime ${this.opts.startTime})`);
      }

      let last = cursor.lastHeight!;
      let prevTime = cursor.lastBlockTime;
      result.fromHeight = last + 1;
      // Days whose entity hours changed in this cycle; rolled up once at the end rather than
      // per chunk, so a backfill does not re-read a whole day of leaderboard rows thousands of times.
      const touchedDays = new Set<number>();
      while (last < tip.height && Date.now() - t0 < budgetMs) {
        const from = last + 1;
        const to = Math.min(tip.height, from + this.opts.chunkBlocks - 1);
        const [blocks, txs, moves, addressMoves] = await Promise.all([
          this.source.getBlocks(from, to),
          this.source.getTransactions(from, to),
          this.source.getAssetMovements ? this.source.getAssetMovements(from, to) : Promise.resolve([]),
          this.source.getAddressActivity ? this.source.getAddressActivity(from, to) : Promise.resolve([]),
        ]);
        const entities: EntityDeltaMap = new Map();
        const { deltas, lastBlockTime } = computeDeltas(blocks, txs, { chain: this.chain, prevBlockTime: prevTime }, entities);
        if (moves.length) computeAssetDeltas(moves, deltas, entities);
        if (addressMoves.length) computeAddressDeltas(addressMoves, deltas, entities);
        for (const e of entities.values()) touchedDays.add(bucketStart(e.bucketStart, 'day'));
        const now = new Date().toISOString();
        await cds.tx(async tx => {
          await applyDeltas(tx, this.chain, deltas, now);
          await applyEntityDeltas(tx, this.chain, entities, now);
          await this.patchCursor(tx, {
            lastHeight: to,
            lastBlockTime: lastBlockTime ?? prevTime,
            backfilling: tip.height - to > this.opts.chunkBlocks,
            lastRunAt: now, lastError: null, lastErrorAt: null,
          });
          await this.renewLease(tx);
        });
        last = to;
        prevTime = lastBlockTime ?? prevTime;
        result.chunks++;
        result.blocks += blocks.length;
        result.txs += txs.length;
        result.toHeight = to;
        if (blocks.length === 0 && to < tip.height) this.log.debug?.(`[${this.chain}] no blocks in ${from}..${to} (gap in source)`);
      }
      if (touchedDays.size) {
        await cds.tx(tx => rollupEntityDays(tx, this.chain, [...touchedDays]));
      }
      await this.ingestEpochSnapshots();
      await this.maybeVerify();
      result.caughtUp = last >= tip.height;
      if (result.chunks === 0) result.fromHeight = null;

      this.cycles++;
      if (this.cycles % 30 === 1) {
        await cds.tx(tx => prune(tx, this.chain, this.opts.retention.minuteHours, this.opts.retention.hourDays));
      }
      result.ms = Date.now() - t0;
      await this.patchCursor(null, { lastRunAt: new Date().toISOString(), lastRunMs: result.ms, backfilling: !result.caughtUp });
      return result;
    } catch (e: any) {
      result.ms = Date.now() - t0;
      const msg = String(e?.message ?? e).slice(0, 500);
      this.log.warn(`[${this.chain}] cycle failed: ${msg}`);
      await this.run(UPDATE.entity(CURSORS).set({ lastError: msg, lastErrorAt: new Date().toISOString(), lastRunAt: new Date().toISOString(), lastRunMs: result.ms }).where({ chain: this.chain })).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Spot-check the index against an independent public indexer every `verifyIntervalMs`
   * (wall clock; 0 = off). A failure is logged and stored with the run, never stops aggregation.
   */
  private async maybeVerify(): Promise<void> {
    const intervalMs = Number(process.env.ASTRA_VERIFY_INTERVAL_MS ?? 6 * 3600_000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    try {
      const last = await lastVerification(cds.db, this.chain);
      const lastMs = last?.ranAt ? Date.parse(String(last.ranAt)) : 0;
      if (Number.isFinite(lastMs) && Date.now() - lastMs < intervalMs) return;

      const tip = await this.source.getTip();
      if (!tip?.network) return;   // nothing to compare against without knowing the network
      const samples = Number(process.env.ASTRA_VERIFY_SAMPLES ?? 100);
      const r = await verifySample(cds.db, this.source, this.chain, tip.network, samples);
      if (r.error) this.log.warn(`[${this.chain}] verification skipped: ${r.error}`);
      else if (r.mismatches.length) {
        this.log.warn(`[${this.chain}] verification: ${r.mismatches.length} of ${r.checked} blocks disagree with ${r.reference}`);
      } else {
        this.log.info(`[${this.chain}] verification: ${r.checked} blocks agree with ${r.reference}`);
      }
    } catch (e) {
      this.log.warn(`[${this.chain}] verification failed:`, e);
    }
  }

  /**
   * Copy any epoch snapshot the source has that we do not: one max(epoch) read per cycle, the
   * full set only when a new epoch appeared. A source without snapshots skips; a failure is
   * logged and never stops block aggregation.
   */
  private async ingestEpochSnapshots(): Promise<void> {
    if (!this.source.getLatestSnapshotEpoch || !this.source.getEpochSnapshots) return;
    try {
      const available = await this.source.getLatestSnapshotEpoch();
      if (available === null) return;
      const have = await lastIngestedEpoch(cds.db, this.chain);
      if (have !== null && have >= available) return;

      const set = await this.source.getEpochSnapshots(available);
      if (!set.pools.length && !set.dreps.length) return;
      const written = await (cds as any).tx((tx: any) => applyEpochSnapshots(tx, this.chain, set));
      this.log.info(
        `[${this.chain}] epoch ${available} snapshot: ${set.pools.length} pools, ${set.dreps.length} dreps ` +
        `(${written.entities} leaderboard rows, ${written.gauges} gauges)`,
      );
    } catch (e) {
      this.log.warn(`[${this.chain}] epoch snapshot ingest failed:`, e);
    }
  }

  private async resolveStartHeight(tipHeight: number): Promise<number | null> {
    const startSec = Math.floor(Date.parse(this.opts.startTime) / 1000);
    const [atTime, crawlStart] = await Promise.all([
      this.source.findFirstHeightAt(startSec),
      this.source.getCrawlStartHeight(),
    ]);
    if (atTime === null && crawlStart === null) return null;
    const start = Math.max(atTime ?? 0, crawlStart ?? 0);
    return start > tipHeight ? null : start;
  }

  // ---------------------------------------------------------------- reorgs

  private async applyReorgs(cursor: Cursor): Promise<number> {
    const reorgs = await this.source.getReorgsAfter(cursor.lastReorgDetectedAt);
    if (!reorgs.length) return 0;
    let handled = 0;
    for (const r of reorgs) {
      await this.handleReorg(cursor, r);
      handled++;
      cursor = (await this.getCursor()) ?? cursor;
    }
    return handled;
  }

  private async handleReorg(cursor: Cursor, r: ReorgRow): Promise<void> {
    let fork = r.forkHeight;
    if (fork === null && r.forkSlot !== null && r.forkSlot !== undefined && this.source.heightAtSlot) {
      fork = await this.source.heightAtSlot(r.forkSlot);
    }
    const now = new Date().toISOString();
    // Nothing aggregated above the fork yet → just record it.
    if (cursor.lastHeight === null || (fork !== null && fork >= cursor.lastHeight)) {
      await cds.tx(async tx => {
        await tx.run(UPSERT.into(REORGS).entries({ chain: this.chain, sourceId: r.id, detectedAt: r.detectedAt, forkHeight: fork, blocksRolledBack: r.blocksRolledBack ?? null, status: r.status ?? null, recomputedFromHeight: null, handledAt: now }));
        await this.patchCursor(tx, { lastReorgDetectedAt: r.detectedAt });
      });
      return;
    }
    await cds.tx(async tx => {
      let resumeFrom: number;
      if (fork === null) {
        // Unknown fork point: recompute everything for this chain.
        await dropBuckets(tx, this.chain, null);
        resumeFrom = cursor.startHeight ?? 0;
        this.log.warn(`[${this.chain}] reorg ${r.id} without fork height – full recompute from ${resumeFrom}`);
      } else {
        const res = await rewindTo(tx, this.chain, fork, now);
        resumeFrom = Math.max(cursor.startHeight ?? 0, res.resumeFrom);
        this.log.info(`[${this.chain}] reorg ${r.id} at fork ${fork}: dropped ${res.dropped} minute buckets, resuming from ${resumeFrom}`);
      }
      const prevBlocks = resumeFrom > 0 ? await this.source.getBlocks(resumeFrom - 1, resumeFrom - 1) : [];
      await tx.run(UPSERT.into(REORGS).entries({ chain: this.chain, sourceId: r.id, detectedAt: r.detectedAt, forkHeight: fork, blocksRolledBack: r.blocksRolledBack ?? null, status: r.status ?? null, recomputedFromHeight: resumeFrom, handledAt: now }));
      await this.patchCursor(tx, {
        lastHeight: resumeFrom - 1,
        lastBlockTime: prevBlocks[0]?.time ?? null,
        lastReorgDetectedAt: r.detectedAt,
        backfilling: true,
      });
    });
  }

  // ---------------------------------------------------------------- admin

  /** Drops aggregates from `fromHeight` (null = all) and rewinds the cursor; the next cycle recomputes. */
  async recompute(fromHeight: number | null): Promise<void> {
    const cursor = await this.ensureCursor();
    await cds.tx(async tx => {
      if (fromHeight === null || cursor.startHeight === null || fromHeight <= cursor.startHeight) {
        await dropBuckets(tx, this.chain, null);
        await this.patchCursor(tx, { startHeight: null, lastHeight: null, lastBlockTime: null, backfilling: true, lastError: null, lastErrorAt: null });
        return;
      }
      const res = await rewindTo(tx, this.chain, fromHeight - 1);
      const resumeFrom = Math.max(cursor.startHeight, res.resumeFrom);
      const prev = await this.source.getBlocks(resumeFrom - 1, resumeFrom - 1);
      await this.patchCursor(tx, { lastHeight: resumeFrom - 1, lastBlockTime: prev[0]?.time ?? null, backfilling: true, lastError: null, lastErrorAt: null });
    });
  }
}

