/**
 * End-to-end over in-memory SQLite: a fake ODATANO database (real schema),
 * the aggregator, and the window functions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { CardanoSource } from '../srv/sources/cardano-source';
import { MidnightSource } from '../srv/sources/midnight-source';
import { connectSource, resetSourceCache } from '../srv/sources/source-db';
import { ChainAggregator } from '../srv/aggregator/engine';
import { computeSeries, computeWindow, getMetric } from '../srv/aggregator/windows';
import { getLeaderboard, getSubjectRanking } from '../srv/aggregator/leaderboards';
import { stakeCredentialOf } from '../srv/aggregator/stake-address';
import { readScriptUsersDaily } from '../srv/views/daily';
import { applyEpochSnapshots } from '../srv/aggregator/epoch-snapshots';
import { getConcentration, gini, nakamoto } from '../srv/aggregator/concentration';
import { getDistribution } from '../srv/aggregator/distribution';
import { hasReference, sampleHeights, verifySample } from '../srv/verification/sampling';
import { CycleTimeoutError, cycleTimeoutMs, withCycleTimeout } from '../srv/aggregator/scheduler';
import { applyEntityDeltas, entityHorizon, prune } from '../srv/aggregator/store';
import { addToEntity, type EntityDeltaMap } from '../srv/aggregator/samples';

const { INSERT, UPSERT, UPDATE, SELECT, DELETE } = cds.ql;
const hex = (n: number) => Array.from({ length: n }, (_, i) => ((i * 7 + n) % 16).toString(16)).join('');

let now: number;
// file-backed SQLite: ':memory:' would give every pooled connection its own empty database
const tmp = mkdtempSync(path.join(os.tmpdir(), 'astra-test-'));
const sqliteFile = (name: string) => ({ kind: 'sqlite' as const, credentials: { url: path.join(tmp, name) } });

beforeAll(async () => {
  process.env.SKIP_AUTO_INIT = 'true';
  cds.root = path.resolve(__dirname, '..');
  (cds.env.requires as any).db = sqliteFile('main.sqlite');
  cds.model = (await cds.load(['db', 'srv'].map(d => path.join(cds.root, d)))) as any;
  await (cds as any).deploy(cds.model).to('db', { silent: true });
  resetSourceCache();
  now = Date.now();
});

async function seedCardano(db: any, fromHeight: number, count: number, startSec: number) {
  let t = startSec;
  const rows: any[] = [], txs: any[] = [];
  for (let h = fromHeight; h < fromHeight + count; h++) {
    t += 20;
    const hash = hex(64) + h;
    const n = h % 4 === 0 ? 0 : 3;
    rows.push({ hash, time: new Date(t * 1000).toISOString(), height: h, slot: h * 20, size: 1000 + n * 300, txCount: n, fees: n * 200_000 });
    // size stays null: ODATANO's crawler cannot report it (Ogmios chain-sync omits the
    // serialized size), so a fixture with a number would test a column that is never filled
    for (let i = 0; i < n; i++) txs.push({ hash: `${hash}-${i}`, txSeq: h * 20 * 65536 + i, blockHash: hash, blockHeight: h, blockTime: t, slot: h * 20, txIndex: i, fee: 200_000 + i * 1000, size: null, hasMetadata: i === 0 });
  }
  await db.run(INSERT.into('odatano.cardano.Blocks').entries(rows));
  await db.run(INSERT.into('odatano.cardano.Transactions').entries(txs));
  const last = rows[rows.length - 1];
  await db.run(UPSERT.into('odatano.cardano.CardanoSyncState').entries({ ID: 'SINGLETON', network: 'preprod', startSlot: fromHeight * 20, lastSlot: last.slot, lastBlockHash: last.hash, lastHeight: last.height, tipHeight: last.height, syncStatus: 'synced' }));
  return t;
}

describe('cardano aggregation over the ODATANO schema', () => {
  it('backfills, keeps provenance, answers windows and handles a reorg', async () => {
    const db = await connectSource('cardano', sqliteFile('cardano.sqlite'));
    // minute-aligned start, 170 blocks × 20 s = 3400 s → all inside one rolling 1h window ending at lastTime
    const startSec = Math.floor(now / 60000) * 60 - 3600;
    const lastTime = await seedCardano(db, 100, 170, startSec);
    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 50, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    const r1 = await agg.runCycle(60000);
    expect(r1.skipped).toBeUndefined();
    expect(r1.blocks).toBe(170);
    expect(r1.txs).toBe(381); // 127 non-empty blocks × 3 tx
    expect(r1.caughtUp).toBe(true);

    const cursor = await agg.getCursor();
    expect(cursor?.startHeight).toBe(100);
    expect(cursor?.lastHeight).toBe(269);
    expect(cursor?.network).toBe('preprod'); // the label comes from the source's own sync state

    const blocks = await computeWindow(cds.db, 'cardano', 'blocks.count', '1h', lastTime * 1000);
    expect(blocks.count).toBe(170);
    expect(blocks.fromHeight).toBe(100);
    expect(blocks.toHeight).toBe(269);
    const fees = await computeWindow(cds.db, 'cardano', 'fees.paid', '1h', lastTime * 1000);
    expect(fees.count).toBe(381);
    expect(fees.sum).toBe(381 * 200_000 + 127 * 3000);
    expect(fees.min).toBe(200_000);
    expect(fees.max).toBe(202_000);
    expect(fees.p50).toBeGreaterThanOrEqual(200_000);
    expect(fees.p50).toBeLessThanOrEqual(202_000);
    const interval = await computeWindow(cds.db, 'cardano', 'blocks.interval', '1h', lastTime * 1000);
    expect(interval.count).toBe(169); // first block has no predecessor
    expect(interval.avg).toBe(20);
    const empty = await computeWindow(cds.db, 'cardano', 'blocks.empty', '1h', lastTime * 1000);
    expect(empty.count).toBe(43);

    // No tx.size for cardano — the source cannot fill it, so the catalogue does not advertise
    // it and nothing aggregates to an empty metric. Midnight does report a size and keeps it.
    expect(await getMetric(cds.db, 'cardano', 'tx.size')).toBeNull();
    expect(await getMetric(cds.db, 'midnight', 'tx.size')).not.toBeNull();
    const sizeBuckets = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets').where({ chain: 'cardano', metricId: 'tx.size' }));
    expect(sizeBuckets).toHaveLength(0);

    const series = await computeSeries(cds.db, 'cardano', 'tx.count', '1h', lastTime * 1000);
    expect(series.granularity).toBe('minute');
    expect(series.points.length).toBeGreaterThan(50);
    expect(series.points.reduce((s, p) => s + p.count, 0)).toBe(381);

    const hourBuckets = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets').where({ chain: 'cardano', granularity: 'hour', metricId: 'blocks.count' }));
    expect(hourBuckets.reduce((s: number, b: any) => s + Number(b.count), 0)).toBe(170);

    // idempotent: a second cycle without new blocks changes nothing
    const r2 = await agg.runCycle(60000);
    expect(r2.chunks).toBe(0);
    expect((await computeWindow(cds.db, 'cardano', 'blocks.count', '1h', lastTime * 1000)).count).toBe(170);

    // reorg: source rolls back the last 10 blocks and re-indexes 8 different ones
    await db.run(DELETE.from('odatano.cardano.Transactions').where({ blockHeight: { '>': 259 } }));
    await db.run(DELETE.from('odatano.cardano.Blocks').where({ height: { '>': 259 } }));
    await db.run(INSERT.into('odatano.cardano.CardanoReorgLog').entries({ ID: '11111111-1111-1111-1111-111111111111', detectedAt: new Date().toISOString(), forkSlot: 259 * 20, forkHeight: 259, newTipHash: 'x', blocksRolledBack: 10, status: 'completed' }));
    await seedCardano(db, 260, 8, lastTime - 200);
    const r3 = await agg.runCycle(60000);
    expect(r3.reorgs).toBe(1);
    expect(r3.caughtUp).toBe(true);
    const after = await computeWindow(cds.db, 'cardano', 'blocks.count', '1h', lastTime * 1000);
    expect(after.count).toBe(168);
    expect(after.toHeight).toBe(267);
    const reorgs = await cds.db.run(SELECT.from('odatano.astra.Reorgs').where({ chain: 'cardano' }));
    expect(reorgs).toHaveLength(1);
    expect(Number(reorgs[0].recomputedFromHeight)).toBeLessThanOrEqual(260);
  });
});

describe('midnight aggregation over the NIGHTGATE schema', () => {
  it('counts REGULAR transactions only and reads fees through the composition', async () => {
    const db = await connectSource('midnight', sqliteFile('midnight.sqlite'));
    const startMs = now - 30 * 60_000;
    let t = startMs;
    const blockIds: string[] = [];
    for (let h = 500; h < 520; h++) {
      t += 6000;
      const id = cds.utils.uuid();
      blockIds.push(id);
      await db.run(INSERT.into('midnight.Blocks').entries({ ID: id, hash: hex(64) + h, height: h, protocolVersion: 1, timestamp: t, author: 'a', ledgerParameters: 'l' }));
      const sys = cds.utils.uuid();
      await db.run(INSERT.into('midnight.Transactions').entries({ ID: sys, transactionId: 0, hash: 's' + h, protocolVersion: 1, transactionType: 'SYSTEM', txType: 'system', size: 10, block_ID: id }));
      if (h % 2 === 0) {
        const tx = cds.utils.uuid();
        await db.run(INSERT.into('midnight.Transactions').entries({ ID: tx, transactionId: 1, hash: 't' + h, protocolVersion: 1, transactionType: 'REGULAR', txType: 'contract_call', isShielded: h % 4 === 0, hasProof: true, size: 800, block_ID: id }));
        await db.run(INSERT.into('midnight.TransactionFees').entries({ ID: cds.utils.uuid(), paidFees: '120000', estimatedFees: '100000', transaction_ID: tx }));
        await db.run(INSERT.into('midnight.TransactionResults').entries({ ID: cds.utils.uuid(), status: 'SUCCESS', transaction_ID: tx }));
      }
    }
    await db.run(UPSERT.into('midnight.SyncState').entries({ ID: 'SINGLETON', networkId: 'preprod', lastIndexedHeight: 519, chainHeight: 521, lastSupplementedHeight: 519, syncStatus: 'synced' }));

    const agg = new ChainAggregator('midnight', new MidnightSource(db), {
      chunkBlocks: 7, startTime: new Date(startMs).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    const r = await agg.runCycle(60000);
    expect(r.blocks).toBe(20);
    expect(r.chunks).toBe(3);
    const txc = await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t);
    expect(txc.count).toBe(10);
    const sys = await computeWindow(cds.db, 'midnight', 'tx.system', '1h', t);
    expect(sys.count).toBe(20);
    const fees = await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t);
    expect(fees.sum).toBe(1_200_000);
    const err = await computeWindow(cds.db, 'midnight', 'fees.estimateError', '1h', t);
    expect(err.avg).toBe(20000);
    // shielded and proof flags are set by the source's decode pass; this source has none
    const shielded = await computeWindow(cds.db, 'midnight', 'tx.shielded', '1h', t);
    expect(shielded.count).toBe(0);
    const empty = await computeWindow(cds.db, 'midnight', 'blocks.empty', '1h', t);
    expect(empty.count).toBe(10);
    const interval = await computeWindow(cds.db, 'midnight', 'blocks.interval', '1h', t);
    expect(interval.avg).toBe(6);
  });
});

describe('backfill older than the retention window', () => {
  it('keeps day buckets complete although minute and hour buckets get pruned between chunks', async () => {
    const db = await connectSource('cardano', sqliteFile('cardano-old.sqlite'));
    // fresh ASTRA state for this chain (the previous test left a cursor + lease behind)
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    const startSec = Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000); // 2026-01-01, far outside 48h/90d retention
    await seedCardano(db, 1000, 300, startSec); // 300 blocks × 20 s = 100 min
    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 100, startTime: new Date(startSec * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    // first chunk, then retention runs (as it does every 30th cycle in production), then the rest
    await agg.runCycle(1); // budget 1 ms → exactly one chunk
    await cds.tx((tx: any) => prune(tx, 'cardano', { minuteHours: 48, hourDays: 90 }));
    await agg.runCycle(60000);
    expect((await agg.getCursor())?.lastHeight).toBe(1299);
    const day = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets').where({ chain: 'cardano', granularity: 'day', metricId: 'blocks.count', bucketStart: '2026-01-01T00:00:00.000Z' }));
    expect(day).toHaveLength(1);
    expect(Number(day[0].count)).toBe(300);
    expect(Number(day[0].fromHeight)).toBe(1000);
    expect(Number(day[0].toHeight)).toBe(1299);
    const minutes = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets').where({ chain: 'cardano', granularity: 'minute', metricId: 'blocks.count', bucketStart: { '<': '2026-01-02T00:00:00.000Z' } }));
    expect(minutes.length).toBeLessThan(300); // pruned – and yet the day total above is complete
  });

  it('recomputing past the minute retention replaces the day buckets instead of adding to them', async () => {
    const db = await connectSource('cardano', sqliteFile('cardano-recompute.sqlite'));
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    const startSec = Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000); // outside the 48h minute retention
    await seedCardano(db, 2000, 300, startSec);
    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 100, startTime: new Date(startSec * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    await agg.runCycle(60000);
    // retention takes away the minute buckets a rewind used to rebuild the rollups from
    await cds.tx((tx: any) => prune(tx, 'cardano', { minuteHours: 48, hourDays: 90 }));

    await agg.recompute(2100);
    await agg.runCycle(60000);

    const day = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets').where({ chain: 'cardano', granularity: 'day', metricId: 'blocks.count', bucketStart: '2026-01-01T00:00:00.000Z' }));
    expect(day).toHaveLength(1);
    // 600 would mean the blocks above the fork were counted twice — a recompute over the
    // hosted backfill did exactly that, turning 920k blocks into 1.76M
    expect(Number(day[0].count)).toBe(300);
    expect(Number(day[0].fromHeight)).toBe(2000);
    expect(Number(day[0].toHeight)).toBe(2299);
  });
});

describe('token metrics and leaderboards', () => {
  const POLICY = 'a1'.repeat(28);              // 56 hex = policy id
  const UNIT = POLICY + '746f6b656e';          // + "token"
  const SCRIPT_ADDR = 'addr_test1z' + 'c'.repeat(40);   // header type 1 — payment script
  const USER_ADDR = 'addr_test1q' + 'd'.repeat(40);     // header type 0 — payment key
  const PRODUCER = 'pool_vkey_' + 'e'.repeat(20);

  /** Three transactions on one token: a mint, a pure move, and a partial burn. */
  async function seedTokens(db: any, fromHeight: number, startSec: number) {
    const blocks: any[] = [], txs: any[] = [];
    const outs: any[] = [], ins: any[] = [], outAssets: any[] = [], inAssets: any[] = [];
    // [in, out] quantities per transaction
    const plan: Array<[number, number]> = [[0, 1000], [1000, 1000], [1000, 700]];

    plan.forEach(([inQty, outQty], i) => {
      const height = fromHeight + i;
      const t = startSec + i * 20;
      const hash = `tx${i}`.padEnd(64, '0');
      const txSeq = height * 20 * 65536; // slot * 65536 + txIndex, as ODATANO keys the I/O rows
      blocks.push({ hash: `b${i}`.padEnd(64, '0'), time: new Date(t * 1000).toISOString(), height, slot: height * 20, size: 500, txCount: 1, fees: 170000, slotLeader: PRODUCER });
      txs.push({ hash, txSeq, blockHash: `b${i}`.padEnd(64, '0'), blockHeight: height, blockTime: t, slot: height * 20, txIndex: 0, fee: 170000, size: null, hasMetadata: false });
      outs.push({ txSeq, outputIndex: 0, address_address: SCRIPT_ADDR });
      outAssets.push({ output_txSeq: txSeq, output_outputIndex: 0, unit: UNIT, asset_policyId: POLICY, asset_quantity: String(outQty) });
      // lovelace rides along on every output and must never reach a token leaderboard
      outAssets.push({ output_txSeq: txSeq, output_outputIndex: 0, unit: 'lovelace', asset_policyId: '', asset_quantity: '2000000' });
      if (inQty > 0) {
        // the last transaction spends an input the crawler could not resolve (its output
        // predates the crawl start), so it carries no address
        ins.push({ txSeq, inputIndex: 0, address_address: i === 2 ? null : USER_ADDR });
        inAssets.push({ input_txSeq: txSeq, input_inputIndex: 0, unit: UNIT, asset_policyId: POLICY, asset_quantity: String(inQty) });
      }
    });

    // Addresses is a temporal entity — validFrom/validTo are part of its contract
    const era = { validFrom: '2026-01-01T00:00:00.000Z', validTo: '9999-12-31T00:00:00.000Z' };
    await db.run(INSERT.into('odatano.cardano.Addresses').entries([{ address: SCRIPT_ADDR, ...era }, { address: USER_ADDR, ...era }]));
    await db.run(INSERT.into('odatano.cardano.Blocks').entries(blocks));
    await db.run(INSERT.into('odatano.cardano.Transactions').entries(txs));
    await db.run(INSERT.into('odatano.cardano.TransactionOutputs').entries(outs));
    await db.run(INSERT.into('odatano.cardano.TransactionOutputAssets').entries(outAssets));
    await db.run(INSERT.into('odatano.cardano.TransactionInputs').entries(ins));
    await db.run(INSERT.into('odatano.cardano.TransactionInputAssets').entries(inAssets));
    const lastHeight = fromHeight + plan.length - 1;
    await db.run(UPSERT.into('odatano.cardano.CardanoSyncState').entries({
      ID: 'SINGLETON', network: 'preprod', startSlot: fromHeight * 20, lastSlot: lastHeight * 20,
      lastBlockHash: `b${plan.length - 1}`.padEnd(64, '0'), lastHeight, tipHeight: lastHeight, syncStatus: 'synced',
    }));
    return startSec + (plan.length - 1) * 20;
  }

  it('nets mint and burn per transaction and ranks the token exactly', async () => {
    // the source service is cached per chain — without a reset this test would read the
    // database the previous tests seeded, not its own
    resetSourceCache();
    const db = await connectSource('cardano', sqliteFile('cardano-tokens.sqlite'));
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'cardano' }));

    // inside the rolling 24h leaderboard window
    const startSec = Math.floor(now / 3600000) * 3600 - 3600;
    const lastTime = await seedTokens(db, 7000, startSec);
    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 10, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    await agg.runCycle(60000);

    const at = lastTime * 1000;
    // one mint (0 → 1000), one burn (1000 → 700); the middle transaction nets to zero
    expect((await computeWindow(cds.db, 'cardano', 'tokens.mints', '24h', at)).count).toBe(1);
    expect((await computeWindow(cds.db, 'cardano', 'tokens.burns', '24h', at)).count).toBe(1);
    // every transaction produced token output, so all three are transfers
    expect((await computeWindow(cds.db, 'cardano', 'tokens.transfers', '24h', at)).count).toBe(3);
    expect((await computeWindow(cds.db, 'cardano', 'tx.withAssets', '24h', at)).count).toBe(3);

    const top = await getLeaderboard(cds.db, 'cardano', 'token', 'tokens.transfers', '24h', 10, 'sum', at);
    expect(top.entities).toBe(1);                 // lovelace must NOT appear
    expect(top.rows[0].entityId).toBe(UNIT);
    expect(top.rows[0].rank).toBe(1);
    expect(top.rows[0].count).toBe(3);
    expect(Number(top.rows[0].sum)).toBe(2700);   // 1000 + 1000 + 700 output quantity

    const mints = await getLeaderboard(cds.db, 'cardano', 'token', 'tokens.mints', '24h', 10, 'sum', at);
    expect(Number(mints.rows[0].sum)).toBe(1000);
    const burns = await getLeaderboard(cds.db, 'cardano', 'token', 'tokens.burns', '24h', 10, 'sum', at);
    expect(Number(burns.rows[0].sum)).toBe(300);

    // value and UTxO: three outputs created (2 ADA each), two inputs spent — value is in ADA
    expect(Number((await computeWindow(cds.db, 'cardano', 'value.transferred', '24h', at)).sum)).toBe(6);
    expect((await computeWindow(cds.db, 'cardano', 'utxo.created', '24h', at)).count).toBe(3);
    // both inputs count as spent UTxOs, including the one with no resolvable address
    expect((await computeWindow(cds.db, 'cardano', 'utxo.spent', '24h', at)).count).toBe(2);

    // the outputs go to a payment-script address, so it ranks as a script AND as an address
    const scripts = await getLeaderboard(cds.db, 'cardano', 'script', 'value.received', '24h', 10, 'sum', at);
    expect(scripts.rows.map(r => r.entityId)).toEqual([SCRIPT_ADDR]);
    expect(Number(scripts.rows[0].sum)).toBe(6);
    const addresses = await getLeaderboard(cds.db, 'cardano', 'address', 'value.received', '24h', 10, 'sum', at);
    expect(addresses.rows.map(r => r.entityId)).toEqual([SCRIPT_ADDR]);
    // the spending side is a plain key address and must never show up as a script
    const sent = await getLeaderboard(cds.db, 'cardano', 'script', 'value.sent', '24h', 10, 'sum', at);
    expect(sent.entities).toBe(0);
    // ... but only the resolvable one can be credited to an address
    const sentByAddr = await getLeaderboard(cds.db, 'cardano', 'address', 'value.sent', '24h', 10, 'sum', at);
    expect(sentByAddr.rows.map(r => r.entityId)).toEqual([USER_ADDR]);
    expect(sentByAddr.rows[0].count).toBe(1);

    // A distribution bucket keeps sumSq in Decimal(38,6), so a sample's square must stay under
    // ~1e32. Preprod has a faucet output of 25 542 630 277 717 809 lovelace — squared 6.5e32,
    // which overflowed the column and stalled the aggregator until value moved to ADA. SQLite
    // does not enforce decimal precision, so only the magnitude can be asserted here.
    const vb = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets')
      .where({ chain: 'cardano', metricId: 'value.transferred', granularity: 'hour' }));
    expect(vb.length).toBeGreaterThan(0);
    const worstSample = 25_542_630_277_717_809 / 1_000_000;          // the real outlier, in ADA
    expect(worstSample * worstSample).toBeLessThan(1e32);
    for (const b of vb) expect(Number(b.sumSq)).toBeLessThan(1e32);

    // scope keeps the two call shapes apart: an entity-only metric has no chain-wide bucket,
    // and a chain-only one has no per-entity breakdown
    expect((await getMetric(cds.db, 'cardano', 'value.received'))?.scope).toBe('entity');
    expect((await getMetric(cds.db, 'cardano', 'value.transferred'))?.scope).toBe('chain');
    expect((await getMetric(cds.db, 'cardano', 'tokens.mints'))?.scope).toBe('both');

    const producers = await getLeaderboard(cds.db, 'cardano', 'producer', 'blocks.produced', '24h', 10, 'count', at);
    expect(producers.rows[0].entityId).toBe(PRODUCER);
    expect(producers.rows[0].count).toBe(3);
    expect(Number(producers.rows[0].sum)).toBe(1500);   // 3 blocks x 500 bytes

    // per (address, token): the script address received all three outputs of this one token
    const holders = await getLeaderboard(cds.db, 'cardano', 'tokenHolder', 'tokens.received', '24h', 10, 'sum', at, UNIT);
    expect(holders.subject).toBe(UNIT);
    expect(holders.rows.map(r => r.entityId)).toEqual([SCRIPT_ADDR]);
    expect(Number(holders.rows[0].sum)).toBe(2700);   // 1000 + 1000 + 700
    // the spending side is the user address, and only for the two transactions that had inputs
    const spenders = await getLeaderboard(cds.db, 'cardano', 'tokenHolder', 'tokens.sent', '24h', 10, 'sum', at, UNIT);
    expect(spenders.rows.map(r => r.entityId)).toEqual([USER_ADDR]);
    expect(Number(spenders.rows[0].sum)).toBe(1000);  // only the resolvable input carried an address
    // a different token must not pick up these rows
    const other = await getLeaderboard(cds.db, 'cardano', 'tokenHolder', 'tokens.received', '24h', 10, 'sum', at, 'ff'.repeat(28));
    expect(other.entities).toBe(0);

    // the policy dimension carries the same movements, aggregated one level up
    const byPolicy = await getLeaderboard(cds.db, 'cardano', 'policy', 'tokens.transfers', '24h', 10, 'sum', at);
    expect(byPolicy.rows[0].entityId).toBe(POLICY);
    expect(Number(byPolicy.rows[0].sum)).toBe(2700);
  });
});

