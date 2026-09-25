/**
 * Chain sources – the seam between ASTRA and the raw data of the hosted
 * ODATANO (Cardano) and NIGHTGATE (Midnight) instances.
 *
 * A source is a *read-only* view onto the tables those products' crawlers
 * already fill. Nothing here writes, and nothing here creates tables.
 */

export type Chain = 'cardano' | 'midnight';

export interface SourceTip {
  /** Last height the source crawler has fully persisted. */
  height: number;
  hash?: string | null;
  /** Node tip as the source reports it (for lag). */
  chainHeight?: number | null;
  syncStatus?: string | null;
  lastIndexedAt?: string | null;
  /** Which network the source indexes — a cross-check must ask the same one. */
  network?: string | null;
}

export interface BlockRow {
  height: number;
  hash: string;
  /** Unix seconds. */
  time: number;
  size?: number | null;
  /** Transaction count as the source stores it on the block row (may be null). */
  txCount?: number | null;
  producer?: string | null;
  epoch?: number | null;
  /** Fees collected in the block, as the source stores them (lovelace). */
  fees?: number | null;
}

export interface TxRow {
  height: number;
  /** Unix seconds (block time). */
  time: number;
  fee?: number | null;
  size?: number | null;
  /** Chain specific flags, interpreted in srv/aggregator/samples.ts. */
  flags?: Record<string, boolean | number | string | null | undefined>;
}

/**
 * One native-asset movement on one side of one transaction.
 *
 * Both sides are needed because a mint or a burn is not recorded anywhere directly: it is the
 * difference between what a transaction puts out and what it takes in, per unit. A transfer is
 * the output side alone.
 */
export interface AssetMoveRow {
  height: number;
  /** Unix seconds (block time). */
  time: number;
  txHash: string;
  /** policyId + assetNameHex — the chain-wide identity of the asset. */
  unit: string;
  policyId: string;
  quantity: number;
  side: 'in' | 'out';
  /** Address of the output/input this movement sits on; '' when the source could not resolve it. */
  address: string;
}

/** One side of one transaction seen from an address: what it received or what it spent. */
export interface AddressMoveRow {
  height: number;
  /** Unix seconds (block time). */
  time: number;
  txHash: string;
  address: string;
  /** The chain's own currency moved on this side (lovelace / specks, the DUST atom). */
  amount: number;
  side: 'in' | 'out';
}

/**
 * A stake pool as one epoch saw it. Stake amounts are lovelace as the source stores them;
 * the aggregator converts to ADA, for the same overflow reason as the value metrics.
 */
export interface PoolSnapshotRow {
  epoch: number;
  /** Unix seconds the observation was taken. */
  time: number;
  poolId: string;
  liveStake: number;
  activeStake: number;
  liveSaturation: number;
  liveDelegators: number;
  /** Blocks the pool has minted over its lifetime. `blocksEpoch` is null for every pool the
   *  source reports, so the per-epoch figure is not available — see the ODATANO report. */
  blocksMinted: number;
}

/** A delegated representative as one epoch saw it. */
export interface DrepSnapshotRow {
  epoch: number;
  time: number;
  drepId: string;
  amount: number;
  retired: boolean;
  expired: boolean;
}

export interface EpochSnapshotSet {
  epoch: number;
  pools: PoolSnapshotRow[];
  dreps: DrepSnapshotRow[];
}

/**
 * One certificate a transaction carried, as the source normalised it: `kind` is
 * `stake_registration`, `stake_deregistration`, `pool_delegation`, `vote_delegation`,
 * `pool_registration`, `pool_retirement`, `drep_registration`, `drep_deregistration`, ...;
 * an unknown source type keeps its raw name.
 */
export interface CertificateRow {
  height: number;
  /** Unix seconds (block time). */
  time: number;
  txHash: string;
  kind: string;
  stakeAddress: string | null;
  poolId: string | null;
  drepId: string | null;
  /** Deposit paid or refunded in lovelace, when the source reports it. */
  deposit: number | null;
  /** Retirement epoch of a pool_retirement certificate. */
  epoch: number | null;
}

/** One reward-account withdrawal of a transaction. */
export interface WithdrawalRow {
  height: number;
  time: number;
  txHash: string;
  stakeAddress: string;
  lovelace: number;
}

export interface StakeActivity {
  certificates: CertificateRow[];
  withdrawals: WithdrawalRow[];
}

export interface ReorgRow {
  id: string;
  detectedAt: string;
  /** Height of the common ancestor; null when the source only knows the slot. */
  forkHeight: number | null;
  forkSlot?: number | null;
  blocksRolledBack?: number | null;
  status?: string | null;
}

export interface ChainSource {
  readonly chain: Chain;
  /** Crawler cursor of the source, null when the source has never synced. */
  getTip(): Promise<SourceTip | null>;
  /** Lowest height of the contiguous range the source crawler owns. */
  getCrawlStartHeight(): Promise<number | null>;
  /** First block at or after the given unix time, null when none. */
  findFirstHeightAt(unixSeconds: number, maxHeight?: number): Promise<number | null>;
  /** Blocks in [fromHeight, toHeight], ascending by height. */
  getBlocks(fromHeight: number, toHeight: number): Promise<BlockRow[]>;
  /** Transactions of the blocks in [fromHeight, toHeight]. */
  getTransactions(fromHeight: number, toHeight: number): Promise<TxRow[]>;
  /**
   * Native-asset movements of the blocks in [fromHeight, toHeight], both sides.
   * Optional: a source without native assets simply does not implement it.
   */
  getAssetMovements?(fromHeight: number, toHeight: number): Promise<AssetMoveRow[]>;
  /**
   * Address activity of the blocks in [fromHeight, toHeight]: one row per output created and
   * per input spent, with the address and the native amount. Optional.
   */
  getAddressActivity?(fromHeight: number, toHeight: number): Promise<AddressMoveRow[]>;
  /**
   * Certificates and withdrawals of the blocks in [fromHeight, toHeight]. Optional; a source
   * that does not record them (or whose crawler has the feature off) answers empty lists.
   */
  getStakeActivity?(fromHeight: number, toHeight: number): Promise<StakeActivity>;
  /** Highest epoch the source holds a pool/DRep snapshot for, null when it has none. */
  getLatestSnapshotEpoch?(): Promise<number | null>;
  /** Pool and DRep snapshots of one epoch. */
  getEpochSnapshots?(epoch: number): Promise<EpochSnapshotSet>;
  /** Reorgs the source logged after `detectedAfter` (ISO), ascending. */
  getReorgsAfter(detectedAfter: string | null, limit?: number): Promise<ReorgRow[]>;
  /** Resolve a slot to the highest block height at or below it (Cardano only). */
  heightAtSlot?(slot: number): Promise<number | null>;
}

/** Numbers arrive as string (Postgres int8/decimal) or number (SQLite). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Unix seconds from seconds, milliseconds or an ISO string. */
export function toUnixSeconds(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && !/^\d+$/.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const n = num(v);
  if (n === null) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}
