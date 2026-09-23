/**
 * Turns raw block / transaction rows into per-minute bucket deltas.
 *
 * Every metric is a distribution of samples: a counter contributes samples of
 * value 1 (count == sum), a distribution contributes the measured value. Both
 * therefore share one bucket shape (count, sum, sumSq, min, max, histogram).
 */
import type { AddressMoveRow, AssetMoveRow, BlockRow, Chain, TxRow } from '../sources/types';
import { addSample, emptyHistogram, type Histogram } from './histogram';
import { bucketStart } from './time';

export interface BucketAcc {
  metricId: string;
  /** unix ms, minute aligned */
  bucketStart: number;
  count: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  hist: Histogram;
  fromHeight: number;
  toHeight: number;
}

export type DeltaMap = Map<string, BucketAcc>;

export function deltaKey(metricId: string, bucketStartMs: number): string {
  return `${metricId}|${bucketStartMs}`;
}

export function addToDelta(map: DeltaMap, metricId: string, timeSec: number, value: number, height: number): void {
  if (!Number.isFinite(value)) return;
  const start = bucketStart(timeSec * 1000, 'minute');
  const key = deltaKey(metricId, start);
  let acc = map.get(key);
  if (!acc) {
    acc = {
      metricId, bucketStart: start, count: 0, sum: 0, sumSq: 0,
      min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY,
      hist: emptyHistogram(), fromHeight: height, toHeight: height,
    };
    map.set(key, acc);
  }
  acc.count++;
  acc.sum += value;
  acc.sumSq += value * value;
  if (value < acc.min) acc.min = value;
  if (value > acc.max) acc.max = value;
  if (height < acc.fromHeight) acc.fromHeight = height;
  if (height > acc.toHeight) acc.toHeight = height;
  addSample(acc.hist, value);
}

/**
 * Value metrics are carried in ADA: `sumSq` is Decimal(38,6), so a sample must stay below ~1e16
 * or its square overflows (faucet outputs on preprod exceed 2.5e16 lovelace). Decimal(38,6)
 * still holds every lovelace exactly. `fees.paid` stays in lovelace. Each metric declares its
 * unit in the catalogue.
 */
const LOVELACE_PER_ADA = 1_000_000;
/** Leaderboard dimensions, mirroring db/schema.cds. */
export type Dimension = 'token' | 'policy' | 'script' | 'address' | 'producer' | 'pool' | 'drep' | 'tokenHolder';

/** One entity's counter inside one period — the per-entity counterpart of BucketAcc. */
export interface EntityAcc {
  dimension: Dimension;
  entityId: string;
  /** Second axis; '' for dimensions that have none. */
  subjectId: string;
  metricId: string;
  /** unix ms, hour aligned */
  bucketStart: number;
  count: number;
  sum: number;
  fromHeight: number;
  toHeight: number;
}

export type EntityDeltaMap = Map<string, EntityAcc>;

export function addToEntity(
  map: EntityDeltaMap,
  dimension: Dimension,
  entityId: string,
  metricId: string,
  timeSec: number,
  value: number,
  height: number,
  subjectId = '',
): void {
  if (!entityId || !Number.isFinite(value)) return;
  const start = bucketStart(timeSec * 1000, 'hour');
  const key = `${dimension}|${entityId}|${subjectId}|${metricId}|${start}`;
  let acc = map.get(key);
  if (!acc) {
    acc = { dimension, entityId, subjectId, metricId, bucketStart: start, count: 0, sum: 0, fromHeight: height, toHeight: height };
    map.set(key, acc);
  }
  acc.count++;
  acc.sum += value;
  if (height < acc.fromHeight) acc.fromHeight = height;
  if (height > acc.toHeight) acc.toHeight = height;
}

/**
 * Native-asset movements into chain-wide and per-token counters.
 *
 * Mint / burn = produced minus consumed per (transaction, unit); a plain transfer nets to zero.
 * Chain-wide metrics count events only (quantities of different tokens do not add up); the
 * quantity is carried per entity. `tokenHolder` rows record movement per (address, token)
 * (`tokens.received` / `tokens.sent`), not balances: the history may start after the address
 * received the token.
 */