describe('start height while the source backfills', () => {
  it('ignores header-only rows above the crawl cursor when looking for the start time', async () => {
    resetSourceCache();
    const db = await connectSource('cardano', sqliteFile('cardano-stubs.sqlite'));
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    // an old crawl range (a year back), cursor at its end
    const oldSec = Math.floor(now / 1000) - 365 * 86400;
    await seedCardano(db, 500, 10, oldSec);
    // a tip row far ahead with a current time, as the source writes at the chain tip
    await db.run(INSERT.into('odatano.cardano.Blocks').entries({ hash: 'stub'.padEnd(64, '0'), time: new Date(now).toISOString(), height: 90000, slot: 90000 * 20, size: 0, txCount: 0 }));

    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 50, startTime: new Date(now - 30 * 86400_000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    const r = await agg.runCycle(60000);
    expect(r.skipped).toBeUndefined();
    // the start time lies past the crawled range, so the crawl start is taken, not the stub
    expect((await agg.getCursor())?.startHeight).toBe(500);
    expect((await agg.getCursor())?.lastHeight).toBe(509);
  });
});

describe('certificates and withdrawals', () => {
  const POOL_A = 'pool1' + 'a'.repeat(50), POOL_B = 'pool1' + 'b'.repeat(50);
  const DREP = 'drep1' + 'c'.repeat(50);
  const STAKE = 'stake_test1' + 'd'.repeat(50);

  it('counts each certificate kind, ranks delegation targets and sums withdrawals in ADA', async () => {
    resetSourceCache();
    const db = await connectSource('cardano', sqliteFile('cardano-certs.sqlite'));
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'cardano' }));

    const startSec = Math.floor(now / 3600000) * 3600 - 3600;
    const lastTime = await seedCardano(db, 9000, 6, startSec);   // 6 blocks, tx hashes `<hash>-<i>` on the non-empty ones
    const txs: any[] = await db.run(SELECT.from('odatano.cardano.Transactions').columns('hash').orderBy('blockHeight asc', 'txIndex asc'));
    const [t0, t1, t2, t3] = txs.map(t => String(t.hash));
    await db.run(INSERT.into('odatano.cardano.TransactionCertificates').entries([
      { tx_hash: t0, certIndex: 0, kind: 'stake_registration', stakeAddress: STAKE, deposit: '2000000' },
      // one Conway certificate: pool and vote delegation share the index, two rows
      { tx_hash: t0, certIndex: 1, kind: 'pool_delegation', stakeAddress: STAKE, poolId: POOL_A },
      { tx_hash: t0, certIndex: 1, kind: 'vote_delegation', stakeAddress: STAKE, drepId: DREP },
      { tx_hash: t1, certIndex: 0, kind: 'pool_delegation', stakeAddress: STAKE, poolId: POOL_A },
      { tx_hash: t2, certIndex: 0, kind: 'pool_delegation', stakeAddress: STAKE, poolId: POOL_B },
      { tx_hash: t2, certIndex: 1, kind: 'vote_delegation', stakeAddress: STAKE, drepId: 'drep_always_abstain' },
      { tx_hash: t3, certIndex: 0, kind: 'pool_retirement', poolId: POOL_B, epoch: 500 },
      { tx_hash: t3, certIndex: 1, kind: 'committee_hot_auth' },
    ]));
    await db.run(INSERT.into('odatano.cardano.TransactionWithdrawals').entries([
      { tx_hash: t1, stakeAddress: STAKE, lovelace: '1500000' },
      { tx_hash: t3, stakeAddress: STAKE, lovelace: '2500000' },
      { tx_hash: t2, stakeAddress: 'stake_test17' + 'e'.repeat(50), lovelace: '0' },
    ]));

    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 4, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    const r = await agg.runCycle(60000);
    expect(r.blocks).toBe(6);

    const at = lastTime * 1000;
    const count = async (m: string) => (await computeWindow(cds.db, 'cardano', m, '24h', at)).count;
    expect(await count('certs.stakeRegistrations')).toBe(1);
    expect(await count('certs.poolDelegations')).toBe(3);
    expect(await count('certs.voteDelegations')).toBe(2);
    expect(await count('certs.poolRetirements')).toBe(1);
    expect(await count('certs.other')).toBe(1);
    expect(await count('withdrawals.count')).toBe(3);
    expect(await count('withdrawals.zero')).toBe(1);
    expect((await computeWindow(cds.db, 'cardano', 'withdrawals.value', '24h', at)).sum).toBeCloseTo(4, 6);

    const pools = await getLeaderboard(cds.db, 'cardano', 'pool', 'stake.delegations', '24h', 10, 'count', at);
    expect(pools.rows.map(x => [x.entityId, x.count])).toEqual([[POOL_A, 2], [POOL_B, 1]]);
    const dreps = await getLeaderboard(cds.db, 'cardano', 'drep', 'governance.voteDelegations', '24h', 10, 'count', at);
    expect(dreps.entities).toBe(2);
    expect(dreps.rows.map(x => x.entityId).sort()).toEqual([DREP, 'drep_always_abstain'].sort());
  });
});

