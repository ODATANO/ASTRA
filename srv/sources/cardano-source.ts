/**
 * Cardano source over the ODATANO (@odatano/core) tables:
 *   odatano.cardano.Blocks, Transactions, CardanoSyncState, CardanoReorgLog
 *
 * Column facts (schema 2.0.0-rc.18):
 *   Blocks.time        ISO 8601 string          Transactions.blockTime  unix seconds
 *   Blocks.height      Integer                  Transactions.fee        lovelace
 *   Blocks.slot        absolute slot            CardanoReorgLog.forkHeight may be null (forkSlot set)
 */
import cds from '@sap/cds';
import type {
  AddressMoveRow, AssetMoveRow, BlockRow, ChainSource, DrepSnapshotRow, EpochSnapshotSet,
  PoolSnapshotRow, ReorgRow, SourceTip, StakeActivity, TxRow,
} from './types';
import { num, toUnixSeconds } from './types';

const { SELECT } = cds.ql;

/** The columns read from TransactionInputs; the address is flattened by CAP. */
interface InputRow { txSeq: unknown; inputIndex: number; address_address?: string | null; isCollateral?: boolean | null; isReference?: boolean | null }
/** The columns read from TransactionInputAssets. */
interface InputAssetRow { input_txSeq: unknown; input_inputIndex: number; unit: string; asset_policyId?: string | null; asset_quantity: unknown }

/** Transactions per query: a key range on the input/output tables, an IN-list on the certificate tables. */
const HASH_CHUNK = 400;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A transaction of the height range: its hash and the block it belongs to. */
type TxAt = { hash: string; height: number; time: number };

/**
 * Inclusive `txSeq` bounds per chunk of consecutive transactions (the map is in chain order).
 * Only transactions of the range sit between two of its own `txSeq` values, so each bound pair
 * reads exactly the rows of its chunk.
 */
function seqRanges(at: Map<string, TxAt>, size: number): Array<{ between: string; and: string }> {
  return chunk([...at.keys()], size).map(part => ({ between: part[0], and: part[part.length - 1] }));
}

const E = {
  Blocks: 'odatano.cardano.Blocks',
  Transactions: 'odatano.cardano.Transactions',
  SyncState: 'odatano.cardano.CardanoSyncState',
  OutputAssets: 'odatano.cardano.TransactionOutputAssets',
  InputAssets: 'odatano.cardano.TransactionInputAssets',
  Outputs: 'odatano.cardano.TransactionOutputs',
  Inputs: 'odatano.cardano.TransactionInputs',
  PoolSnapshots: 'odatano.cardano.PoolEpochSnapshots',
  DrepSnapshots: 'odatano.cardano.DrepEpochSnapshots',
  ReorgLog: 'odatano.cardano.CardanoReorgLog',
  Certificates: 'odatano.cardano.TransactionCertificates',
  Withdrawals: 'odatano.cardano.TransactionWithdrawals',
};

export class CardanoSource implements ChainSource {
  readonly chain = 'cardano' as const;
  constructor(private readonly db: any) {}

  /** Own root transaction per statement – never bound to an ambient request transaction. */
  private run(query: unknown): Promise<any> {
    return this.db.tx((tx: any) => tx.run(query));
  }

  async getTip(): Promise<SourceTip | null> {
    const row = await this.run(SELECT.one.from(E.SyncState).where({ ID: 'SINGLETON' }));
    if (!row) return null;
    return {
      height: num(row.lastHeight) ?? 0,
      hash: row.lastBlockHash ?? null,
      chainHeight: num(row.tipHeight),
      syncStatus: row.syncStatus ?? null,
      lastIndexedAt: row.lastIndexedAt ?? null,
      network: row.network ?? null,
    };
  }

  async getCrawlStartHeight(): Promise<number | null> {
    const state = await this.run(SELECT.one.from(E.SyncState).columns('startSlot').where({ ID: 'SINGLETON' }));
    const startSlot = num(state?.startSlot);
    if (startSlot !== null) {
      const b = await this.run(
        SELECT.one.from(E.Blocks).columns('height').where({ slot: { '>=': startSlot } }).orderBy('slot asc'),
      );
      if (b) return num(b.height);
    }
    const m = await this.run(SELECT.one.from(E.Blocks).columns('min(height) as h'));
    return num(m?.h);
  }

  /**
   * `maxHeight` bounds the search to the crawled range: header-only rows the source writes at
   * the chain tip lie far above its cursor while it backfills, and would otherwise be taken
   * for the first block at the start time.
   */
  async findFirstHeightAt(unixSeconds: number, maxHeight?: number): Promise<number | null> {
    // Blocks.time is an ISO string; the second-precision prefix compares correctly against any ISO variant.
    const iso = new Date(unixSeconds * 1000).toISOString().slice(0, 19);
    const q = SELECT.one.from(E.Blocks).columns('height').where({ time: { '>=': iso } });
    if (maxHeight !== undefined) q.where({ height: { '<=': maxHeight } });
    const b = await this.run(q.orderBy('time asc'));
    return b ? num(b.height) : null;
  }

