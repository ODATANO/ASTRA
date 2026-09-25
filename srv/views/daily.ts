/**
 * Ready-made daily views: one row per chain and day with named columns, so a consumer asks for
 * "blocks per day" instead of learning metric ids. Every column is a statistic over one metric's
 * day bucket; the table below is the whole definition, adding a column is adding a line.
 *
 * A chain that lacks a metric (Midnight has no block size, Cardano no shielded transactions)
 * gets null in that column and keeps the row, so both chains stay in one entity set and can be
 * put side by side.
 *
 * Gauges (pools, stake, DReps) are not daily: they are the state of an epoch and live in
 * `Snapshots`, read here as `StakeEpochs`.
 */
import cds from '@sap/cds';
import type { Chain } from '../sources/types';
import { quantile } from '../aggregator/histogram';
import { mergeRow, newMerged, readBuckets, type BucketRow } from '../aggregator/store';
import { GRAN_MS } from '../aggregator/time';
import { getMetric } from '../aggregator/windows';

const { SELECT } = cds.ql;

export type Stat = 'sum' | 'count' | 'avg' | 'p50' | 'p95' | 'min' | 'max';

export interface ViewColumn { name: string; metric: string; stat: Stat }

export interface DailyView {
  columns: ViewColumn[];
  /** Columns that carry a metric's unit (`feeUnit` -> unit of `fees.paid` on that chain). */
  units?: Record<string, string>;
}

export const DAILY_VIEWS: Record<string, DailyView> = {
  BlocksDaily: {
    columns: [
      { name: 'blocks', metric: 'blocks.count', stat: 'sum' },
      { name: 'emptyBlocks', metric: 'blocks.empty', stat: 'sum' },
      { name: 'avgBlockTimeSec', metric: 'blocks.interval', stat: 'avg' },
      { name: 'p95BlockTimeSec', metric: 'blocks.interval', stat: 'p95' },
      { name: 'maxBlockTimeSec', metric: 'blocks.interval', stat: 'max' },
      { name: 'avgBlockSizeBytes', metric: 'blocks.size', stat: 'avg' },
      { name: 'maxBlockSizeBytes', metric: 'blocks.size', stat: 'max' },
      { name: 'avgTxPerBlock', metric: 'blocks.txCount', stat: 'avg' },
      { name: 'maxTxPerBlock', metric: 'blocks.txCount', stat: 'max' },
    ],
  },
  TransactionsDaily: {
    columns: [
      { name: 'transactions', metric: 'tx.count', stat: 'sum' },
      { name: 'withAssets', metric: 'tx.withAssets', stat: 'sum' },
      { name: 'withMetadata', metric: 'tx.withMetadata', stat: 'sum' },
      { name: 'utxosCreated', metric: 'utxo.created', stat: 'sum' },
      { name: 'utxosSpent', metric: 'utxo.spent', stat: 'sum' },
      { name: 'volume', metric: 'value.transferred', stat: 'sum' },
      { name: 'avgTxSizeBytes', metric: 'tx.size', stat: 'avg' },
      { name: 'systemExtrinsics', metric: 'tx.system', stat: 'sum' },
      { name: 'shielded', metric: 'tx.shielded', stat: 'sum' },
      { name: 'withProof', metric: 'tx.withProof', stat: 'sum' },
      { name: 'contractCalls', metric: 'tx.contractCalls', stat: 'sum' },
      { name: 'contractDeploys', metric: 'tx.contractDeploys', stat: 'sum' },
      { name: 'failed', metric: 'tx.failed', stat: 'sum' },
    ],
    units: { volumeUnit: 'value.transferred' },
  },
  FeesDaily: {
    columns: [
      { name: 'totalFees', metric: 'fees.paid', stat: 'sum' },
      { name: 'feePayingTx', metric: 'fees.paid', stat: 'count' },
      { name: 'avgFee', metric: 'fees.paid', stat: 'avg' },
      { name: 'medianFee', metric: 'fees.paid', stat: 'p50' },
      { name: 'p95Fee', metric: 'fees.paid', stat: 'p95' },
      { name: 'maxFee', metric: 'fees.paid', stat: 'max' },
      { name: 'totalEstimatedFees', metric: 'fees.estimated', stat: 'sum' },
      { name: 'avgEstimateError', metric: 'fees.estimateError', stat: 'avg' },
    ],
    units: { feeUnit: 'fees.paid' },
  },
  TokensDaily: {
    columns: [
      { name: 'transfers', metric: 'tokens.transfers', stat: 'sum' },
      { name: 'mints', metric: 'tokens.mints', stat: 'sum' },
      { name: 'burns', metric: 'tokens.burns', stat: 'sum' },
    ],
  },
  StakeDaily: {
    columns: [
      { name: 'stakeRegistrations', metric: 'certs.stakeRegistrations', stat: 'sum' },
      { name: 'stakeDeregistrations', metric: 'certs.stakeDeregistrations', stat: 'sum' },
      { name: 'poolDelegations', metric: 'certs.poolDelegations', stat: 'sum' },
      { name: 'voteDelegations', metric: 'certs.voteDelegations', stat: 'sum' },
      { name: 'poolRegistrations', metric: 'certs.poolRegistrations', stat: 'sum' },
      { name: 'poolRetirements', metric: 'certs.poolRetirements', stat: 'sum' },
      { name: 'drepRegistrations', metric: 'certs.drepRegistrations', stat: 'sum' },
      { name: 'drepRetirements', metric: 'certs.drepRetirements', stat: 'sum' },
      { name: 'otherCertificates', metric: 'certs.other', stat: 'sum' },
      { name: 'withdrawals', metric: 'withdrawals.count', stat: 'sum' },
      { name: 'withdrawnAda', metric: 'withdrawals.value', stat: 'sum' },
    ],
  },
};