describe('stake and governance from epoch snapshots', () => {
  it('ranks pools and DReps from the newest epoch, and records the chain-wide gauges', async () => {
    resetSourceCache();
    const db = await connectSource('cardano', sqliteFile('cardano-epoch.sqlite'));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.Snapshots').where({ chain: 'cardano' }));

    const t313 = Math.floor(now / 1000) - 7200;
    const t314 = Math.floor(now / 1000) - 3600;
    const pool = (epoch: number, time: number, id: string, liveStake: number, blocks: number) => ({
      poolId: id, epoch, snapshotSlot: 1, snapshotTime: time,
      blocksMinted: blocks, blocksEpoch: blocks, liveStake: String(liveStake), liveSize: 0.1,
      liveSaturation: 0.5, liveDelegators: 7, activeStake: String(liveStake), activeSize: 0.1,
      pledge: '0', margin: 0.02, fixedCost: '340000000',
    });
    await db.run(INSERT.into('odatano.cardano.PoolEpochSnapshots').entries([
      // an older epoch that must not be mixed into the result
      pool(313, t313, 'pool_old'.padEnd(56, 'a'), 999_000_000, 99),
      pool(314, t314, 'pool_big'.padEnd(56, 'b'), 500_000_000, 12),
      pool(314, t314, 'pool_small'.padEnd(56, 'c'), 100_000_000, 3),
    ]));
    await db.run(INSERT.into('odatano.cardano.DrepEpochSnapshots').entries([
      { drepId: 'drep_a'.padEnd(58, 'd'), epoch: 314, snapshotSlot: 1, snapshotTime: t314, amount: '300000000', hasScript: false, lastActiveEpoch: 314, retired: false, expired: false },
      { drepId: 'drep_b'.padEnd(58, 'e'), epoch: 314, snapshotSlot: 1, snapshotTime: t314, amount: '100000000', hasScript: false, lastActiveEpoch: 300, retired: true, expired: false },
    ]));

    const src = new CardanoSource(db);
    expect(await src.getLatestSnapshotEpoch()).toBe(314);
    const set = await src.getEpochSnapshots(314);
    await cds.tx((tx: any) => applyEpochSnapshots(tx, 'cardano', set));

    // ADA, not lovelace — same unit as the other value metrics
    const top = await getLeaderboard(cds.db, 'cardano', 'pool', 'stake.live', 'epoch', 10, 'sum');
    expect(top.entities).toBe(2);                       // epoch 313 is not mixed in
    expect(top.rows[0].entityId).toBe('pool_big'.padEnd(56, 'b'));
    expect(Number(top.rows[0].sum)).toBe(500);
    expect(Number(top.rows[1].sum)).toBe(100);

    // blocks come from blocksMinted (lifetime): the source reports blocksEpoch as 0 for every pool
    const blocks = await getLeaderboard(cds.db, 'cardano', 'pool', 'stake.blocksLifetime', 'epoch', 10, 'sum');
    expect(Number(blocks.rows[0].sum)).toBe(12);

    const dreps = await getLeaderboard(cds.db, 'cardano', 'drep', 'governance.votingPower', 'epoch', 10, 'sum');
    expect(dreps.rows.map(r => r.entityId)).toEqual(['drep_a'.padEnd(58, 'd'), 'drep_b'.padEnd(58, 'e')]);
    expect(Number(dreps.rows[0].sum)).toBe(300);

    const gauges = await cds.db.run(SELECT.from('odatano.astra.Snapshots').where({ chain: 'cardano' }));
    const by = Object.fromEntries(gauges.map((g: any) => [g.metricId, Number(g.value)]));
    expect(by['stake.pools']).toBe(2);
    expect(by['stake.totalLive']).toBe(600);            // 500 + 100 ADA
        expect(by['governance.dreps']).toBe(1);             // the retired one does not count
    expect(by['governance.totalPower']).toBe(400);      // but its power still does

    // re-ingesting the same epoch replaces, it must not double
    await cds.tx((tx: any) => applyEpochSnapshots(tx, 'cardano', set));
    const again = await getLeaderboard(cds.db, 'cardano', 'pool', 'stake.live', 'epoch', 10, 'sum');
    expect(Number(again.rows[0].sum)).toBe(500);
  });
});