export function computeAssetDeltas(
  moves: AssetMoveRow[],
  deltas: DeltaMap,
  entities: EntityDeltaMap,
): void {
  interface Agg { outQty: number; inQty: number; outCount: number; time: number; height: number; policyId: string }
  const perTxUnit = new Map<string, Agg>();
  const txsWithAssets = new Map<string, { time: number; height: number }>();

  for (const m of moves) {
    const key = `${m.txHash}|${m.unit}`;
    let a = perTxUnit.get(key);
    if (!a) {
      a = { outQty: 0, inQty: 0, outCount: 0, time: m.time, height: m.height, policyId: m.policyId };
      perTxUnit.set(key, a);
    }
    if (m.side === 'out') { a.outQty += m.quantity; a.outCount++; txsWithAssets.set(m.txHash, { time: m.time, height: m.height }); }
    else a.inQty += m.quantity;

    // one row per (address, token): who moved which token, and how much of it
    if (m.address) {
      const metric = m.side === 'out' ? 'tokens.received' : 'tokens.sent';
      addToEntity(entities, 'tokenHolder', `${m.unit}|${m.address}`, metric, m.time, m.quantity, m.height, m.unit);
    }
  }

  for (const [key, a] of perTxUnit) {
    const unit = key.slice(key.indexOf('|') + 1);

    if (a.outCount > 0) {
      addToDelta(deltas, 'tokens.transfers', a.time, 1, a.height);
      addToEntity(entities, 'token', unit, 'tokens.transfers', a.time, a.outQty, a.height);
      if (a.policyId) addToEntity(entities, 'policy', a.policyId, 'tokens.transfers', a.time, a.outQty, a.height);
    }

    const net = a.outQty - a.inQty;
    if (net > 0) {
      addToDelta(deltas, 'tokens.mints', a.time, 1, a.height);
      addToEntity(entities, 'token', unit, 'tokens.mints', a.time, net, a.height);
      if (a.policyId) addToEntity(entities, 'policy', a.policyId, 'tokens.mints', a.time, net, a.height);
    } else if (net < 0) {
      addToDelta(deltas, 'tokens.burns', a.time, 1, a.height);
      addToEntity(entities, 'token', unit, 'tokens.burns', a.time, -net, a.height);
      if (a.policyId) addToEntity(entities, 'policy', a.policyId, 'tokens.burns', a.time, -net, a.height);
    }
  }

  for (const [, at] of txsWithAssets) addToDelta(deltas, 'tx.withAssets', at.time, 1, at.height);
}

/**
 * Is this a Cardano address whose payment part is a script? The bech32 character after the
 * `addr1` / `addr_test1` prefix encodes the header; script payment credentials are header types
 * 1, 3 and 7 = `z`, `x`, `w`. Byron addresses (base58) are never scripts.
 */
export function isScriptAddress(address: string): boolean {
  const m = /^addr(?:_test)?1(.)/.exec(address);
  return m !== null && (m[1] === 'z' || m[1] === 'x' || m[1] === 'w');
}

/**
 * Address activity into value metrics and the address / script leaderboards. An output is value
 * received and a UTxO created; an input is value sent and a UTxO spent. A script address lands
 * in both the `address` and the `script` dimension (separate leaderboards, never summed). A move
 * without an address (input whose output predates the crawl) counts chain-wide only.
 */
export function computeAddressDeltas(
  moves: AddressMoveRow[],
  deltas: DeltaMap,
  entities: EntityDeltaMap,
): void {
  for (const m of moves) {
    const received = m.side === 'out';
    const metric = received ? 'value.received' : 'value.sent';
    const value = m.amount / LOVELACE_PER_ADA;

    addToDelta(deltas, received ? 'utxo.created' : 'utxo.spent', m.time, 1, m.height);
    if (received) addToDelta(deltas, 'value.transferred', m.time, value, m.height);

    if (!m.address) continue;   // nothing to attribute, but the counters above already ran
    addToEntity(entities, 'address', m.address, metric, m.time, value, m.height);
    if (isScriptAddress(m.address)) {
      addToEntity(entities, 'script', m.address, metric, m.time, value, m.height);
    }
  }
}

