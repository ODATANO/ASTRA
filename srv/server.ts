/**
 * ASTRA server hooks: start the aggregation scheduler once the CAP services are
 * served, stop it on shutdown. SKIP_AUTO_INIT=true (tests) skips both.
 *
 * Also mounts /api/networks for the dashboard's network switch: which sister
 * instances (one ASTRA per network) are reachable right now, probed from here so
 * the browser needs no CORS. ASTRA_NETWORKS overrides the list.
 */
import cds from '@sap/cds';
import { startScheduler, stopScheduler } from './aggregator/scheduler';

const LOG = cds.log('astra');

// ---------------------------------------------------------------- sister instances

/** `preview=https://astra.preview.odatano.dev,preprod=...` — the hosts follow the API pages (api.<network>.odatano.dev). */
const DEFAULT_NETWORKS = 'preview=https://astra.preview.odatano.dev,preprod=https://astra.preprod.odatano.dev,mainnet=https://astra.odatano.dev';
const PROBE_TIMEOUT_MS = 3000;
const PROBE_TTL_MS = 60_000;

interface NetworkEntry { id: string; url: string; up: boolean | null }

function configuredNetworks(): NetworkEntry[] {
  const raw = process.env.ASTRA_NETWORKS ?? DEFAULT_NETWORKS;
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    const id = (i < 0 ? pair : pair.slice(0, i)).trim();
    const url = (i < 0 ? '' : pair.slice(i + 1)).trim().replace(/\/+$/, '');
    return { id, url, up: null };
  }).filter(n => n.id);
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/odata/v4/astra/SyncStatus?$top=1`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: 'application/json' } });
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

cds.on('bootstrap', (app: any) => {
  app.get('/api/networks', async (_req: any, res: any) => {
    try {
      const report = await networksReport();
      res.setHeader('Cache-Control', 'public, max-age=30');
      res.json(report);
    } catch (e: any) {
      res.status(503).json({ error: e?.message ?? String(e) });
    }
  });
});

// ---------------------------------------------------------------- aggregation

cds.on('served', async () => {
  if (process.env.SKIP_AUTO_INIT === 'true') return;
  try {
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