describe('concentration and distribution', () => {
  it('computes Gini and Nakamoto against values worked out by hand', () => {
    // perfectly equal -> 0
    expect(gini([10, 10, 10, 10])).toBe(0);
    // one holder has everything -> (n-1)/n, the maximum a finite sample can reach
    expect(gini([0, 0, 0, 40])).toBeCloseTo(0.75, 6);
    // textbook example: ascending 1,2,3,4 -> 0.25
    expect(gini([1, 2, 3, 4])).toBeCloseTo(0.25, 6);
    expect(gini([])).toBeNull();
    expect(gini([0, 0])).toBeNull();          // nothing to divide

    // no single holder passes half, the two largest together do
    expect(nakamoto([40, 30, 20, 10], 100)).toBe(2);
    // a single majority holder needs one — 60 of 100 is already past half
    expect(nakamoto([60, 30, 10], 100)).toBe(1);
    // exactly half is not more than half, so it takes one more
    expect(nakamoto([50, 30, 20], 100)).toBe(2);
    expect(nakamoto([1, 1], 0)).toBeNull();
  });

  it('measures pool stake as a holding and token movement as a flow', async () => {
    const pools = await getConcentration(cds.db, 'cardano', 'pool', 'stake.live', 'epoch', 'sum');
    expect(pools.basis).toBe('holding');       // stake IS held, so the number means what it says
    expect(pools.entities).toBe(2);
    expect(pools.total).toBe(600);             // 500 + 100 ADA from the epoch fixture
    expect(pools.nakamoto).toBe(1);            // the 500 pool alone passes half of 600
    expect(pools.top1Share).toBeCloseTo(500 / 600, 6);
    expect(pools.gini).toBeCloseTo(gini([100, 500])!, 6);

    const tokens = await getConcentration(cds.db, 'cardano', 'token', 'tokens.transfers', '24h', 'sum');
    // movement in a window, not holdings — the label keeps that visible
    expect(tokens.basis).toBe('flow');
  });

  it('hands out the stored histogram as bins that add up to the sample count', async () => {
    const d = await getDistribution(cds.db, 'cardano', 'fees.paid', '30d');
    expect(d.count).toBeGreaterThan(0);
    expect(d.binsPerOctave).toBe(8);
    expect(d.bins.reduce((s, b) => s + b.count, 0)).toBe(d.count);
    expect(d.bins.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 6);
    // ascending and non-overlapping, so a client can draw them straight
    for (let i = 1; i < d.bins.length; i++) expect(d.bins[i].lo).toBeGreaterThanOrEqual(d.bins[i - 1].hi);
    // the percentiles must fall inside the range the bins describe
    expect(d.p50!).toBeGreaterThanOrEqual(d.bins[0].lo);
    expect(d.p50!).toBeLessThanOrEqual(d.bins[d.bins.length - 1].hi);
  });
});

