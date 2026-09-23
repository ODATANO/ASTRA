/**
 * Secondary, read-only database connections to the source products.
 *
 * The trick: we load the *CDS model* of @odatano/core and @odatano/nightgate
 * (synced copies under source-models/, pinned to the versions on the box) and
 * hand it to a second CAP DatabaseService. CQN queries then compile to exactly
 * the physical tables the hosted instances already own (odatano_cardano_*,
 * midnight_*) – without installing those packages as plugins, without their
 * services, and without creating a single table in ASTRA's own database.
 *
 * Configuration (first match wins):
 *   ASTRA_CARDANO_DB_URL / ASTRA_MIDNIGHT_DB_URL   postgres://ro_user:pw@host:5432/db  (or "off")
 *   ASTRA_CARDANO_SQLITE / ASTRA_MIDNIGHT_SQLITE   path to a SQLite file (dev, tests)
 *   cds.astra.sources.<chain>                        { kind, credentials, pool?, client? } | false
 */
import cds from '@sap/cds';
import path from 'node:path';
import type { Chain } from './types';

export interface SourceDbConfig {
  kind: 'postgres' | 'sqlite';
  credentials: Record<string, unknown>;
  pool?: Record<string, unknown>;
  client?: Record<string, unknown>;
}

const MODEL_DIRS: Record<Chain, string> = {
  cardano: path.join('source-models', 'odatano', 'db'),
  midnight: path.join('source-models', 'nightgate', 'db'),
};

const ENV_PREFIX: Record<Chain, string> = { cardano: 'ASTRA_CARDANO', midnight: 'ASTRA_MIDNIGHT' };

const modelCache = new Map<Chain, Promise<any>>();
const serviceCache = new Map<Chain, Promise<any>>();

export function sourceModelDir(chain: Chain): string {
  return path.join(cds.root, MODEL_DIRS[chain]);
}

/** Loads (and caches) the source model as plain CSN. */
export function loadSourceModel(chain: Chain): Promise<any> {
  let p = modelCache.get(chain);
  if (!p) {
    p = cds.load(sourceModelDir(chain));
    modelCache.set(chain, p);
  }
  return p;
}

/** Splits a postgres:// URL into the credential shape @cap-js/postgres expects. */
export function postgresCredentials(url: string): Record<string, unknown> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('source DB URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/i.test(u.protocol)) throw new Error('source DB URL must be a postgres:// URL');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!u.hostname || !database) throw new Error('source DB URL needs host and database (postgres://user:pw@host:5432/db)');
  const creds: Record<string, unknown> = {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database,
  };
  const sslmode = (u.searchParams.get('sslmode') || '').toLowerCase();
  if (sslmode === 'require') creds.ssl = { rejectUnauthorized: false };
  else if (sslmode === 'verify-full') creds.ssl = { rejectUnauthorized: true };
  const schema = u.searchParams.get('schema');
  if (schema) creds.schema = schema;
  return creds;
}

/** Resolves the configuration for one chain; null = source disabled. */
export function resolveSourceConfig(chain: Chain, env: NodeJS.ProcessEnv = process.env): SourceDbConfig | null {
  const prefix = ENV_PREFIX[chain];
  const url = env[`${prefix}_DB_URL`]?.trim();
  if (url) {
    if (/^(off|false|0|none)$/i.test(url)) return null;
    return {
      kind: 'postgres',
      credentials: postgresCredentials(url),
      pool: { max: Number(env[`${prefix}_DB_POOL_MAX`] || 4), acquireTimeoutMillis: 30000 },
      client: { application_name: 'odatano-astra', statement_timeout: Number(env[`${prefix}_DB_STATEMENT_TIMEOUT_MS`] || 120000) },
    };
  }
  const sqlite = env[`${prefix}_SQLITE`]?.trim();
  if (sqlite) return { kind: 'sqlite', credentials: { url: sqlite } };

  const astra = (cds.env as any).astra || {};
  const cfg = astra.sources?.[chain];
  if (cfg === false || cfg === null || cfg === undefined) return null;
  if (!cfg.kind) return null;
  return cfg as SourceDbConfig;
}

/** Which chains have a configured source. */
export function configuredChains(env: NodeJS.ProcessEnv = process.env): Chain[] {
  return (['cardano', 'midnight'] as Chain[]).filter(c => resolveSourceConfig(c, env) !== null);
}

/**
 * Connects to the source database of a chain (cached). Uses the source's own
 * CDS model so that queries compile against its table names.
 */
export function connectSource(chain: Chain, override?: SourceDbConfig): Promise<any> {
  if (override) return openSource(chain, override);
  let p = serviceCache.get(chain);
  if (!p) {
    const cfg = resolveSourceConfig(chain);
    if (!cfg) return Promise.reject(new Error(`no source configured for chain '${chain}'`));
    p = openSource(chain, cfg);
    serviceCache.set(chain, p);
  }
  return p;
}

async function openSource(chain: Chain, cfg: SourceDbConfig): Promise<any> {
  const model = await loadSourceModel(chain);
  const name = `astra-source-${chain}`;
  const srv = await (cds.connect.to as any)(name, { ...cfg, model, silent: true });
  if (cfg.kind === 'sqlite') await ensureSqliteSchema(srv, chain, model);
  return srv;
}

/** Dev/test only: a SQLite source gets the source schema deployed once. */
export async function ensureSqliteSchema(srv: any, chain: Chain, model?: any): Promise<boolean> {
  const probe = chain === 'cardano' ? 'odatano_cardano_Blocks' : 'midnight_Blocks';
  const rows = await srv.run(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [probe]);
  if (Array.isArray(rows) && rows.length) return false;
  model ??= await loadSourceModel(chain);
  // cds.deploy would hijack cds.db when nothing is connected yet – make sure the primary db exists first.
  if (!cds.db) await cds.connect.to('db');
  await (cds as any).deploy(model).to(srv, { silent: true });
  return true;
}

/** For tests: forget cached connections. */
export function resetSourceCache(): void {
  serviceCache.clear();
}
