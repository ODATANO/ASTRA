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
  PoolSnapshotRow, ReorgRow, SourceTip, TxRow,
} from './types';
import { num, toUnixSeconds } from './types';

const { SELECT } = cds.ql;

/** IN-list size per asset query — a few hundred hashes keeps every driver's bind limit happy. */
const HASH_CHUNK = 400;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

  async findFirstHeightAt(unixSeconds: number): Promise<number | null> {
    // Blocks.time is an ISO string; the second-precision prefix compares correctly against any ISO variant.
    const iso = new Date(unixSeconds * 1000).toISOString().slice(0, 19);
    const b = await this.run(
      SELECT.one.from(E.Blocks).columns('height').where({ time: { '>=': iso } }).orderBy('time asc'),
    );
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
   * Filtered by transaction hash rather than by a path expression over the block height: the
   * asset tables carry only the foreign key to their input/output, so a height filter would
   * mean a two-level join. A chunk is a few hundred hashes, which is the same IN-list discipline
   * the ODATANO indexer uses when it resolves inputs.
   *
   * Lovelace is left out — it is the chain's own currency, already covered by the value metrics,
   * and would otherwise dominate every token leaderboard by construction.
   */
  async getAssetMovements(fromHeight: number, toHeight: number): Promise<AssetMoveRow[]> {
    const txs = await this.run(
      SELECT.from(E.Transactions)
        .columns('hash', 'blockHeight', 'blockTime')
        .where({ blockHeight: { between: fromHeight, and: toHeight } }),
    );
    if (!txs.length) return [];

    const at = new Map<string, { height: number; time: number }>();
    for (const t of txs) {
      const height = num(t.blockHeight);
      const time = toUnixSeconds(t.blockTime);
      if (height !== null && time !== null) at.set(String(t.hash), { height, time });
    }

    const hashes = [...at.keys()];
    const out: AssetMoveRow[] = [];
    const collect = (
      rows: any[], hashKey: string, side: 'in' | 'out', idxKey: string, addresses: Map<string, string>,
    ) => {
      for (const r of rows) {
        const txHash = String(r[hashKey]);
        const where = at.get(txHash);
        const quantity = num(r.asset_quantity);
        if (!where || r.unit === 'lovelace' || quantity === null) continue;
        out.push({
          height: where.height,
          time: where.time,
          txHash,
          unit: String(r.unit),
          policyId: String(r.asset_policyId ?? ''),
          quantity,
          side,
          address: addresses.get(`${txHash}#${r[idxKey]}`) ?? '',
        });
      }
    };

    for (const part of chunk(hashes, HASH_CHUNK)) {
      const [outs, ins, outAddr, inAddr] = await Promise.all([
        this.run(SELECT.from(E.OutputAssets)
          .columns('output_tx_hash', 'output_outputIndex', 'unit', 'asset_policyId', 'asset_quantity')
          .where({ output_tx_hash: { in: part } })),
        this.run(SELECT.from(E.InputAssets)
          .columns('input_tx_hash', 'input_inputIndex', 'unit', 'asset_policyId', 'asset_quantity')
          .where({ input_tx_hash: { in: part } })),
        this.run(SELECT.from(E.Outputs).columns('tx_hash', 'outputIndex', 'address_address')
          .where({ tx_hash: { in: part } })),
        this.run(SELECT.from(E.Inputs).columns('tx_hash', 'inputIndex', 'address_address')
          .where({ tx_hash: { in: part } })),
      ]);
      const addrOf = (rows: any[], idxKey: string) => {
        const m = new Map<string, string>();
        for (const r of rows) if (r.address_address) m.set(`${r.tx_hash}#${r[idxKey]}`, String(r.address_address));
        return m;
      };
      collect(outs, 'output_tx_hash', 'out', 'output_outputIndex', addrOf(outAddr, 'outputIndex'));
      collect(ins, 'input_tx_hash', 'in', 'input_inputIndex', addrOf(inAddr, 'inputIndex'));
    }
    return out;
  }

  /** Transaction hashes of a height range, with the block time each one belongs to. */
  private async txTimes(fromHeight: number, toHeight: number): Promise<Map<string, { height: number; time: number }>> {
    const rows = await this.run(
      SELECT.from(E.Transactions)
        .columns('hash', 'blockHeight', 'blockTime')
        .where({ blockHeight: { between: fromHeight, and: toHeight } }),
    );
    const at = new Map<string, { height: number; time: number }>();
    for (const r of rows) {
      const height = num(r.blockHeight);
      const time = toUnixSeconds(r.blockTime);
      if (height !== null && time !== null) at.set(String(r.hash), { height, time });
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
    for (const part of chunk([...at.keys()], HASH_CHUNK)) {
      const [outputs, outAmounts, inputs, inAmounts] = await Promise.all([
        this.run(SELECT.from(E.Outputs).columns('tx_hash', 'outputIndex', 'address_address')
          .where({ tx_hash: { in: part } })),
        this.run(SELECT.from(E.OutputAssets).columns('output_tx_hash', 'output_outputIndex', 'asset_quantity')
          .where({ output_tx_hash: { in: part } }).where({ unit: 'lovelace' })),
        this.run(SELECT.from(E.Inputs).columns('tx_hash', 'inputIndex', 'address_address')
          .where({ tx_hash: { in: part } })),
        this.run(SELECT.from(E.InputAssets).columns('input_tx_hash', 'input_inputIndex', 'asset_quantity')
          .where({ input_tx_hash: { in: part } }).where({ unit: 'lovelace' })),
      ]);

      const amountBy = (rows: any[], hashKey: string, idxKey: string) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(`${r[hashKey]}#${r[idxKey]}`, num(r.asset_quantity) ?? 0);
        return m;
      };
      const outAmt = amountBy(outAmounts, 'output_tx_hash', 'output_outputIndex');
      const inAmt = amountBy(inAmounts, 'input_tx_hash', 'input_inputIndex');

      const push = (rows: any[], idxKey: string, amounts: Map<string, number>, side: 'in' | 'out') => {
        for (const r of rows) {
          const txHash = String(r.tx_hash);
          const where = at.get(txHash);
          const address = r.address_address;
          // An input whose source output predates the crawl start has no resolved address. It is
          // still a spent UTxO, so the row is kept with an empty address and only the per-address
          // attribution is left out — dropping it here undercounted utxo.spent by 215 663 over
          // the 2026 backfill.
          if (!where) continue;
          out.push({
            height: where.height, time: where.time, txHash,
            address: address ? String(address) : '',
            amount: amounts.get(`${txHash}#${r[idxKey]}`) ?? 0,
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
