/**
 * Fills the local SQLite *source* databases (sources/cardano.sqlite,
 * sources/midnight.sqlite) with synthetic chain data so `cds watch` shows
 * numbers without access to the box.
 *
 * The files use the real ODATANO / NIGHTGATE schemas (source-models/), i.e.
 * exactly the tables the hosted Postgres databases have. Running the script
 * again appends blocks from the last block up to "now" – a cheap way to
 * simulate a live chain while the aggregator polls.
 *
 *   npm run sources:seed              append up to now (first run: last 26 h)
 *   npm run sources:seed -- --hours 72
 *   npm run sources:reset             delete the files and seed afresh
 *   npm run sources:seed -- --reorg   append a reorg entry that rolls back the last 5 blocks
 */
import cds from '@sap/cds';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connectSource, loadSourceModel } from '../srv/sources/source-db';

const { SELECT, INSERT, UPSERT, DELETE } = cds.ql;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HOURS = Number(opt('hours', '26'));
const uuid = () => cds.utils.uuid();
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

async function main() {
  mkdirSync(path.join(cds.root, 'sources'), { recursive: true });
  if (flag('reset')) {
    for (const f of ['cardano.sqlite', 'midnight.sqlite']) rmSync(path.join(cds.root, 'sources', f), { force: true });
    console.log('sources reset');
  }
  await cds.connect.to('db').catch(() => undefined);
  await seedCardano();
  await seedMidnight();
  await (cds as any).shutdown?.();
  process.exit(0);
}

async function seedCardano() {
  const db = await connectSource('cardano');
  const nowSec = Math.floor(Date.now() / 1000);
  const state = await db.run(SELECT.one.from('odatano.cardano.CardanoSyncState').where({ ID: 'SINGLETON' }));
  const last = await db.run(SELECT.one.from('odatano.cardano.Blocks').columns('height', 'slot', 'time', 'hash').orderBy('height desc'));
  let height = last ? Number(last.height) : 4_200_000;
  let slot = last ? Number(last.slot) : 95_000_000;
  let t = last ? Math.floor(Date.parse(last.time) / 1000) : nowSec - HOURS * 3600;
  let prevHash = last?.hash ?? hex(64);
  if (flag('reorg') && last) {
    const fork = height - 5;
    await db.run(DELETE.from('odatano.cardano.Transactions').where({ blockHeight: { '>': fork } }));
    await db.run(DELETE.from('odatano.cardano.Blocks').where({ height: { '>': fork } }));
    const forkBlock = await db.run(SELECT.one.from('odatano.cardano.Blocks').where({ height: fork }));
    await db.run(INSERT.into('odatano.cardano.CardanoReorgLog').entries({
      ID: uuid(), detectedAt: new Date().toISOString(), forkSlot: Number(forkBlock.slot), forkHeight: fork,
      oldTipHash: prevHash, newTipHash: forkBlock.hash, blocksRolledBack: 5, status: 'completed',
    }));
    height = fork; slot = Number(forkBlock.slot); t = Math.floor(Date.parse(forkBlock.time) / 1000); prevHash = forkBlock.hash;
    console.log(`[cardano] reorg: rolled back to ${fork}`);
  }
  let blocks = 0, txs = 0;
  const startSlot = state?.startSlot ?? slot;
  while (t < nowSec - 20) {
    const dt = between(5, 45); // preprod: ~20 s average
    t += dt; slot += dt; height++;
    const n = rnd() < 0.15 ? 0 : between(1, 14);
    const hash = hex(64);
    const txRows: any[] = [];
    let fees = 0, size = 1000;
    for (let i = 0; i < n; i++) {
      const fee = between(165_000, 900_000);
      const sz = between(250, 6_000);
      fees += fee; size += sz;
      txRows.push({
        hash: hex(64), blockHash: hash, blockHeight: height, blockTime: t, slot, txIndex: i,
        fee, deposit: 0, size: sz, hasMetadata: rnd() < 0.2, hasInputs: true, hasOutputs: true,
      });
    }
    await db.run(INSERT.into('odatano.cardano.Blocks').entries({
      hash, time: new Date(t * 1000).toISOString(), height, slotLeader: `pool1${hex(20)}`,
      epochNumber: Math.floor(slot / 432_000), slot, epochSlot: slot % 432_000, size, txCount: n, fees,
    }));
    if (txRows.length) await db.run(INSERT.into('odatano.cardano.Transactions').entries(txRows));
    prevHash = hash; blocks++; txs += n;
  }
  await db.run(UPSERT.into('odatano.cardano.CardanoSyncState').entries({
    ID: 'SINGLETON', network: 'preprod', startSlot, startBlockHash: hex(64),
    lastSlot: slot, lastBlockHash: prevHash, lastHeight: height, lastIndexedAt: new Date().toISOString(),
    tipSlot: slot, tipHeight: height, syncStatus: 'synced', consecutiveErrors: 0, desiredRunning: true,
  }));
  console.log(`[cardano] +${blocks} blocks, +${txs} tx → tip ${height}`);
}

