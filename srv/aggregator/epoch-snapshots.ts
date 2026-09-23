/**
 * Stake and governance: the pool and DRep sets ODATANO stores once per epoch, copied into
 *
 *  - `EntityBuckets` at granularity `epoch` (leaderboards: pools by stake, DReps by voting
 *    power). Not rolled up, not pruned, no block height, so a reorg rewind never touches them.
 *  - `Snapshots` for the chain-wide gauges (pool count, total stake, DRep count).
 *
 * Stake is stored in ADA (see samples.ts, sumSq overflow). Blocks are the lifetime count
 * (`blocksMinted`); the source reports `blocksEpoch` as null for Koios-filled pools.
 */
import cds from '@sap/cds';
import type { Chain, EpochSnapshotSet } from '../sources/types';
import { ENTITIES } from './store';
import { iso } from './time';

const { UPSERT, SELECT } = cds.ql;

const SNAPSHOTS = 'odatano.astra.Snapshots';
const LOVELACE_PER_ADA = 1_000_000;

/** What a pool contributes to the leaderboards, per epoch. */
const POOL_METRICS = {
  'stake.live': (p: { liveStake: number }) => p.liveStake / LOVELACE_PER_ADA,
  'stake.active': (p: { activeStake: number }) => p.activeStake / LOVELACE_PER_ADA,
  'stake.blocksLifetime': (p: { blocksMinted: number }) => p.blocksMinted,
  'stake.delegators': (p: { liveDelegators: number }) => p.liveDelegators,
} as const;

const dec = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6));

/**
 * Write one epoch's snapshot set. Idempotent: the keys are (chain, dimension, entity, metric,
 * epoch), so re-ingesting the same epoch replaces rather than accumulates — unlike the block
 * deltas, which merge.
 */
export async function applyEpochSnapshots(
  tx: any,
  chain: Chain,
  set: EpochSnapshotSet,
  now = new Date().toISOString(),
): Promise<{ entities: number; gauges: number }> {
  if (!set.pools.length && !set.dreps.length) return { entities: 0, gauges: 0 };

  const rows: Record<string, unknown>[] = [];
  const at = (timeSec: number) => iso(timeSec * 1000);

  for (const p of set.pools) {
    for (const [metricId, value] of Object.entries(POOL_METRICS)) {
      rows.push({
        chain, dimension: 'pool', entityId: p.poolId, subjectId: '', metricId,
        granularity: 'epoch', bucketStart: at(p.time),
        count: 1, sum: dec(value(p)),
        fromHeight: null, toHeight: null, computedAt: now,
      });
    }
  }

  for (const d of set.dreps) {
    rows.push({
      chain, dimension: 'drep', entityId: d.drepId, subjectId: '', metricId: 'governance.votingPower',
      granularity: 'epoch', bucketStart: at(d.time),
      count: 1, sum: dec(d.amount / LOVELACE_PER_ADA),
      fromHeight: null, toHeight: null, computedAt: now,
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.run(UPSERT.into(ENTITIES).entries(rows.slice(i, i + CHUNK)));
  }

  // chain-wide gauges — one value per epoch, not a sum over a window
  const takenAt = at(set.pools[0]?.time ?? set.dreps[0]?.time ?? 0);
  const liveAda = set.pools.reduce((s, p) => s + p.liveStake, 0) / LOVELACE_PER_ADA;
  const powerAda = set.dreps.reduce((s, d) => s + d.amount, 0) / LOVELACE_PER_ADA;
  const activeDreps = set.dreps.filter(d => !d.retired && !d.expired).length;

  const gauges: Record<string, number> = {
    'stake.pools': set.pools.length,
    'stake.totalLive': liveAda,
    'governance.dreps': activeDreps,
    'governance.totalPower': powerAda,
  };
  const gaugeRows = Object.entries(gauges).map(([metricId, value]) => ({
    chain, metricId, takenAt,
    value: dec(value),
    payload: JSON.stringify({ epoch: set.epoch }),
  }));
  await tx.run(UPSERT.into(SNAPSHOTS).entries(gaugeRows));

  return { entities: rows.length, gauges: gaugeRows.length };
}

/** Highest epoch ASTRA has already copied, from its own gauge rows. */
export async function lastIngestedEpoch(db: any, chain: Chain): Promise<number | null> {
  const rows = await db.run(
    SELECT.from(SNAPSHOTS).columns('payload').where({ chain, metricId: 'stake.pools' }),
  );
  let max: number | null = null;
  for (const r of rows) {
    try {
      const e = Number(JSON.parse(String(r.payload ?? '{}')).epoch);
      if (Number.isFinite(e) && (max === null || e > max)) max = e;
    } catch { /* a payload we cannot read is not an epoch we have */ }
  }
  return max;
}