describe('sampled verification against an independent indexer', () => {
  it('draws distinct heights inside the range and never more than it has', () => {
    const seq = [0.1, 0.1, 0.5, 0.9];   // the repeat must not produce a duplicate height
    let i = 0;
    const picked = sampleHeights(100, 199, 3, () => seq[i++ % seq.length]);
    expect(new Set(picked).size).toBe(picked.length);
    expect(picked.length).toBe(3);
    for (const h of picked) { expect(h).toBeGreaterThanOrEqual(100); expect(h).toBeLessThanOrEqual(199); }
    expect([...picked]).toEqual([...picked].sort((a, b) => a - b));

    // asking for more than exist yields the whole range, not an endless retry
    expect(sampleHeights(10, 14, 50)).toEqual([10, 11, 12, 13, 14]);
    expect(sampleHeights(10, 9, 5)).toEqual([]);
  });

  it('reports a reason instead of a clean result when it cannot check', async () => {
    const dead = {
      chain: 'cardano' as const,
      getTip: async () => ({ height: 100, network: 'preprod' }),
      getCrawlStartHeight: async () => 100,          // tip == start, nothing to sample
      findFirstHeightAt: async () => null,
      getBlocks: async () => [],
      getTransactions: async () => [],
      getReorgsAfter: async () => [],
    };
    const r = await verifySample(cds.db, dead as any, 'cardano', 'preprod', 10);
    // a run that could not look at anything must not come back as 'no mismatches'
    expect(r.error).toBeTruthy();
    expect(r.samples).toBe(0);
    expect(r.mismatches).toEqual([]);

    const unknownNet = await verifySample(cds.db, dead as any, 'cardano', 'sanchonet', 10);
    expect(unknownNet.error).toContain('sanchonet');
  });

  it('has no reference for Midnight: Koios indexes Cardano, a same-named network is another chain', async () => {
    expect(hasReference('cardano', 'preprod')).toBe(true);
    expect(hasReference('midnight', 'preprod')).toBe(false);
    expect(hasReference('cardano', null)).toBe(false);

    const midnight = {
      chain: 'midnight' as const,
      getTip: async () => ({ height: 5000, network: 'preprod' }),
      getCrawlStartHeight: async () => 1,
      findFirstHeightAt: async () => null,
      getBlocks: async () => { throw new Error('must not read blocks without a reference'); },
      getTransactions: async () => [],
      getReorgsAfter: async () => [],
    };
    const r = await verifySample(cds.db, midnight as any, 'midnight', 'preprod', 10);
    expect(r.error).toContain("chain 'midnight'");
    expect(r.reference).toBe('none');
    expect(r.samples).toBe(0);
  });
});

describe('a cycle the scheduler gives up on', () => {
  it('rejects with the timeout while the cycle hangs, and passes a result that arrives in time', async () => {
    const hung = new Promise<never>(() => { /* never settles: a pool that stopped answering */ });
    await expect(withCycleTimeout('cardano', hung, 20)).rejects.toBeInstanceOf(CycleTimeoutError);
    await expect(withCycleTimeout('cardano', Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    expect(cycleTimeoutMs({ cycleBudgetMs: 20000 })).toBe(120_000);
    expect(cycleTimeoutMs({ cycleBudgetMs: 60000 })).toBe(360_000);
    expect(cycleTimeoutMs({ cycleBudgetMs: 20000, cycleTimeoutMs: 5000 })).toBe(5000);
  });

  it('stops an abandoned cycle before its next write, so a late comeback cannot double-count', async () => {
    // the shared aggregate database still carries the cardano cursor of the earlier cases
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'cardano' }));
    const db = await connectSource('cardano', sqliteFile('cardano-abandon.sqlite'));
    const startSec = Math.floor(now / 60000) * 60 - 7200;
    await seedCardano(db, 100, 120, startSec);
    const source = new CardanoSource(db);
    const agg = new ChainAggregator('cardano', source, {
      chunkBlocks: 40, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    // The second chunk read never returns; the scheduler gives up meanwhile.
    const realGetBlocks = source.getBlocks.bind(source);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    source.getBlocks = async (from: number, to: number) => {
      reads++;
      if (reads === 2) { await gate; }
      return realGetBlocks(from, to);
    };
    const cycle = agg.runCycle(60000);
    await new Promise(r => setTimeout(r, 50));
    agg.abandonCycle();
    await agg.noteFailure('cycle did not return');
    release();                       // the connection "comes back" after the scheduler moved on
    await expect(cycle).rejects.toThrow(/abandoned/);

    const cursor = await agg.getCursor();
    expect(cursor?.lastHeight).toBe(139);         // only the first chunk of 40 was written
    expect(cursor?.lastError).toContain('abandoned');   // the late failure is what the cursor reports last

    // A fresh cycle carries on from there and finishes the range.
    const r = await agg.runCycle(60000);
    expect(r.skipped).toBeUndefined();
    expect((await agg.getCursor())?.lastHeight).toBe(219);
  });

  it('discards a chunk whose cursor a recompute moved meanwhile, so the rewind is not overwritten', async () => {
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'cardano' }));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'cardano' }));
    const db = await connectSource('cardano', sqliteFile('cardano-cas.sqlite'));
    const startSec = Math.floor(now / 60000) * 60 - 7200;
    await seedCardano(db, 100, 120, startSec);
    const opts = {
      chunkBlocks: 40, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    };
    const source = new CardanoSource(db);
    const agg = new ChainAggregator('cardano', source, opts);
    const realGetBlocks = source.getBlocks.bind(source);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    source.getBlocks = async (from: number, to: number) => {
      reads++;
      if (reads === 2) { await gate; }
      return realGetBlocks(from, to);
    };
    const cycle = agg.runCycle(60000);
    await new Promise(r => setTimeout(r, 50));
    // The admin recompute goes through another instance, so only the cursor tells the cycle.
    await new ChainAggregator('cardano', new CardanoSource(db), opts).recompute(110);
    release();
    await expect(cycle).rejects.toThrow(/no longer 139/);
    // the rewind goes back to its bucket boundary; the late chunk must not have moved it to 179
    expect((await agg.getCursor())?.lastHeight).toBeLessThan(110);

    source.getBlocks = realGetBlocks;
    await agg.releaseLease();
    await agg.runCycle(60000);
    expect((await agg.getCursor())?.lastHeight).toBe(219);
    const days = await cds.db.run(SELECT.from('odatano.astra.MetricBuckets').where({ chain: 'cardano', granularity: 'day', metricId: 'blocks.count' }));
    expect(days.reduce((s: number, d: any) => s + Number(d.count), 0)).toBe(120);
  });
});

