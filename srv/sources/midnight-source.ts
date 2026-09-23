/**
 * Midnight source over the NIGHTGATE (@odatano/nightgate) tables:
 *   midnight.Blocks, Transactions, TransactionFees, TransactionResults, SyncState, ReorgLog
 *
 * Column facts (schema 0.25.4):
 *   Blocks.timestamp          unix time (Substrate writes milliseconds; normalised to seconds)
 *   Transactions.block        association → block_ID; height/time reached via path expression
 *   Transactions.transactionType  REGULAR | SYSTEM   – only REGULAR counts as "a transaction"
 *   TransactionFees.paidFees / estimatedFees   specks (DUST atoms, 1 DUST = 10^15) as decimal strings
 */
import cds from '@sap/cds';
import type { BlockRow, ChainSource, ReorgRow, SourceTip, TxRow } from './types';
import { num, toUnixSeconds } from './types';

const { SELECT } = cds.ql;

const E = {
  Blocks: 'midnight.Blocks',
  Transactions: 'midnight.Transactions',
  SyncState: 'midnight.SyncState',
  ReorgLog: 'midnight.ReorgLog',
};

export class MidnightSource implements ChainSource {
  readonly chain = 'midnight' as const;
  private tsScale: 1 | 1000 | null = null;
  constructor(private readonly db: any) {}

  /** Own root transaction per statement – never bound to an ambient request transaction. */
  private run(query: unknown): Promise<any> {
    return this.db.tx((tx: any) => tx.run(query));
  }

  async getTip(): Promise<SourceTip | null> {
    const row = await this.run(SELECT.one.from(E.SyncState).where({ ID: 'SINGLETON' }));
    if (!row) return null;
    return {
      height: num(row.lastIndexedHeight) ?? 0,
      hash: row.lastIndexedHash ?? null,
      chainHeight: num(row.chainHeight),
      syncStatus: row.syncStatus ?? null,
      lastIndexedAt: row.lastIndexedAt ?? null,
      network: row.networkId ?? null,
    };
  }

  async getCrawlStartHeight(): Promise<number | null> {
    const m = await this.run(SELECT.one.from(E.Blocks).columns('min(height) as h'));
    return num(m?.h);
  }

  /** Blocks.timestamp may be seconds or milliseconds – detect once from the newest block. */
  private async timestampScale(): Promise<1 | 1000> {
    if (this.tsScale) return this.tsScale;
    const b = await this.run(SELECT.one.from(E.Blocks).columns('timestamp').orderBy('height desc'));
    const t = num(b?.timestamp);
    this.tsScale = t !== null && t > 1e11 ? 1000 : 1;
    return this.tsScale;
  }

  async findFirstHeightAt(unixSeconds: number): Promise<number | null> {
    const scale = await this.timestampScale();
    const b = await this.run(
      SELECT.one.from(E.Blocks).columns('height').where({ timestamp: { '>=': unixSeconds * scale } }).orderBy('timestamp asc'),
    );
    return b ? num(b.height) : null;
  }

  async getBlocks(fromHeight: number, toHeight: number): Promise<BlockRow[]> {
    const rows = await this.run(
      SELECT.from(E.Blocks)
        .columns('hash', 'height', 'timestamp', 'author')
        .where({ height: { between: fromHeight, and: toHeight } })
        .orderBy('height asc'),
    );
    const out: BlockRow[] = [];
    for (const r of rows) {
      const height = num(r.height);
      const time = toUnixSeconds(r.timestamp);
      if (height === null || time === null) continue;
      out.push({ height, hash: r.hash, time, size: null, txCount: null, producer: r.author ?? null });
    }
    return out;
  }

  async getTransactions(fromHeight: number, toHeight: number): Promise<TxRow[]> {
    const q = SELECT.from(E.Transactions).columns(
      { ref: ['ID'] },
      { ref: ['size'] },
      { ref: ['transactionType'] },
      { ref: ['txType'] },
      { ref: ['isShielded'] },
      { ref: ['hasProof'] },
      { ref: ['block', 'height'], as: 'height' },
      { ref: ['block', 'timestamp'], as: 'time' },
      { ref: ['transactionFees', 'paidFees'], as: 'paidFees' },
      { ref: ['transactionFees', 'estimatedFees'], as: 'estimatedFees' },
      { ref: ['transactionResult', 'status'], as: 'status' },
    );
    (q as any).where({ 'block.height': { between: fromHeight, and: toHeight } });
    const rows = await this.run(q);
    const out: TxRow[] = [];
    for (const r of rows) {
      const height = num(r.height);
      const time = toUnixSeconds(r.time);
      if (height === null || time === null) continue;
      const paid = num(r.paidFees);
      const est = num(r.estimatedFees);
      out.push({
        height,
        time,
        fee: paid,
        size: num(r.size),
        flags: {
          system: r.transactionType === 'SYSTEM',
          txType: r.txType ?? null,
          isShielded: !!r.isShielded,
          hasProof: !!r.hasProof,
          status: r.status ?? null,
          estimatedFees: est,
          hasFees: paid !== null,
        },
      });
    }
    return out;
  }

  async getReorgsAfter(detectedAfter: string | null, limit = 50): Promise<ReorgRow[]> {
    let q = SELECT.from(E.ReorgLog)
      .columns('ID', 'detectedAt', 'forkHeight', 'blocksRolledBack', 'status')
      .orderBy('detectedAt asc')
      .limit(limit);
    if (detectedAfter) q = q.where({ detectedAt: { '>': detectedAfter } });
    const rows = await this.run(q);
    return rows.map((r: any) => ({
      id: String(r.ID),
      detectedAt: r.detectedAt,
      forkHeight: num(r.forkHeight),
      blocksRolledBack: num(r.blocksRolledBack),
      status: r.status ?? null,
    }));
  }
}