async function seedMidnight() {
  const db = await connectSource('midnight');
  const nowMs = Date.now();
  const last = await db.run(SELECT.one.from('midnight.Blocks').columns('ID', 'height', 'timestamp', 'hash').orderBy('height desc'));
  let height = last ? Number(last.height) : 2_900_000;
  let t = last ? Number(last.timestamp) : nowMs - HOURS * 3600_000;
  let prevHash = last?.hash ?? hex(64);
  let prevId: string | null = last?.ID ?? null;
  if (flag('reorg') && last) {
    const fork = height - 5;
    const gone = await db.run(SELECT.from('midnight.Blocks').columns('ID').where({ height: { '>': fork } }));
    const ids = gone.map((b: any) => b.ID);
    if (ids.length) {
      const txIds = (await db.run(SELECT.from('midnight.Transactions').columns('ID').where({ block_ID: { in: ids } }))).map((x: any) => x.ID);
      if (txIds.length) {
        await db.run(DELETE.from('midnight.TransactionFees').where({ transaction_ID: { in: txIds } }));
        await db.run(DELETE.from('midnight.TransactionResults').where({ transaction_ID: { in: txIds } }));
        await db.run(DELETE.from('midnight.Transactions').where({ ID: { in: txIds } }));
      }
      await db.run(DELETE.from('midnight.Blocks').where({ ID: { in: ids } }));
    }
    const forkBlock = await db.run(SELECT.one.from('midnight.Blocks').where({ height: fork }));
    await db.run(INSERT.into('midnight.ReorgLog').entries({
      ID: uuid(), detectedAt: new Date().toISOString(), forkHeight: fork, oldTipHash: prevHash, newTipHash: forkBlock.hash,
      blocksRolledBack: 5, blocksReIndexed: 0, status: 'completed',
    }));
    height = fork; t = Number(forkBlock.timestamp); prevHash = forkBlock.hash; prevId = forkBlock.ID;
    console.log(`[midnight] reorg: rolled back to ${fork}`);
  }
  let blocks = 0, txs = 0;
  const TX_TYPES = ['night_transfer', 'shielded_transfer', 'contract_call', 'contract_call', 'contract_deploy', 'dust_registration'];
  while (t < nowMs - 6000) {
    t += between(5000, 7000); height++;
    const id = uuid(), hash = hex(64);
    await db.run(INSERT.into('midnight.Blocks').entries({
      ID: id, hash, height, protocolVersion: 1, timestamp: t, author: hex(64), ledgerParameters: hex(16), parent_ID: prevId,
    }));
    const n = rnd() < 0.35 ? 0 : between(1, 5);
    const txRows: any[] = [], feeRows: any[] = [], resRows: any[] = [];
    // one SYSTEM extrinsic per block (timestamp inherent) – must not count as a transaction
    txRows.push({ ID: uuid(), transactionId: 0, hash: hex(64), protocolVersion: 1, transactionType: 'SYSTEM', txType: 'system', isShielded: false, hasProof: false, size: 12, block_ID: id });
    for (let i = 1; i <= n; i++) {
      const txId = uuid();
      const txType = TX_TYPES[between(0, TX_TYPES.length - 1)];
      const shielded = txType === 'shielded_transfer';
      const est = between(60_000_000, 300_000_000); // specks: real fees sit around 1e8 (0.1 µDUST)
      const paid = Math.max(1_000_000, est + between(-30_000_000, 45_000_000));
      txRows.push({
        ID: txId, transactionId: i, hash: hex(64), protocolVersion: 1, transactionType: 'REGULAR', txType,
        isShielded: shielded, hasProof: shielded || txType.startsWith('contract'), size: between(400, 9000),
        contractAddress: txType.startsWith('contract') ? hex(64) : null, circuitName: txType === 'contract_call' ? 'attest' : null, block_ID: id,
      });
      feeRows.push({ ID: uuid(), paidFees: String(paid), estimatedFees: String(est), transaction_ID: txId });
      resRows.push({ ID: uuid(), status: rnd() < 0.05 ? 'FAILURE' : 'SUCCESS', outcomeSource: 'substrate-system-events', transaction_ID: txId });
    }
    await db.run(INSERT.into('midnight.Transactions').entries(txRows));
    if (feeRows.length) await db.run(INSERT.into('midnight.TransactionFees').entries(feeRows));
    if (resRows.length) await db.run(INSERT.into('midnight.TransactionResults').entries(resRows));
    prevHash = hash; prevId = id; blocks++; txs += n;
  }
  await db.run(UPSERT.into('midnight.SyncState').entries({
    ID: 'SINGLETON', networkId: 'preprod', lastIndexedHeight: height, lastIndexedHash: prevHash, lastIndexedAt: new Date().toISOString(),
    lastFinalizedHeight: height, lastFinalizedHash: prevHash, nodeUrl: 'wss://demo', chainHeight: height + 2, syncStatus: 'synced',
    reorgGeneration: 0, syncProgress: 100, blocksPerSecond: 0.17, consecutiveErrors: 0,
  }));
  console.log(`[midnight] +${blocks} blocks, +${txs} tx → tip ${height}`);
}

loadSourceModel('cardano'); // warm
main().catch(e => { console.error(e); process.exit(1); });