describe('entity buckets', () => {
  it('adds deltas to hour and day rows in the database, including rows written through CAP', async () => {
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'midnight' }));
    const day = Date.UTC(2024, 0, 10);
    // a row written by CAP itself, so the additive upsert must hit the same key
    await cds.db.run(UPSERT.into('odatano.astra.EntityBuckets').entries({
      chain: 'midnight', dimension: 'address', entityId: 'a', subjectId: '', metricId: 'value.received',
      granularity: 'day', bucketStart: new Date(day).toISOString(), count: 1, sum: '5', fromHeight: 5, toHeight: 5,
    }));

    const first: EntityDeltaMap = new Map();
    addToEntity(first, 'address', 'a', 'value.received', day / 1000 + 3600, 10, 10);
    addToEntity(first, 'address', 'a', 'value.received', day / 1000 + 3700, 2.5, 11);
    expect(await applyEntityDeltas(cds.db, 'midnight', first)).toBe(2); // one hour row, one day row

    const second: EntityDeltaMap = new Map();
    addToEntity(second, 'address', 'a', 'value.received', day / 1000 + 3800, 1, 12);
    addToEntity(second, 'address', 'a', 'value.received', day / 1000 + 7200, 4, 20);
    await applyEntityDeltas(cds.db, 'midnight', second);

    const rows = await cds.db.run(SELECT.from('odatano.astra.EntityBuckets').where({ chain: 'midnight' }).orderBy('granularity', 'bucketStart'));
    // Integer64 and Decimal come back as strings
    const nums = (r: any) => ({ count: Number(r.count), sum: Number(r.sum), fromHeight: Number(r.fromHeight), toHeight: Number(r.toHeight) });
    const byKey = Object.fromEntries(rows.map((r: any) => [`${r.granularity}@${new Date(r.bucketStart).getTime() - day}`, nums(r)]));
    expect(rows).toHaveLength(3);
    expect(byKey['hour@3600000']).toEqual({ count: 3, sum: 13.5, fromHeight: 10, toHeight: 12 });
    expect(byKey['hour@7200000']).toEqual({ count: 1, sum: 4, fromHeight: 20, toHeight: 20 });
    expect(byKey['day@0']).toEqual({ count: 5, sum: 22.5, fromHeight: 5, toHeight: 20 });
  });

  it('keeps hour rows for the 24h window and day rows for the 30d window, and never writes what it would prune', async () => {
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'midnight' }));
    const retention = { minuteHours: 48, hourDays: 90, entityHourDays: 3, entityDayDays: 60 };
    const row = (granularity: string, ageDays: number) => ({
      chain: 'midnight', dimension: 'address', entityId: `e${granularity}${ageDays}`, subjectId: '', metricId: 'value.received',
      granularity, bucketStart: new Date(now - ageDays * 86_400_000).toISOString(), count: 1, sum: '1', fromHeight: 1, toHeight: 1,
    });
    await cds.db.run(INSERT.into('odatano.astra.EntityBuckets').entries([
      row('hour', 1), row('hour', 5), row('day', 10), row('day', 70), row('epoch', 400),
    ]));
    await cds.tx((tx: any) => prune(tx, 'midnight', retention, now));
    const kept = (await cds.db.run(SELECT.from('odatano.astra.EntityBuckets').columns('entityId').where({ chain: 'midnight' }))).map((r: any) => r.entityId).sort();
    // the epoch snapshot is state, not a window, and stays whatever its age
    expect(kept).toEqual(['eday10', 'eepoch400', 'ehour1']);

    // a backfill through old blocks writes only the rows a window can still reach
    const old: EntityDeltaMap = new Map();
    addToEntity(old, 'address', 'b', 'value.received', (now - 10 * 86_400_000) / 1000, 1, 50);   // day row yes, hour row no
    addToEntity(old, 'address', 'c', 'value.received', (now - 70 * 86_400_000) / 1000, 1, 40);   // neither
    addToEntity(old, 'address', 'd', 'value.received', now / 1000, 1, 60);                        // both
    expect(await applyEntityDeltas(cds.db, 'midnight', old, new Date(now).toISOString(), entityHorizon(retention, now))).toBe(3);
    // 0 keeps everything: the same deltas write all six rows
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'midnight' }));
    expect(await applyEntityDeltas(cds.db, 'midnight', old, new Date(now).toISOString(), entityHorizon({ ...retention, entityHourDays: 0, entityDayDays: 0 }, now))).toBe(6);
  });
});

describe('fees filled in after the block (Midnight supplement)', () => {
  const FEE = 120_000;
  async function seedMidnight(db: any, from: number, to: number, startMs: number): Promise<number> {
    let t = startMs;
    for (let h = from; h <= to; h++) {
      t += 6000;
      const id = cds.utils.uuid();
      await db.run(INSERT.into('midnight.Blocks').entries({ ID: id, hash: hex(64) + h, height: h, protocolVersion: 1, timestamp: t, author: 'a', ledgerParameters: 'l' }));
      const tx = cds.utils.uuid();
      await db.run(INSERT.into('midnight.Transactions').entries({ ID: tx, transactionId: 1, hash: 'f' + h, protocolVersion: 1, transactionType: 'REGULAR', txType: 'contract_call', size: 800, block_ID: id }));
      await db.run(INSERT.into('midnight.TransactionFees').entries({ ID: cds.utils.uuid(), paidFees: String(FEE), estimatedFees: '100000', transaction_ID: tx }));
    }
    return t;
  }
  const syncState = (db: any, supplemented: number | null, indexed = 629) =>
    db.run(UPSERT.into('midnight.SyncState').entries({ ID: 'SINGLETON', networkId: 'preprod', lastIndexedHeight: indexed, chainHeight: indexed, lastSupplementedHeight: supplemented, syncStatus: 'synced' }));
  const reset = async () => {
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'midnight' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'midnight' }));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'midnight' }));
  };
  const opts = (startMs: number) => ({
    chunkBlocks: 8, startTime: new Date(startMs).toISOString(), leaseMs: 60000,
    retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
  });

  it('counts fees only up to the supplemented height, then catches up without counting a block twice', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-fees.sqlite'));
    const startMs = now - 30 * 60_000;
    const mid = await seedMidnight(db, 600, 619, startMs);
    await syncState(db, 609, 619);
    const agg = new ChainAggregator('midnight', new MidnightSource(db), opts(startMs));
    await agg.runCycle(60000);

    // blocks that arrive after the fee pass started carry no final fee yet
    const t = await seedMidnight(db, 620, 629, mid);
    await syncState(db, 609);
    await agg.runCycle(60000);
    let c = await agg.getCursor();
    expect(c?.lastHeight).toBe(629);
    expect(c?.feeHeight).toBe(609);
    expect(c?.sourceFeeHeight).toBe(609);
    expect((await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t)).count).toBe(30);
    expect((await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t)).count).toBe(10);

    await syncState(db, 629);
    const r = await agg.runCycle(60000);
    expect(r.feeBlocks).toBe(20);
    c = await agg.getCursor();
    expect(c?.feeHeight).toBe(629);
    const fees = await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t);
    expect(fees.count).toBe(30);
    expect(fees.sum).toBe(30 * FEE);
    expect((await computeWindow(cds.db, 'midnight', 'fees.estimateError', '1h', t)).avg).toBe(20000);
    expect((await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t)).count).toBe(30);
  });

  it('replaces the fees the block pass wrote before, and rewinds with a recompute', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-fees-2.sqlite'));
    const startMs = now - 30 * 60_000;
    const t = await seedMidnight(db, 600, 629, startMs);
    await syncState(db, 629);
    // a source without a fee height: fees come with the block, as before the fee pass existed
    const inline = new MidnightSource(db);
    const plain: any = Object.create(inline);
    plain.getTip = async () => { const tip = await inline.getTip(); delete (tip as any).feeHeight; return tip; };
    const agg = new ChainAggregator('midnight', plain, opts(startMs));
    await agg.runCycle(60000);
    expect((await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t)).count).toBe(30);
    expect((await agg.getCursor())?.feeHeight).toBeNull();

    agg.replaceSource(inline);
    await agg.runCycle(60000);
    expect((await agg.getCursor())?.feeHeight).toBe(629);
    expect((await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t)).count).toBe(30);

    await agg.recompute(615);
    const rewound = await agg.getCursor();
    expect(rewound?.feeHeight).toBeLessThanOrEqual(614);
    expect(rewound?.feeHeight).toBe(rewound?.lastHeight);
    await agg.runCycle(60000);
    const fees = await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t);
    expect(fees.count).toBe(30);
    expect(fees.sum).toBe(30 * FEE);
    expect((await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t)).count).toBe(30);

    await agg.recompute(null);
    expect((await agg.getCursor())?.feeHeight).toBeNull();
    await agg.runCycle(60000);
    expect((await computeWindow(cds.db, 'midnight', 'fees.paid', '1h', t)).sum).toBe(30 * FEE);
  });
});

