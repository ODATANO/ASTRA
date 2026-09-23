#!/usr/bin/env node
/**
 * Builds the CDS_CONFIG JSON for the container from environment variables
 * (same pattern as ODATANO's and NIGHTGATE's docker/cds-config.mjs).
 *
 *   ASTRA_DB_URL          postgres:// URL of ASTRA's own database (required)
 *   ASTRA_AUTH            basic | dummy (default basic)
 *   ASTRA_HTTP_USER / ASTRA_HTTP_PASSWORD / ASTRA_HTTP_ROLES (default astra / – / admin)
 *
 * Source databases are read directly by srv/sources from ASTRA_CARDANO_DB_URL /
 * ASTRA_MIDNIGHT_DB_URL and need no CDS config.
 */

export function postgresCredentials(url, name) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${name} is not a valid URL`); }
  if (!/^postgres(ql)?:$/i.test(u.protocol)) throw new Error(`${name} must be a postgres:// URL`);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!u.hostname || !database) throw new Error(`${name} needs a host and a database name`);
  const creds = {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database,
  };
  const sslmode = (u.searchParams.get('sslmode') || '').toLowerCase();
  if (sslmode === 'require') creds.ssl = { rejectUnauthorized: false };
  if (sslmode === 'verify-full') creds.ssl = { rejectUnauthorized: true };
  return creds;
}

export function authConfig(env = process.env) {
  const kind = String(env.ASTRA_AUTH ?? 'basic');
  if (kind === 'dummy') return { kind: 'dummy' };
  if (kind !== 'basic') throw new Error(`unsupported ASTRA_AUTH='${kind}' (use: basic | dummy)`);
  const password = String(env.ASTRA_HTTP_PASSWORD ?? '');
  if (!password) throw new Error('ASTRA_HTTP_PASSWORD is required with basic auth (local testing only: ASTRA_AUTH=dummy)');
  const user = String(env.ASTRA_HTTP_USER || 'astra');
  const roles = String(env.ASTRA_HTTP_ROLES ?? 'admin').split(',').map(r => r.trim()).filter(Boolean);
  return { kind: 'basic', users: { [user]: { password, roles } } };
}

export function buildConfig(env = process.env) {
  const url = env.ASTRA_DB_URL;
  if (!url) throw new Error('ASTRA_DB_URL is required');
  return {
    requires: {
      db: { kind: 'postgres', credentials: postgresCredentials(url, 'ASTRA_DB_URL'), pool: { max: Number(env.ASTRA_DB_POOL_MAX || 10), acquireTimeoutMillis: 30000 } },
      auth: authConfig(env),
    },
    astra: {
      pollMs: Number(env.ASTRA_POLL_MS || 10000),
      chunkBlocks: Number(env.ASTRA_CHUNK_BLOCKS || 200),
      startTime: env.ASTRA_START_TIME || '2026-01-01T00:00:00Z',
      retention: {
        minuteHours: Number(env.ASTRA_RETENTION_MINUTE_HOURS || 48),
        hourDays: Number(env.ASTRA_RETENTION_HOUR_DAYS || 90),
      },
    },
    log: { levels: { astra: 'info' } },
  };
}

const cfg = buildConfig();
if (process.argv.includes('--explain')) {
  const mask = c => ({ ...c, requires: { ...c.requires, db: { ...c.requires.db, credentials: { ...c.requires.db.credentials, password: '***' } }, auth: c.requires.auth.kind } });
  console.error(JSON.stringify(mask(cfg), null, 2));
} else {
  process.stdout.write(JSON.stringify(cfg));
}