export interface SampleContext {
  chain: Chain;
  /** unix seconds of the block preceding `blocks[0]`, for blocks.interval */
  prevBlockTime: number | null;
}

/**
 * Computes the minute deltas for a contiguous chunk of blocks and their transactions.
 * Returns the deltas and the time of the last block (next chunk's prevBlockTime).
 */
export function computeDeltas(
  blocks: BlockRow[],
  txs: TxRow[],
  ctx: SampleContext,
  entities?: EntityDeltaMap,
): { deltas: DeltaMap; lastBlockTime: number | null } {
  const deltas: DeltaMap = new Map();
  const txPerBlock = new Map<number, number>();
  const isMidnight = ctx.chain === 'midnight';

  for (const tx of txs) {
    const f = tx.flags || {};
    if (isMidnight && f.system) {
      addToDelta(deltas, 'tx.system', tx.time, 1, tx.height);
      continue;
    }
    txPerBlock.set(tx.height, (txPerBlock.get(tx.height) || 0) + 1);
    addToDelta(deltas, 'tx.count', tx.time, 1, tx.height);
    if (tx.size !== null && tx.size !== undefined) addToDelta(deltas, 'tx.size', tx.time, tx.size, tx.height);
    if (tx.fee !== null && tx.fee !== undefined) addToDelta(deltas, 'fees.paid', tx.time, tx.fee, tx.height);

    if (isMidnight) {
      if (f.isShielded) addToDelta(deltas, 'tx.shielded', tx.time, 1, tx.height);
      if (f.hasProof) addToDelta(deltas, 'tx.withProof', tx.time, 1, tx.height);
      if (f.txType === 'contract_call') addToDelta(deltas, 'tx.contractCalls', tx.time, 1, tx.height);
      if (f.txType === 'contract_deploy') addToDelta(deltas, 'tx.contractDeploys', tx.time, 1, tx.height);
      if (f.status === 'FAILURE') addToDelta(deltas, 'tx.failed', tx.time, 1, tx.height);
      const est = typeof f.estimatedFees === 'number' ? f.estimatedFees : null;
      if (est !== null) {
        addToDelta(deltas, 'fees.estimated', tx.time, est, tx.height);
        if (tx.fee !== null && tx.fee !== undefined) addToDelta(deltas, 'fees.estimateError', tx.time, tx.fee - est, tx.height);
      }
    } else if (f.hasMetadata) {
      addToDelta(deltas, 'tx.withMetadata', tx.time, 1, tx.height);
    }
  }

  let prev = ctx.prevBlockTime;
  let lastBlockTime: number | null = null;
  for (const b of blocks) {
    addToDelta(deltas, 'blocks.count', b.time, 1, b.height);
    if (b.size !== null && b.size !== undefined) addToDelta(deltas, 'blocks.size', b.time, b.size, b.height);
    if (prev !== null && prev !== undefined) addToDelta(deltas, 'blocks.interval', b.time, Math.max(0, b.time - prev), b.height);
    // Prefer the transactions we actually saw; fall back to the block row's own count.
    const n = txPerBlock.get(b.height) ?? (b.txCount ?? 0);
    addToDelta(deltas, 'blocks.txCount', b.time, n, b.height);
    if (n === 0) addToDelta(deltas, 'blocks.empty', b.time, 1, b.height);
    // sum is the bytes produced, so `by=count` ranks producers by blocks and `by=sum` by size
    if (entities && b.producer) addToEntity(entities, 'producer', b.producer, 'blocks.produced', b.time, b.size ?? 0, b.height);
    prev = b.time;
    lastBlockTime = b.time;
  }
  return { deltas, lastBlockTime };
}