  async getBlocks(fromHeight: number, toHeight: number): Promise<BlockRow[]> {
    const rows = await this.run(
      SELECT.from(E.Blocks)
        .columns('hash', 'height', 'time', 'size', 'txCount', 'slotLeader', 'epochNumber', 'slot', 'fees')
        .where({ height: { between: fromHeight, and: toHeight } })
        .orderBy('height asc'),
    );
    const out: BlockRow[] = [];
    for (const r of rows) {
      const height = num(r.height);
      const time = toUnixSeconds(r.time);
      if (height === null || time === null) continue;
      out.push({
        height,
        hash: r.hash,
        time,
        size: num(r.size),
        txCount: num(r.txCount),
        producer: r.slotLeader ?? null,
        epoch: num(r.epochNumber),
        fees: num(r.fees),
      });
    }
    return out;
  }

  async getTransactions(fromHeight: number, toHeight: number): Promise<TxRow[]> {
    const rows = await this.run(
      SELECT.from(E.Transactions)
        .columns('hash', 'blockHeight', 'blockTime', 'fee', 'size', 'hasMetadata')
        .where({ blockHeight: { between: fromHeight, and: toHeight } }),
    );
    const out: TxRow[] = [];
    for (const r of rows) {
      const height = num(r.blockHeight);
      const time = toUnixSeconds(r.blockTime);
      if (height === null || time === null) continue;
      out.push({
        height,
        time,
        fee: num(r.fee),
        // Always null on the crawler path: Ogmios chain-sync does not surface the
        // serialized transaction size, so there is no cardano `tx.size` metric. Read
        // anyway — a future ODATANO release that fills the column starts feeding it.
        size: num(r.size),
        flags: { hasMetadata: !!r.hasMetadata },
      });
    }
    return out;
  }

  /**
   * Native-asset movements on both sides of every transaction in the range.
   *
   * The input/output and asset tables are keyed by the transaction's chain position (`txSeq`),
   * so a chunk of consecutive transactions is one key range on each table instead of a
   * two-level join over the block height or an IN-list of hashes.
   *
   * Lovelace is left out — it is the chain's own currency, already covered by the value metrics,
   * and would otherwise dominate every token leaderboard by construction.
   */
  async getAssetMovements(fromHeight: number, toHeight: number): Promise<AssetMoveRow[]> {
    const at = await this.txTimes(fromHeight, toHeight);
    if (at.size === 0) return [];

    const out: AssetMoveRow[] = [];
    const collect = (
      rows: any[], seqKey: string, side: 'in' | 'out', idxKey: string, addresses: Map<string, string>,
    ) => {
      for (const r of rows) {
        const seq = String(r[seqKey]);
        const tx = at.get(seq);
        const quantity = num(r.asset_quantity);
        if (!tx || r.unit === 'lovelace' || quantity === null) continue;
        out.push({
          height: tx.height,
          time: tx.time,
          txHash: tx.hash,
          unit: String(r.unit),
          policyId: String(r.asset_policyId ?? ''),
          quantity,
          side,
          address: addresses.get(`${seq}#${r[idxKey]}`) ?? '',
        });
      }
    };

    for (const range of seqRanges(at, HASH_CHUNK)) {
      const [outs, ins, outAddr, inAddr] = await Promise.all([
        this.run(SELECT.from(E.OutputAssets)
          .columns('output_txSeq', 'output_outputIndex', 'unit', 'asset_policyId', 'asset_quantity')
          .where({ output_txSeq: range })),
        this.run(SELECT.from(E.InputAssets)
          .columns('input_txSeq', 'input_inputIndex', 'unit', 'asset_policyId', 'asset_quantity')
          .where({ input_txSeq: range })),
        this.run(SELECT.from(E.Outputs).columns('txSeq', 'outputIndex', 'address_address').where({ txSeq: range })),
        this.run(SELECT.from(E.Inputs).columns('txSeq', 'inputIndex', 'address_address', 'isCollateral', 'isReference').where({ txSeq: range })),
      ]);
      const addrOf = (rows: any[], idxKey: string) => {
        const m = new Map<string, string>();
        for (const r of rows) if (r.address_address) m.set(`${String(r.txSeq)}#${r[idxKey]}`, String(r.address_address));
        return m;
      };
      collect(outs, 'output_txSeq', 'out', 'output_outputIndex', addrOf(outAddr, 'outputIndex'));
      // collateral and reference inputs are read, not spent: their tokens neither move nor burn
      const unspent = new Set((inAddr as InputRow[]).filter(r => r.isCollateral || r.isReference).map(r => `${String(r.txSeq)}#${r.inputIndex}`));
      collect((ins as InputAssetRow[]).filter(r => !unspent.has(`${String(r.input_txSeq)}#${r.input_inputIndex}`)), 'input_txSeq', 'in', 'input_inputIndex', addrOf(inAddr, 'inputIndex'));
    }
    return out;
  }