describe('facts decoded from the ledger payload after the block (Midnight decode pass)', () => {
  const CONTRACT = 'c0'.repeat(32);
  const DUST = 300_000_000_000_000; // 0.3 DUST in specks
  async function seedMidnight(db: any, from: number, to: number, startMs: number): Promise<number> {
    let t = startMs;
    for (let h = from; h <= to; h++) {
      t += 6000;
      const id = cds.utils.uuid();
      await db.run(INSERT.into('midnight.Blocks').entries({ ID: id, hash: hex(64) + h, height: h, protocolVersion: 1, timestamp: t, author: 'a', ledgerParameters: 'l' }));
      const tx = cds.utils.uuid();
      await db.run(INSERT.into('midnight.Transactions').entries({
        ID: tx, transactionId: 1, hash: 'd' + h, protocolVersion: 1, transactionType: 'REGULAR', txType: 'contract_call',
        size: 800, block_ID: id, contractAddress: CONTRACT,
      }));
      await db.run(INSERT.into('midnight.Transactions').entries({
        ID: cds.utils.uuid(), transactionId: 0, hash: 's' + h, protocolVersion: 1, transactionType: 'SYSTEM', block_ID: id,
      }));
    }
    return t;
  }
  /** What the source's decode pass writes for the blocks up to `height`. */
  async function decode(db: any, from: number, to: number) {
    for (let h = from; h <= to; h++) {
      await db.run(UPDATE.entity('midnight.Transactions').set({
        payloadDecode: 'decoded', dustConsumed: String(DUST), dustSpendCount: 1, dustRegistrationCount: 0,
        zswapInputCount: h % 2, zswapOutputCount: 2, zswapTransientCount: 0, circuitName: h % 3 === 0 ? 'claim' : 'increment',
        isShielded: true, hasProof: h % 3 === 0,
      }).where({ hash: 'd' + h }));
      await db.run(UPDATE.entity('midnight.Transactions').set({ payloadDecode: 'absent' }).where({ hash: 's' + h }));
    }
  }
  const syncState = (db: any, decoded: number | null, indexed = 629) =>
    db.run(UPSERT.into('midnight.SyncState').entries({ ID: 'SINGLETON', networkId: 'preview', lastIndexedHeight: indexed, chainHeight: indexed, lastSupplementedHeight: indexed, lastDecodedHeight: decoded, syncStatus: 'synced' }));
  const reset = async () => {
    await cds.db.run(DELETE.from('odatano.astra.ChainCursors').where({ chain: 'midnight' }));
    await cds.db.run(DELETE.from('odatano.astra.MetricBuckets').where({ chain: 'midnight' }));
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'midnight' }));
  };
  const opts = (startMs: number) => ({
    chunkBlocks: 8, startTime: new Date(startMs).toISOString(), leaseMs: 60000,
    retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
  });

  it('counts decoded facts only up to the decoded height, then catches up once', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-decode.sqlite'));
    const startMs = now - 30 * 60_000;
    const t = await seedMidnight(db, 600, 629, startMs);
    await decode(db, 600, 614);
    await syncState(db, 614);
    const agg = new ChainAggregator('midnight', new MidnightSource(db), opts(startMs));
    await agg.runCycle(60000);

    let c = await agg.getCursor();
    expect(c?.lastHeight).toBe(629);
    expect(c?.decodeHeight).toBe(614);
    expect(c?.sourceDecodeHeight).toBe(614);
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(15);
    // the type counts wait for the decode pass as well
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractCalls', '1h', t)).count).toBe(15);

    await decode(db, 615, 629);
    await syncState(db, 629);
    const r = await agg.runCycle(60000);
    expect(r.decodeBlocks).toBe(15);
    c = await agg.getCursor();
    expect(c?.decodeHeight).toBe(629);

    // system transactions are never counted, every regular one once
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(30);
    const dust = await computeWindow(cds.db, 'midnight', 'dust.consumed', '1h', t);
    expect(dust.count).toBe(30);
    expect(dust.sum).toBeCloseTo(30 * DUST / 1e15, 9); // carried in DUST
    expect(dust.max).toBeCloseTo(0.3, 12);
    expect((await computeWindow(cds.db, 'midnight', 'dust.spends', '1h', t)).count).toBe(30);
    expect((await computeWindow(cds.db, 'midnight', 'zswap.outputs', '1h', t)).count).toBe(60);
    expect((await computeWindow(cds.db, 'midnight', 'zswap.inputs', '1h', t)).count).toBe(15);
    expect((await computeWindow(cds.db, 'midnight', 'tx.zswap', '1h', t)).count).toBe(30);
    expect((await computeWindow(cds.db, 'midnight', 'tx.shielded', '1h', t)).count).toBe(30);
    expect((await computeWindow(cds.db, 'midnight', 'tx.withProof', '1h', t)).count).toBe(10);
    expect((await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t)).count).toBe(30);
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractCalls', '1h', t)).count).toBe(30);

    const contracts = await getLeaderboard(cds.db, 'midnight', 'contract', 'contract.calls', '24h', 10, 'count', t);
    expect(contracts.rows.map(r => [r.entityId, r.count])).toEqual([[CONTRACT, 30]]);
    const circuits = await getLeaderboard(cds.db, 'midnight', 'circuit', 'circuit.calls', '24h', 10, 'count', t);
    expect(circuits.rows.map(r => [r.entityId, r.count])).toEqual([['increment', 20], ['claim', 10]]);
  });

  it('rewinds with a recompute and starts over after a full one', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-decode-2.sqlite'));
    const startMs = now - 30 * 60_000;
    const t = await seedMidnight(db, 600, 629, startMs);
    await decode(db, 600, 629);
    await syncState(db, 629);
    const agg = new ChainAggregator('midnight', new MidnightSource(db), opts(startMs));
    await agg.runCycle(60000);
    expect((await agg.getCursor())?.decodeHeight).toBe(629);

    await agg.recompute(615);
    const rewound = await agg.getCursor();
    expect(rewound?.decodeHeight).toBeLessThanOrEqual(614);
    expect(rewound?.decodeHeight).toBe(rewound?.lastHeight);
    await agg.runCycle(60000);
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(30);
    const circuits = await getLeaderboard(cds.db, 'midnight', 'circuit', 'circuit.calls', '24h', 10, 'count', t);
    expect(circuits.rows.reduce((s, r) => s + r.count, 0)).toBe(30);

    await agg.recompute(null);
    expect((await agg.getCursor())?.decodeHeight).toBeNull();
    await agg.runCycle(60000);
    expect((await computeWindow(cds.db, 'midnight', 'dust.consumed', '1h', t)).sum).toBeCloseTo(30 * DUST / 1e15, 9);
  });

  it('counts a transaction by the type the decode pass settled', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-decode-4.sqlite'));
    const startMs = now - 30 * 60_000;
    const t = await seedMidnight(db, 600, 609, startMs);
    await decode(db, 600, 609);
    // the source retypes call-free transactions while decoding; an undecodable one keeps its type
    await db.run(UPDATE.entity('midnight.Transactions').set({ txType: 'shielded_transfer' }).where({ hash: { in: ['d600', 'd601', 'd602'] } }));
    await db.run(UPDATE.entity('midnight.Transactions').set({ txType: 'contract_deploy', payloadDecode: 'failed' }).where({ hash: 'd603' }));
    await syncState(db, 609, 609);
    const agg = new ChainAggregator('midnight', new MidnightSource(db), opts(startMs));
    await agg.runCycle(60000);

    expect((await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t)).count).toBe(10);
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractCalls', '1h', t)).count).toBe(6);
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractDeploys', '1h', t)).count).toBe(1);
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(9);
  });

  it('follows a source that lowers its decoded height and decodes a range again', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-decode-5.sqlite'));
    const startMs = now - 30 * 60_000;
    const t = await seedMidnight(db, 600, 629, startMs);
    await decode(db, 600, 629);
    await syncState(db, 629);
    const agg = new ChainAggregator('midnight', new MidnightSource(db), opts(startMs));
    await agg.runCycle(60000);
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractCalls', '1h', t)).count).toBe(30);

    await syncState(db, 619);
    await agg.runCycle(60000);
    expect((await agg.getCursor())?.decodeHeight).toBe(619);
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(20);
    // the block pass metrics stay
    expect((await computeWindow(cds.db, 'midnight', 'tx.count', '1h', t)).count).toBe(30);

    await db.run(UPDATE.entity('midnight.Transactions').set({ txType: 'shielded_transfer' }).where({ hash: { in: ['d620', 'd621', 'd622'] } }));
    await syncState(db, 629);
    await agg.runCycle(60000);
    expect((await agg.getCursor())?.decodeHeight).toBe(629);
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(30);
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractCalls', '1h', t)).count).toBe(27);
    const contracts = await getLeaderboard(cds.db, 'midnight', 'contract', 'contract.calls', '24h', 10, 'count', t);
    expect(contracts.rows.map(r => [r.entityId, r.count])).toEqual([[CONTRACT, 27]]);
  });

  it('leaves the decoded metrics alone when the source has no decode pass', async () => {
    await reset();
    const db = await connectSource('midnight', sqliteFile('midnight-decode-3.sqlite'));
    const startMs = now - 30 * 60_000;
    const t = await seedMidnight(db, 600, 609, startMs);
    await syncState(db, null, 609);
    const agg = new ChainAggregator('midnight', new MidnightSource(db), opts(startMs));
    const r = await agg.runCycle(60000);
    expect(r.decodeBlocks).toBe(0);
    expect((await agg.getCursor())?.decodeHeight).toBe(599);
    expect((await computeWindow(cds.db, 'midnight', 'tx.decoded', '1h', t)).count).toBe(0);
    expect((await computeWindow(cds.db, 'midnight', 'tx.contractCalls', '1h', t)).count).toBe(0);
  });
});

