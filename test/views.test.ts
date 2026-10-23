/**
 * The ready-made views: KeyFigures, the daily topic entities, StakeEpochs and the named
 * rankings — as functions and through the OData service, because the service is where the
 * query options ($filter, $top, key access) are honoured by our own code.
 *
 * The server runs on an in-memory SQLite with the metric catalogue from db/data; the buckets
 * are seeded directly, three days back plus one live hour, so the windows have known answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { register } from 'tsx/cjs/api';
import cds from '@sap/cds';
import '../srv/server'; // the bootstrap hook that serves the dashboard pages
import { addSample } from '../srv/aggregator/histogram';
import { newMerged, toRow, type Merged } from '../srv/aggregator/store';
import { DAILY_VIEWS, readDailyView, readScriptUsersDaily, readStakeEpochs } from '../srv/views/daily';
import { RANKINGS, readKeyFigures, readRanking } from '../srv/views/figures';
import { applyQuery, parseQuery } from '../srv/views/query';

const root = path.resolve(__dirname, '..');
const { INSERT } = cds.ql;
const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = Date.now();
const today = Math.floor(NOW / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);

function merged(values: number[], from: number, to: number): Merged {
  const m = newMerged();
  for (const v of values) {
    m.count++; m.sum += v; m.sumSq += v * v;
    m.min = m.min === null ? v : Math.min(m.min, v);
    m.max = m.max === null ? v : Math.max(m.max, v);
    addSample(m.hist, v);
  }
  m.fromHeight = from; m.toHeight = to;
  return m;
}

let server: any;
let url: string;
const get = async (p: string) => {
  const res = await fetch(url + '/odata/v4/analytics' + p);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
};

beforeAll(async () => {
  process.env.SKIP_AUTO_INIT = 'true';
  process.env.CDS_TYPESCRIPT = 'true'; // let CAP pick srv/astra-service.ts as the implementation
  register(); // CAP requires srv/astra-service.ts itself; tsx makes that work under vitest
  cds.root = root;
  // a file, not ':memory:': every pooled connection to an in-memory SQLite is its own empty database
  (cds.env.requires as any).db = { kind: 'sqlite', credentials: { url: path.join(mkdtempSync(path.join(os.tmpdir(), 'astra-views-')), 'astra.sqlite') } };
  const cdsServer = require('@sap/cds/server');
  server = await cdsServer({ port: 0, in_memory: true, silent: true }); // in_memory only means: deploy the schema and the CSV catalogue first
  url = `http://localhost:${server.address().port}`;

  const at = iso(NOW);
  const rows: Record<string, unknown>[] = [];
  for (let d = 0; d < 3; d++) {
    const start = today - d * DAY;
    const h = 1000 - d * 100;
    rows.push(toRow('cardano', 'tx.count', 'day', start, merged(Array(10 + d).fill(1), h, h + 9), at));
    rows.push(toRow('cardano', 'fees.paid', 'day', start, merged([100, 200, 300, 400, 1000].map(x => x * (d + 1)), h, h + 9), at));
    rows.push(toRow('cardano', 'blocks.count', 'day', start, merged(Array(5).fill(1), h, h + 9), at));
    rows.push(toRow('cardano', 'blocks.interval', 'day', start, merged([10, 20, 30, 40], h, h + 9), at));
    rows.push(toRow('cardano', 'value.transferred', 'day', start, merged([5, 15], h, h + 9), at));
    rows.push(toRow('midnight', 'tx.count', 'day', start, merged(Array(7).fill(1), 50 + d, 55 + d), at));
    rows.push(toRow('midnight', 'tx.shielded', 'day', start, merged(Array(3).fill(1), 50 + d, 55 + d), at));
  }
  // the live hour and one hour inside the previous 24h window
  const hourStart = Math.floor(NOW / HOUR) * HOUR;
  rows.push(toRow('cardano', 'tx.count', 'hour', hourStart, merged(Array(4).fill(1), 1000, 1003), at));
  rows.push(toRow('cardano', 'tx.count', 'hour', hourStart - 30 * HOUR, merged(Array(8).fill(1), 900, 907), at));
  await cds.db.run(INSERT.into('odatano.astra.MetricBuckets').entries(rows));

  const ents: Record<string, unknown>[] = [
    ['tokA', 30, 3000], ['tokB', 50, 10], ['tokC', 5, 99999],
  ].map(([id, count, sum]) => ({
    chain: 'cardano', dimension: 'token', entityId: id, subjectId: '', metricId: 'tokens.transfers', granularity: 'day',
    bucketStart: iso(today), count, sum, fromHeight: 1000, toHeight: 1009, computedAt: at,
  }));
  for (const [id, sum] of [['pool1', 5_000_000], ['pool2', 7_000_000]] as const) {
    ents.push({ chain: 'cardano', dimension: 'pool', entityId: id, subjectId: '', metricId: 'stake.live', granularity: 'epoch', bucketStart: iso(today), count: 1, sum, fromHeight: 1000, toHeight: 1000, computedAt: at });
  }
  // contract users: two wallets at script A, one of them at script B as well
  for (const [script, wallet, count] of [['scriptA', 'w1', 3], ['scriptA', 'w2', 1], ['scriptB', 'w1', 2]] as const) {
    ents.push({ chain: 'cardano', dimension: 'scriptUser', entityId: `${script}|${wallet}`, subjectId: script, metricId: 'script.interactions', granularity: 'day', bucketStart: iso(today), count, sum: count, fromHeight: 1000, toHeight: 1009, computedAt: at });
  }
  await cds.db.run(INSERT.into('odatano.astra.EntityBuckets').entries(ents));

  await cds.db.run(INSERT.into('odatano.astra.Snapshots').entries([
    { chain: 'cardano', metricId: 'stake.pools', takenAt: iso(today - DAY), value: '2', payload: '{"epoch":300}' },
    { chain: 'cardano', metricId: 'stake.totalLive', takenAt: iso(today - DAY), value: '11.5', payload: '{"epoch":300}' },
    { chain: 'cardano', metricId: 'stake.pools', takenAt: iso(today), value: '3', payload: '{"epoch":301}' },
    { chain: 'cardano', metricId: 'governance.dreps', takenAt: iso(today), value: '4', payload: '{"epoch":301}' },
  ]));
}, 60_000);

afterAll(async () => { await new Promise(r => server?.close(r)); });

describe('catalogue and enum', () => {
  it('MetricId lists exactly the ids of the catalogue', () => {
    const def: any = cds.model!.definitions['AstraService.MetricId'];
    const inEnum = new Set(Object.values(def.enum as Record<string, { val: string }>).map(e => e.val));
    const csv = readFileSync(path.join(root, 'db/data/odatano.astra-Metrics.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
    const inCsv = new Set(csv.map(l => l.split(';')[1]));
    expect([...inEnum].sort()).toEqual([...inCsv].sort());
  });
  it('every view column and ranking names a metric the catalogue knows', () => {
    const csv = readFileSync(path.join(root, 'db/data/odatano.astra-Metrics.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
    const known = new Set(csv.map(l => l.split(';')[1]));
    for (const [view, def] of Object.entries(DAILY_VIEWS)) {
      for (const c of def.columns) expect(known.has(c.metric), `${view}.${c.name} -> ${c.metric}`).toBe(true);
      for (const m of Object.values(def.units ?? {})) expect(known.has(m), `${view} unit ${m}`).toBe(true);
    }
    for (const [name, r] of Object.entries(RANKINGS)) expect(known.has(r.metric), `${name} -> ${r.metric}`).toBe(true);
  });
});

describe('query options for computed entities', () => {
  const req = (SELECT: any) => ({ query: { SELECT }, reject: (code: number, msg: string) => { throw Object.assign(new Error(msg), { code }); } });
  const rows = [
    { chain: 'cardano', day: '2026-09-21', n: 3 },
    { chain: 'cardano', day: '2026-09-22', n: 1 },
    { chain: 'midnight', day: '2026-09-22', n: 2 },
  ];
  it('filters, narrows, orders and pages', () => {
    const q = parseQuery(req({
      where: [{ ref: ['chain'] }, '=', { val: 'cardano' }, 'and', { ref: ['day'] }, '>=', { val: '2026-09-22' }],
      orderBy: [{ ref: ['n'], sort: 'desc' }], limit: { rows: { val: 5 } }, count: true,
    }));
    expect(q.constraints.eq.get('chain')).toEqual(['cardano']);
    expect(q.constraints.ranges.get('day')).toEqual([{ op: '>=', value: '2026-09-22' }]);
    const out = applyQuery(rows, q);
    expect(out.map(r => r.n)).toEqual([1]);
    expect(out.$count).toBe(1);
  });
  it('an or never narrows but still filters', () => {
    const q = parseQuery(req({ where: [{ ref: ['chain'] }, '=', { val: 'cardano' }, 'or', { ref: ['n'] }, '=', { val: 2 }] }));
    expect(q.constraints.eq.size).toBe(0);
    expect(applyQuery(rows, q).length).toBe(3);
  });
  it('a key in the URL is a filter too', () => {
    const q = parseQuery(req({ from: { ref: [{ id: 'X', where: [{ ref: ['chain'] }, '=', { val: 'midnight' }] }] } }));
    expect(q.constraints.eq.get('chain')).toEqual(['midnight']);
    expect(applyQuery(rows, q)).toEqual([rows[2]]);
  });
  it('compares dates with and without time, and numbers as numbers', () => {
    const q = parseQuery(req({ where: [{ ref: ['day'] }, '<=', { val: '2026-09-21T00:00:00.000Z' }, 'and', { ref: ['n'] }, '>', { val: '2' }] }));
    expect(applyQuery(rows, q)).toEqual([rows[0]]);
  });
  it('refuses what it cannot evaluate instead of ignoring it', () => {
    expect(() => parseQuery(req({ where: [{ func: 'contains', args: [{ ref: ['chain'] }, { val: 'car' }] }] }))).toThrow(/unsupported \$filter/);
  });
  it('a plain read gets the default order', () => {
    const q = parseQuery(req({}));
    expect(applyQuery(rows, q, [{ column: 'day', desc: true }, { column: 'chain' }]).map(r => `${r.day}/${r.chain}`))
      .toEqual(['2026-09-22/cardano', '2026-09-22/midnight', '2026-09-21/cardano']);
  });
});

describe('daily views', () => {
  it('FeesDaily: total, count and percentiles per day in the chain unit', async () => {
    const rows = await readDailyView(cds.db, 'FeesDaily', ['cardano', 'midnight']);
    expect(rows.filter(r => r.chain === 'midnight')).toHaveLength(0); // no fee buckets seeded there
    const first = rows.find(r => r.chain === 'cardano' && r.day === dayOf(today))!;
    expect(first.totalFees).toBe(2000);
    expect(first.feePayingTx).toBe(5);
    expect(first.avgFee).toBe(400);
    expect(first.maxFee).toBe(1000);
    expect(first.feeUnit).toBe('lovelace');
    expect(Number(first.medianFee)).toBeGreaterThan(280);
    expect(Number(first.medianFee)).toBeLessThan(320);
    expect(first.fromHeight).toBe(1000);
    expect(first.toHeight).toBe(1009);
  });
  it('TransactionsDaily keeps both chains in one table, null where a chain lacks the column', async () => {
    const rows = await readDailyView(cds.db, 'TransactionsDaily', ['cardano', 'midnight'], dayOf(today), dayOf(today));
    expect(rows).toHaveLength(2);
    const c = rows.find(r => r.chain === 'cardano')!, m = rows.find(r => r.chain === 'midnight')!;
    expect(c.transactions).toBe(10);
    expect(c.shielded).toBeNull();
    expect(c.volume).toBe(20);
    expect(c.volumeUnit).toBe('ADA');
    expect(m.transactions).toBe(7);
    expect(m.shielded).toBe(3);
    expect(m.volume).toBeNull();
  });
  it('BlocksDaily averages the interval distribution', async () => {
    const rows = await readDailyView(cds.db, 'BlocksDaily', ['cardano'], dayOf(today - DAY), dayOf(today - DAY));
    expect(rows).toHaveLength(1);
    expect(rows[0].blocks).toBe(5);
    expect(rows[0].avgBlockTimeSec).toBe(25);
    expect(rows[0].maxBlockTimeSec).toBe(40);
    expect(rows[0].avgBlockSizeBytes).toBeNull(); // not seeded
  });
  it('StakeEpochs folds the gauge snapshots into one row per epoch', async () => {
    const rows = await readStakeEpochs(cds.db, ['cardano', 'midnight']);
    expect(rows.map(r => r.epoch).sort()).toEqual([300, 301]);
    const e301 = rows.find(r => r.epoch === 301)!;
    expect(e301.pools).toBe(3);
    expect(e301.activeDreps).toBe(4);
    expect(e301.totalLiveStakeAda).toBeUndefined();
    expect(rows.find(r => r.epoch === 300)!.totalLiveStakeAda).toBe(11.5);
  });
});

describe('key figures and rankings', () => {
  it('KeyFigures unrolls a metric over the windows with previous and change', async () => {
    const rows = await readKeyFigures(cds.db, ['cardano'], ['tx.count'], ['24h', '7d', '14d']);
    const by = Object.fromEntries(rows.map(r => [r.window, r]));
    expect(rows.map(r => r.window).sort()).toEqual(['14d', '24h', '7d']);
    expect(by['7d'].value).toBe(33);          // 10 + 11 + 12 over the three seeded days
    expect(by['14d'].value).toBe(33);
    expect(by['24h'].value).toBe(4);          // the live hour
    expect(by['24h'].previous).toBe(8);       // the hour 30 h ago sits in the window before
    expect(by['24h'].changePct).toBe(-50);
    expect(by['7d'].name).toBe('Transactions');
    expect(by['7d'].unit).toBe('tx');
  });
  it('KeyFigures skips gauges and entity-only metrics', async () => {
    const rows = await readKeyFigures(cds.db, ['cardano'], null, ['7d']);
    const ids = rows.map(r => r.metric);
    expect(ids).toContain('fees.paid');
    expect(ids).not.toContain('stake.pools');
    expect(ids).not.toContain('value.received');
  });
  it('TopTokens ranks by number of transfers, not by quantity', async () => {
    const rows = await readRanking(cds.db, 'TopTokens', ['cardano', 'midnight'], ['7d'], 20);
    expect(rows.map(r => r.entityId)).toEqual(['tokB', 'tokA', 'tokC']);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].entities).toBe(3);
    expect(rows[0].unit).toBe('moves');
  });
  it('TopScriptsByUsers ranks scripts by distinct wallets, and ScriptUsersDaily counts each wallet once', async () => {
    const rows = await readRanking(cds.db, 'TopScriptsByUsers', ['cardano'], ['7d'], 20);
    expect(rows.map(r => [r.entityId, r.count, Number(r.sum)])).toEqual([['scriptA', 2, 4], ['scriptB', 1, 2]]);
    expect(rows[0].entities).toBe(2);
    const daily = await readScriptUsersDaily(cds.db, ['cardano']);
    expect(daily.map(r => [r.day, r.users, r.scripts, r.interactions])).toEqual([[dayOf(today), 2, 2, 6]]);
  });
  it('TopPools reads the newest epoch snapshot by stake', async () => {
    const rows = await readRanking(cds.db, 'TopPools', ['cardano'], null, 20);
    expect(rows.map(r => [r.window, r.entityId])).toEqual([['epoch', 'pool2'], ['epoch', 'pool1']]);
  });
});

describe('through the OData service', () => {
  it('serves the daily views with $filter, $orderby and $top', async () => {
    const r = await get(`/FeesDaily?$filter=chain eq 'cardano'&$orderby=day desc&$top=2`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.value).toHaveLength(2);
    expect(r.json.value[0].day).toBe(dayOf(today));
    expect(Number(r.json.value[0].totalFees)).toBe(2000);
  });
  it('serves the contract users through the ranking and the daily view', async () => {
    const top = await get(`/TopScriptsByUsers?$filter=window eq '7d' and rank le 1`);
    expect(top.status, JSON.stringify(top.json)).toBe(200);
    expect(top.json.value.map((r: any) => [r.entityId, r.count])).toEqual([['scriptA', 2]]);
    const daily = await get(`/ScriptUsersDaily?$filter=chain eq 'cardano'`);
    expect(daily.status, JSON.stringify(daily.json)).toBe(200);
    expect(daily.json.value.map((r: any) => [r.users, r.scripts])).toEqual([[2, 2]]);
  });
  it('a date range on TransactionsDaily spans both chains', async () => {
    const r = await get(`/TransactionsDaily?$filter=day ge ${dayOf(today - DAY)}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.value).toHaveLength(4);
    expect(new Set(r.json.value.map((x: any) => x.chain))).toEqual(new Set(['cardano', 'midnight']));
  });
  it('key access reads one row', async () => {
    const r = await get(`/BlocksDaily(chain='cardano',day=${dayOf(today)})`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(Number(r.json.blocks)).toBe(5);
  });
  it('KeyFigures pinned to chain, metric and window', async () => {
    const r = await get(`/KeyFigures?$filter=chain eq 'cardano' and metric eq 'tx.count' and window eq '7d'`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.value).toHaveLength(1);
    expect(Number(r.json.value[0].value)).toBe(33);
  });
  it('TopTokens with a rank bound and $count', async () => {
    const r = await get(`/TopTokens?$filter=window eq '7d' and rank le 2&$count=true`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.value.map((x: any) => x.entityId)).toEqual(['tokB', 'tokA']);
    expect(r.json['@odata.count']).toBe(2);
  });
  it('StakeEpochs newest first', async () => {
    const r = await get(`/StakeEpochs`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.value.map((x: any) => x.epoch)).toEqual([301, 300]);
  });
  it('an unsupported filter is a 400, not a silently full table', async () => {
    const r = await get(`/FeesDaily?$filter=contains(chain,'car')`);
    expect(r.status).toBe(400);
  });
  it('the 14d window reaches the functions too', async () => {
    const r = await get(`/getWindow(chain='cardano',metric='tx.count',window='14d')`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(Number(r.json.value)).toBe(33);
  });
});

describe('fee coverage in the chain overview', () => {
  it('reports how far the fees reach and leaves the fee figures empty while they trail', async () => {
    const sec = (ms: number) => Math.floor(ms / 1000);
    await cds.db.run(cds.ql.UPSERT.into('odatano.astra.ChainCursors').entries([
      { chain: 'cardano', lastHeight: 1009, lastBlockTime: sec(NOW) },
      { chain: 'midnight', lastHeight: 57, lastBlockTime: sec(NOW), feeHeight: 40, feeBlockTime: sec(NOW - 3 * HOUR), sourceFeeHeight: 40 },
    ]));
    const r = await get(`/ChainOverview`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const cardano = r.json.value.find((x: any) => x.chain === 'cardano');
    const midnight = r.json.value.find((x: any) => x.chain === 'midnight');
    expect(Number(cardano.feesThroughHeight)).toBe(1009);
    expect(cardano.fees24h).not.toBeNull();
    expect(Number(midnight.feesThroughHeight)).toBe(40);
    expect(midnight.feesThroughAt).toBe(new Date(sec(NOW - 3 * HOUR) * 1000).toISOString());
    expect(midnight.fees24h).toBeNull();
    expect(midnight.medianFee24h).toBeNull();
    expect(midnight.p95Fee24h).toBeNull();
  });
});