  /** Transactions of a height range keyed by `txSeq`, in chain order, with hash and block time. */
  private async txTimes(fromHeight: number, toHeight: number): Promise<Map<string, TxAt>> {
    const rows = await this.run(
      SELECT.from(E.Transactions)
        .columns('hash', 'txSeq', 'blockHeight', 'blockTime')
        .where({ blockHeight: { between: fromHeight, and: toHeight } })
        .orderBy('txSeq asc'),
    );
    const at = new Map<string, TxAt>();
    for (const r of rows) {
      const height = num(r.blockHeight);
      const time = toUnixSeconds(r.blockTime);
      if (height !== null && time !== null && r.txSeq != null) at.set(String(r.txSeq), { hash: String(r.hash), height, time });
    }
    return at;
  }

  /**
   * Every output created and every input spent in the range, with its address and lovelace.
   *
   * The amount lives in the asset tables under the unit `lovelace`, not on the output row, so
   * each side is read twice and joined in memory on (transaction, index). An output without a
   * lovelace row is still reported with amount 0 — it exists, and dropping it would understate
   * both the UTxO count and the address's activity.
   */
  async getAddressActivity(fromHeight: number, toHeight: number): Promise<AddressMoveRow[]> {
    const at = await this.txTimes(fromHeight, toHeight);
    if (at.size === 0) return [];

    const out: AddressMoveRow[] = [];
    for (const range of seqRanges(at, HASH_CHUNK)) {
      const [outputs, outAmounts, inputs, inAmounts] = await Promise.all([
        this.run(SELECT.from(E.Outputs).columns('txSeq', 'outputIndex', 'address_address').where({ txSeq: range })),
        this.run(SELECT.from(E.OutputAssets).columns('output_txSeq', 'output_outputIndex', 'asset_quantity')
          .where({ output_txSeq: range }).where({ unit: 'lovelace' })),
        this.run(SELECT.from(E.Inputs).columns('txSeq', 'inputIndex', 'address_address', 'isCollateral', 'isReference').where({ txSeq: range })),
        this.run(SELECT.from(E.InputAssets).columns('input_txSeq', 'input_inputIndex', 'asset_quantity')
          .where({ input_txSeq: range }).where({ unit: 'lovelace' })),
      ]);

      const amountBy = (rows: any[], seqKey: string, idxKey: string) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(`${String(r[seqKey])}#${r[idxKey]}`, num(r.asset_quantity) ?? 0);
        return m;
      };
      const outAmt = amountBy(outAmounts, 'output_txSeq', 'output_outputIndex');
      const inAmt = amountBy(inAmounts, 'input_txSeq', 'input_inputIndex');

      const push = (rows: any[], idxKey: string, amounts: Map<string, number>, side: 'in' | 'out') => {
        for (const r of rows) {
          // collateral and reference inputs are read, not spent: neither moves value
          if (r.isCollateral || r.isReference) continue;
          const seq = String(r.txSeq);
          const tx = at.get(seq);
          const address = r.address_address;
          // An input whose source output predates the crawl start has no resolved address. It is
          // still a spent UTxO, so the row is kept with an empty address and only the per-address
          // attribution is left out — dropping it here undercounted utxo.spent by 215 663 over
          // the 2026 backfill.
          if (!tx) continue;
          out.push({
            height: tx.height, time: tx.time, txHash: tx.hash,
            address: address ? String(address) : '',
            amount: amounts.get(`${seq}#${r[idxKey]}`) ?? 0,
            side,
          });
        }
      };
      push(outputs, 'outputIndex', outAmt, 'out');
      push(inputs, 'inputIndex', inAmt, 'in');
    }
    return out;
  }

  /**
   * Certificates and withdrawals of the range, keyed back to their block through the
   * transaction. The source writes both tables only with its certificate crawl on; before that
   * (and for blocks crawled earlier) the tables are simply empty, which reads as no activity.
   */
  async getStakeActivity(fromHeight: number, toHeight: number): Promise<StakeActivity> {
    const at = await this.txTimes(fromHeight, toHeight);
    const out: StakeActivity = { certificates: [], withdrawals: [] };
    if (at.size === 0) return out;

    // both tables keep the transaction hash as their key
    const byHash = new Map([...at.values()].map(t => [t.hash, t] as const));
    for (const part of chunk([...byHash.keys()], HASH_CHUNK)) {
      const [certs, withdrawals] = await Promise.all([
        this.run(SELECT.from(E.Certificates).columns('tx_hash', 'certIndex', 'kind', 'stakeAddress', 'poolId', 'drepId', 'deposit', 'epoch')
          .where({ tx_hash: { in: part } })),
        this.run(SELECT.from(E.Withdrawals).columns('tx_hash', 'stakeAddress', 'lovelace')
          .where({ tx_hash: { in: part } })),
      ]);
      for (const r of certs) {
        const where = byHash.get(String(r.tx_hash));
        if (!where || !r.kind) continue;
        out.certificates.push({
          height: where.height, time: where.time, txHash: String(r.tx_hash), kind: String(r.kind),
          stakeAddress: r.stakeAddress ? String(r.stakeAddress) : null,
          poolId: r.poolId ? String(r.poolId) : null,
          drepId: r.drepId ? String(r.drepId) : null,
          deposit: num(r.deposit),
          epoch: num(r.epoch),
        });
      }
      for (const r of withdrawals) {
        const where = byHash.get(String(r.tx_hash));
        if (!where || !r.stakeAddress) continue;
        out.withdrawals.push({
          height: where.height, time: where.time, txHash: String(r.tx_hash),
          stakeAddress: String(r.stakeAddress), lovelace: num(r.lovelace) ?? 0,
        });
      }
    }
    return out;
  }

  /**
   * Highest epoch the source has snapshotted. ODATANO takes these only while its crawl is at
   * the chain tip, so during a backfill the newest epoch here can lag the chain by a lot — or
   * be missing entirely, which is what null means.
   */
  async getLatestSnapshotEpoch(): Promise<number | null> {
    const r = await this.run(SELECT.one.from(E.PoolSnapshots).columns('max(epoch) as e'));
    return num(r?.e);
  }

  async getEpochSnapshots(epoch: number): Promise<EpochSnapshotSet> {
    const [poolRows, drepRows] = await Promise.all([
      this.run(SELECT.from(E.PoolSnapshots)
        .columns('poolId', 'epoch', 'snapshotTime', 'liveStake', 'activeStake', 'liveSaturation', 'liveDelegators', 'blocksMinted')
        .where({ epoch })),
      this.run(SELECT.from(E.DrepSnapshots)
        .columns('drepId', 'epoch', 'snapshotTime', 'amount', 'retired', 'expired')
        .where({ epoch })),
    ]);

    const pools: PoolSnapshotRow[] = [];
    for (const r of poolRows) {
      const time = toUnixSeconds(r.snapshotTime);
      if (!r.poolId || time === null) continue;
      pools.push({
        epoch, time, poolId: String(r.poolId),
        liveStake: num(r.liveStake) ?? 0,
        activeStake: num(r.activeStake) ?? 0,
        liveSaturation: num(r.liveSaturation) ?? 0,
        liveDelegators: num(r.liveDelegators) ?? 0,
        blocksMinted: num(r.blocksMinted) ?? 0,
      });
    }

    const dreps: DrepSnapshotRow[] = [];
    for (const r of drepRows) {
      const time = toUnixSeconds(r.snapshotTime);
      if (!r.drepId || time === null) continue;
      dreps.push({
        epoch, time, drepId: String(r.drepId),
        amount: num(r.amount) ?? 0,
        retired: !!r.retired,
        expired: !!r.expired,
      });
    }
    return { epoch, pools, dreps };
  }

  async getReorgsAfter(detectedAfter: string | null, limit = 50): Promise<ReorgRow[]> {
    let q = SELECT.from(E.ReorgLog)
      .columns('ID', 'detectedAt', 'forkSlot', 'forkHeight', 'blocksRolledBack', 'status')
      .orderBy('detectedAt asc')
      .limit(limit);
    if (detectedAfter) q = q.where({ detectedAt: { '>': detectedAfter } });
    const rows = await this.run(q);
    return rows.map((r: any) => ({
      id: String(r.ID),
      detectedAt: r.detectedAt,
      forkHeight: num(r.forkHeight),
      forkSlot: num(r.forkSlot),
      blocksRolledBack: num(r.blocksRolledBack),
      status: r.status ?? null,
    }));
  }

  async heightAtSlot(slot: number): Promise<number | null> {
    const b = await this.run(
      SELECT.one.from(E.Blocks).columns('height').where({ slot: { '<=': slot } }).orderBy('slot desc'),
    );
    return b ? num(b.height) : null;
  }
}