describe('epoch rankings and a full recompute', () => {
  it('keeps the pool and DRep rankings through a full recompute, and rewrites them when they are gone', async () => {
    resetSourceCache();
    const db = await connectSource('cardano', sqliteFile('cardano-epoch-recompute.sqlite'));
    for (const e of ['EntityBuckets', 'MetricBuckets', 'Snapshots', 'ChainCursors']) {
      await cds.db.run(DELETE.from(`odatano.astra.${e}`).where({ chain: 'cardano' }));
    }
    const startSec = Math.floor(now / 60000) * 60 - 1800;
    await seedCardano(db, 100, 20, startSec);
    await db.run(INSERT.into('odatano.cardano.PoolEpochSnapshots').entries({
      poolId: 'pool_one'.padEnd(56, 'a'), epoch: 50, snapshotSlot: 1, snapshotTime: startSec,
      blocksMinted: 1, blocksEpoch: 1, liveStake: '200000000', liveSize: 0.1, liveSaturation: 0.5, liveDelegators: 1,
      activeStake: '200000000', activeSize: 0.1, pledge: '0', margin: 0.02, fixedCost: '340000000',
    }));
    await db.run(INSERT.into('odatano.cardano.DrepEpochSnapshots').entries({
      drepId: 'drep_one'.padEnd(58, 'd'), epoch: 50, snapshotSlot: 1, snapshotTime: startSec, amount: '70000000',
      hasScript: false, lastActiveEpoch: 50, retired: false, expired: false,
    }));
    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 50, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    const ranked = async () => ({
      pools: (await getLeaderboard(cds.db, 'cardano', 'pool', 'stake.live', 'epoch', 10, 'sum')).rows.map(r => r.entityId),
      dreps: (await getLeaderboard(cds.db, 'cardano', 'drep', 'governance.votingPower', 'epoch', 10, 'sum')).rows.map(r => r.entityId),
    });
    const expected = { pools: ['pool_one'.padEnd(56, 'a')], dreps: ['drep_one'.padEnd(58, 'd')] };

    await agg.runCycle(60000);
    expect(await ranked()).toEqual(expected);

    // the block walk that follows a full recompute never writes epoch rows back
    await agg.recompute(null);
    expect(await ranked()).toEqual(expected);
    await agg.runCycle(60000);
    expect(await ranked()).toEqual(expected);

    // rows lost while the gauges still name the epoch: the next cycle copies it again
    await cds.db.run(DELETE.from('odatano.astra.EntityBuckets').where({ chain: 'cardano', granularity: 'epoch' }));
    expect((await ranked()).pools).toEqual([]);
    await agg.runCycle(60000);
    expect(await ranked()).toEqual(expected);
  });
});

describe('contract users', () => {
  // a preprod wallet: a key address and an order-style script address that share one stake key
  const WALLET_ADDR = 'addr_test1qqlu2mkwq30canztghvwv9hu77xzghp5g5ynkvjfgxnkcv7enaq4hcm9rhuz5hly8dwech3hsk56fxqtd9zzhpvvxx0stfmuyt';
  const ORDER_ADDR = 'addr_test1zqtrglumrq3wpfpvhkks33nym0txzd05eell2x6mcqgcm7wenaq4hcm9rhuz5hly8dwech3hsk56fxqtd9zzhpvvxx0sumapdl';
  const WALLET = 'stake_test1urve7s2mudj3m7p2tljrkhvutcmct2dynq9kj3ptskxrr8ckmd4vt';
  const POOL_ADDR = 'addr_test1w' + 'c'.repeat(52);     // enterprise script address: no stake part
  const OTHER_ADDR = 'addr_test1q' + 'd'.repeat(40);    // not decodable: the address itself is the wallet
  const OTHER_POOL = 'addr_test1w' + 'e'.repeat(52);

  it('derives the stake address from a base address and nothing from the other forms', () => {
    expect(stakeCredentialOf(WALLET_ADDR)).toEqual({ stakeAddress: WALLET, isScript: false });
    expect(stakeCredentialOf(ORDER_ADDR)).toEqual({ stakeAddress: WALLET, isScript: false });
    expect(stakeCredentialOf(POOL_ADDR)).toBeNull();
    expect(stakeCredentialOf(OTHER_ADDR)).toBeNull();
    expect(stakeCredentialOf('addr1w86cprpvnyxcdkj5hlyhmzwwumh6yrxcgctpvdv50rvkknqyhz3rc')).toBeNull();
  });

  it('counts wallets per script and across scripts, leaves reference and collateral inputs out', async () => {
    resetSourceCache();
    const db = await connectSource('cardano', sqliteFile('cardano-script-users.sqlite'));
    for (const e of ['EntityBuckets', 'MetricBuckets', 'ChainCursors']) {
      await cds.db.run(DELETE.from(`odatano.astra.${e}`).where({ chain: 'cardano' }));
    }
    // today, shortly after midnight UTC, so every transaction lands in one day bucket
    const startSec = Math.floor(now / 86_400_000) * 86_400 + 60;
    const blocks: any[] = [], txs: any[] = [], outs: any[] = [], ins: any[] = [];
    const tx = (i: number, inputs: Array<[string, Partial<{ isCollateral: boolean; isReference: boolean }>?]>, outputs: string[]) => {
      const height = 9000 + i, t = startSec + i * 20, txSeq = height * 20 * 65536;
      const bh = `sb${i}`.padEnd(64, '0');
      blocks.push({ hash: bh, time: new Date(t * 1000).toISOString(), height, slot: height * 20, size: 400, txCount: 1, fees: 170000 });
      txs.push({ hash: `stx${i}`.padEnd(64, '0'), txSeq, blockHash: bh, blockHeight: height, blockTime: t, slot: height * 20, txIndex: 0, fee: 170000, size: null, hasMetadata: false });
      inputs.forEach(([address, flags], inputIndex) => ins.push({ txSeq, inputIndex, address_address: address, isCollateral: false, isReference: false, ...flags }));
      outputs.forEach((address, outputIndex) => outs.push({ txSeq, outputIndex, address_address: address }));
      return t;
    };
    tx(0, [[WALLET_ADDR]], [POOL_ADDR]);                                     // the wallet places an order at the pool
    tx(1, [[POOL_ADDR], [WALLET_ADDR, { isReference: true }], [OTHER_ADDR, { isCollateral: true }]], [OTHER_ADDR, POOL_ADDR]); // a batcher pays another wallet
    tx(2, [[WALLET_ADDR]], [ORDER_ADDR]);                                    // an order that stays in the wallet
    tx(3, [[POOL_ADDR]], [ORDER_ADDR]);                                      // the pool fills it: the owner met the pool
    const last = tx(4, [[POOL_ADDR]], [OTHER_POOL]);                        // script to script: nobody
    await db.run(INSERT.into('odatano.cardano.Blocks').entries(blocks));
    await db.run(INSERT.into('odatano.cardano.Transactions').entries(txs));
    await db.run(INSERT.into('odatano.cardano.TransactionOutputs').entries(outs));
    await db.run(INSERT.into('odatano.cardano.TransactionInputs').entries(ins));
    await db.run(UPSERT.into('odatano.cardano.CardanoSyncState').entries({
      ID: 'SINGLETON', network: 'preprod', startSlot: 9000 * 20, lastSlot: 9004 * 20,
      lastBlockHash: 'sb4'.padEnd(64, '0'), lastHeight: 9004, tipHeight: 9004, syncStatus: 'synced',
    }));
    const agg = new ChainAggregator('cardano', new CardanoSource(db), {
      chunkBlocks: 10, startTime: new Date((startSec - 60) * 1000).toISOString(), leaseMs: 60000,
      retention: { minuteHours: 48, hourDays: 90 }, log: { info() {}, warn() {} },
    });
    await agg.runCycle(60000);
    const at = last * 1000;

    // the pool met two wallets, one of them twice (order placed, order filled); the order address only its owner
    const pool = await getLeaderboard(cds.db, 'cardano', 'scriptUser', 'script.interactions', '24h', 10, 'count', at, POOL_ADDR);
    expect(pool.rows.map(r => [r.entityId, r.count])).toEqual([[WALLET, 2], [OTHER_ADDR, 1]]);
    const order = await getLeaderboard(cds.db, 'cardano', 'scriptUser', 'script.interactions', '24h', 10, 'count', at, ORDER_ADDR);
    expect(order.rows.map(r => [r.entityId, r.count])).toEqual([[WALLET, 2]]);
    // across all scripts a wallet counts once, with its interactions added up
    const all = await getLeaderboard(cds.db, 'cardano', 'scriptUser', 'script.interactions', '24h', 10, 'count', at);
    expect(all.entities).toBe(2);
    expect(all.rows.map(r => [r.entityId, r.count])).toEqual([[WALLET, 4], [OTHER_ADDR, 1]]);
    // scripts by wallets: count = wallets, sum = the transactions behind them
    const scripts = await getSubjectRanking(cds.db, 'cardano', 'scriptUser', 'script.interactions', '24h', 10, at);
    expect(scripts.rows.map(r => [r.entityId, r.count, r.sum])).toEqual([[POOL_ADDR, 2, 3], [ORDER_ADDR, 1, 2]]);
    // the day view: distinct wallets and scripts, and the pairs' transactions
    const daily = await readScriptUsersDaily(cds.db, ['cardano'], null, null, at);
    expect(daily.map(r => [r.users, r.scripts, r.interactions])).toEqual([[2, 2, 5]]);
    // reference and collateral inputs are not spent: 5 real inputs, not 7
    expect((await computeWindow(cds.db, 'cardano', 'utxo.spent', '24h', at)).count).toBe(5);
    expect((await computeWindow(cds.db, 'cardano', 'utxo.created', '24h', at)).count).toBe(6);
  });
});
