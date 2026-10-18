/**
 * ASTRA server hooks: start the aggregation scheduler once the CAP services are
 * served, stop it on shutdown. SKIP_AUTO_INIT=true (tests) skips both.
 *
 * Also serves the dashboard (/, /cardano, /midnight; the page reads the chain from
 * the path, the server fills the title and share tags per path and origin) and
 * /api/networks: which sister instances (ASTRA_NETWORKS, one instance per network)
 * answer right now, probed from here so the browser needs no CORS.
 */
import cds from '@sap/cds';
import fs from 'node:fs';
import path from 'node:path';
import type { Application, NextFunction, Request, Response } from 'express';
import { startScheduler, stopScheduler } from './aggregator/scheduler';
import { ensureDbIndexes } from './aggregator/db-indexes';
import { guardPostgresPools } from './pg-guard';

const LOG = cds.log('astra');

// Before any database connects: a restarted PostgreSQL must not take the server down.
guardPostgresPools();

// ---------------------------------------------------------------- sister instances

const PROBE_TIMEOUT_MS = 3000;
const PROBE_TTL_MS = 60_000;

interface NetworkEntry { id: string; url: string; up: boolean | null }

function configuredNetworks(): NetworkEntry[] {
  const raw = process.env.ASTRA_NETWORKS ?? '';
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    const id = (i < 0 ? pair : pair.slice(0, i)).trim();
    const url = (i < 0 ? '' : pair.slice(i + 1)).trim().replace(/\/+$/, '');
    return { id, url, up: null };
  }).filter(n => n.id);
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/odata/v4/analytics/SyncStatus?$top=1`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: 'application/json' } });
    return res.ok;
  } catch {
    return false;
  }
}

/** The network this instance serves: what its sources report (ChainCursors.network). */
async function ownNetwork(): Promise<string | null> {
  try {
    const rows: { network: string | null }[] = await cds.db.run(cds.ql.SELECT.from('odatano.astra.ChainCursors').columns('network'));
    return rows.map(r => r.network).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

let probe: { at: number; value: Promise<{ current: string | null; networks: NetworkEntry[] }> } | null = null;

function networksReport() {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.value;
  const value = (async () => {
    const current = await ownNetwork();
    const networks = await Promise.all(configuredNetworks().map(async n => {
      if (n.id === current) return { ...n, up: true };          // that is us
      if (!n.url) return { ...n, up: false };                    // not deployed yet
      return { ...n, up: await isUp(n.url) };
    }));
    return { current, networks };
  })();
  probe = { at: Date.now(), value };
  value.catch(() => { probe = null; });
  return value;
}

// ---------------------------------------------------------------- dashboard pages

interface PageMeta { title: string; description: string; image: string }
const PAGE_META: Record<string, PageMeta> = {
  all: {
    title: 'ODATANO ASTRA',
    description: 'Live analytics for Cardano and Midnight: blocks, transactions, fees and rankings of both chains, every number with the block range it came from.',
    image: 'og-image.png',
  },
  cardano: {
    title: 'ODATANO ASTRA · Cardano',
    description: 'Live analytics for Cardano: blocks, transactions, fees, tokens, stake and governance, every number with the block range it came from.',
    image: 'og-cardano.png',
  },
  midnight: {
    title: 'ODATANO ASTRA · Midnight',
    description: 'Live analytics for Midnight: blocks, transactions, fees, contracts, the DUST ledger and shielded activity, every number with the block range it came from.',
    image: 'og-midnight.png',
  },
};
const PAGES: Record<string, PageMeta> = {
  '/': PAGE_META.all, '/index.html': PAGE_META.all, '/cardano': PAGE_META.cardano, '/midnight': PAGE_META.midnight,
};
let indexHtml: string | null = null;

function pageHtml(): string {
  if (indexHtml) return indexHtml;
  const html = fs.readFileSync(path.resolve(cds.root, cds.env.folders.app, 'index.html'), 'utf8');
  if (process.env.NODE_ENV === 'production') indexHtml = html;
  return html;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Scheme and host the client asked for; a reverse proxy passes them in the X-Forwarded headers. */
function requestOrigin(req: Request): string {
  const first = (v: string | undefined, fallback: string) => (v ? v.split(',')[0].trim() : fallback);
  const proto = first(req.get('x-forwarded-proto'), req.protocol || 'http');
  const host = first(req.get('x-forwarded-host'), req.get('host') ?? 'localhost');
  return `${proto}://${host}`;
}

const SERVICE_PATH = '/odata/v4/analytics';
const OLD_SERVICE_PATH = '/odata/v4/astra';
let oldPathWarned = false;

/** The old service path keeps answering for one release. */
function rewriteOldServicePath(req: Request, _res: Response, next: NextFunction): void {
  const url = req.url;
  if (url === OLD_SERVICE_PATH || url.startsWith(OLD_SERVICE_PATH + '/') || url.startsWith(OLD_SERVICE_PATH + '?')) {
    if (!oldPathWarned) {
      oldPathWarned = true;
      LOG.warn(`${OLD_SERVICE_PATH} is deprecated, use ${SERVICE_PATH}; the old path goes in a later release`);
    }
    req.url = SERVICE_PATH + url.slice(OLD_SERVICE_PATH.length);
  }
  next();
}

cds.on('bootstrap', (app: Application) => {
  app.use(rewriteOldServicePath);
  app.get(Object.keys(PAGES), (req: Request, res: Response) => {
    const meta = PAGES[req.path];
    const html = pageHtml()
      .replaceAll('__ORIGIN__', requestOrigin(req))
      .replaceAll('__PATH__', req.path === '/index.html' ? '/' : req.path)
      .replaceAll('__TITLE__', escapeAttr(meta.title))
      .replaceAll('__DESCRIPTION__', escapeAttr(meta.description))
      .replaceAll('__IMAGE__', meta.image);
    res.type('html').send(html);
  });
  app.get('/api/networks', async (_req: Request, res: Response) => {
    try {
      const report = await networksReport();
      res.setHeader('Cache-Control', 'public, max-age=30');
      res.json({ ...report, apiReference: process.env.ASTRA_API_REFERENCE_URL || null });
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
});

// ---------------------------------------------------------------- aggregation

cds.on('served', async () => {
  if (process.env.SKIP_AUTO_INIT === 'true') return;
  try {
    // before the scheduler: a first build locks writes on EntityBuckets
    await ensureDbIndexes();
    const chains = await startScheduler();
    LOG.info(chains.length ? `aggregating: ${chains.join(', ')}` : 'idle – no sources');
  } catch (e: any) {
    LOG.error(`scheduler failed to start: ${e?.message ?? e}`);
  }
});

cds.on('shutdown', async () => {
  await stopScheduler().catch(() => undefined);
});

export default cds.server;