export interface DailyRow extends Record<string, unknown> {
  chain: Chain;
  /** Calendar day (UTC) as `YYYY-MM-DD`. */
  day: string;
  fromHeight: number | null;
  toHeight: number | null;
}

const round = (v: number | null, digits = 6): number | null => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

function stat(r: BucketRow, s: Stat): number | null {
  if (r.count === 0) return s === 'count' || s === 'sum' ? 0 : null;
  switch (s) {
    case 'sum': return r.sum;
    case 'count': return r.count;
    case 'avg': return r.sum / r.count;
    case 'min': return r.min;
    case 'max': return r.max;
    case 'p50': case 'p95': {
      const m = mergeRow(newMerged(), r);
      return quantile(m.hist, s === 'p50' ? 0.5 : 0.95, r.min, r.max);
    }
  }
}

export const dayOf = (bucketStart: string): string => bucketStart.slice(0, 10);

/**
 * Rows of one daily view for the given chains and day range (`fromDay` inclusive, `toDay`
 * inclusive, both `YYYY-MM-DD`; open when omitted). A day appears when at least one of the
 * view's metrics has a bucket for it.
 */
export async function readDailyView(db: any, view: string, chains: Chain[], fromDay?: string | null, toDay?: string | null, now = Date.now()): Promise<DailyRow[]> {
  const def = DAILY_VIEWS[view];
  if (!def) throw new Error(`no daily view '${view}'`);
  const metrics = [...new Set(def.columns.map(c => c.metric))];
  const fromMs = fromDay ? Date.parse(fromDay.slice(0, 10) + 'T00:00:00Z') : 0;
  const toMs = toDay ? Date.parse(toDay.slice(0, 10) + 'T00:00:00Z') + GRAN_MS.day : now + GRAN_MS.day;
  const out: DailyRow[] = [];
  for (const chain of chains) {
    const rows = await readBuckets(db, chain, 'day', fromMs, toMs, metrics);
    if (!rows.length) continue;
    const units: Record<string, string | null> = {};
    for (const [col, metric] of Object.entries(def.units ?? {})) units[col] = (await getMetric(db, chain, metric))?.unit ?? null;
    const byDay = new Map<string, BucketRow[]>();
    for (const r of rows) {
      const d = dayOf(r.bucketStart);
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
    for (const [day, dayRows] of byDay) {
      const row: DailyRow = { chain, day, fromHeight: null, toHeight: null };
      for (const c of def.columns) {
        const r = dayRows.find(x => x.metricId === c.metric);
        row[c.name] = r ? round(stat(r, c.stat)) : null;
      }
      Object.assign(row, units);
      for (const r of dayRows) {
        if (r.fromHeight !== null && (row.fromHeight === null || r.fromHeight < row.fromHeight)) row.fromHeight = r.fromHeight;
        if (r.toHeight !== null && (row.toHeight === null || r.toHeight > row.toHeight)) row.toHeight = r.toHeight;
      }
      out.push(row);
    }
  }
  return out;
}

// ---------------------------------------------------------------- epochs

/** The chain-wide gauges of an epoch snapshot, one row per chain and epoch. */
export const EPOCH_GAUGES: Record<string, string> = {
  pools: 'stake.pools',
  totalLiveStakeAda: 'stake.totalLive',
  activeDreps: 'governance.dreps',
  totalVotingPowerAda: 'governance.totalPower',
};

export interface EpochRow extends Record<string, unknown> {
  chain: Chain;
  epoch: number;
  takenAt: string | null;
}

export async function readStakeEpochs(db: any, chains: Chain[]): Promise<EpochRow[]> {
  const out: EpochRow[] = [];
  for (const chain of chains) {
    const rows: any[] = await db.run(
      SELECT.from('odatano.astra.Snapshots').where({ chain }).where({ metricId: { in: Object.values(EPOCH_GAUGES) } }),
    );
    const byEpoch = new Map<number, EpochRow>();
    for (const r of rows) {
      let epoch: number | null = null;
      try { epoch = Number(JSON.parse(String(r.payload ?? '{}')).epoch); } catch { /* not an epoch row */ }
      if (epoch === null || !Number.isFinite(epoch)) continue;
      const row = byEpoch.get(epoch) ?? { chain, epoch, takenAt: null };
      for (const [col, metric] of Object.entries(EPOCH_GAUGES)) if (metric === r.metricId) row[col] = r.value === null || r.value === undefined ? null : Number(r.value);
      const at = r.takenAt ? new Date(r.takenAt).toISOString() : null;
      if (at && (!row.takenAt || at > row.takenAt)) row.takenAt = at;
      byEpoch.set(epoch, row);
    }
    out.push(...byEpoch.values());
  }
  return out;
}
