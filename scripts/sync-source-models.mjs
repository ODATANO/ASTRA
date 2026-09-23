#!/usr/bin/env node
/**
 * Pulls the CDS *models* (db/*.cds only) of @odatano/core and @odatano/nightgate
 * from the npm registry into source-models/<name>/db — pinned to the versions
 * listed under "sourceModels" in package.json (= the versions running on the box).
 *
 * ASTRA deliberately does NOT depend on those packages at runtime: installing them
 * would activate their cds-plugin.js, register their services and create all their
 * tables in ASTRA's own database. We only need the entity definitions so that
 * CQN queries compile against the SAME physical table names the hosted
 * ODATANO / NIGHTGATE instances already use (odatano_cardano_*, midnight_*).
 *
 * Usage: npm run sources:sync            (registry)
 *        npm run sources:sync -- --local  (copy from ../ODATANO and ../NIGHTGATE instead)
 */
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync, cpSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = join(root, 'source-models');
const local = process.argv.includes('--local');

const SOURCES = {
  '@odatano/core': { dir: 'odatano', localPath: resolve(root, '..', 'ODATANO') },
  '@odatano/nightgate': { dir: 'nightgate', localPath: resolve(root, '..', 'NIGHTGATE') },
};

/** Minimal ustar reader: extracts package/db/*.cds from an npm tarball (no tar binary needed). */
function extractDbCds(tgz, dest) {
  const buf = gunzipSync(readFileSync(tgz));
  mkdirSync(dest, { recursive: true });
  let off = 0, found = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    const str = (a, b) => header.toString('utf8', a, b).replace(/\0.*$/s, '');
    const prefix = str(345, 500);
    const name = (prefix ? prefix + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = header[156];
    const dataStart = off + 512;
    if ((type === 48 || type === 0) && /^package\/db\/[^/]+\.cds$/.test(name)) {
      writeFileSync(join(dest, name.slice('package/db/'.length)), buf.subarray(dataStart, dataStart + size));
      found++;
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error(`no package/db/*.cds entries in ${tgz}`);
}

for (const [name, { dir, localPath }] of Object.entries(SOURCES)) {
  const version = pkg.sourceModels?.[name];
  if (!version) throw new Error(`package.json sourceModels lacks "${name}"`);
  const dest = join(target, dir);
  rmSync(dest, { recursive: true, force: true });
  let resolvedVersion = version;
  if (local) {
    const dbDir = join(localPath, 'db');
    if (!existsSync(dbDir)) throw new Error(`no db/ folder at ${dbDir}`);
    resolvedVersion = JSON.parse(readFileSync(join(localPath, 'package.json'), 'utf8')).version + ' (local)';
    mkdirSync(join(dest, 'db'), { recursive: true });
    for (const f of readdirSync(dbDir)) if (f.endsWith('.cds')) cpSync(join(dbDir, f), join(dest, 'db', f));
  } else {
    const tmp = mkdtempSync(join(tmpdir(), 'astra-src-'));
    const out = execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], {
      encoding: 'utf8', shell: process.platform === 'win32',
    }).trim().split('\n').pop();
    extractDbCds(join(tmp, out), join(dest, 'db'));
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(dest, 'VERSION'), `${name}@${resolvedVersion}\nsynced ${new Date().toISOString()}\n`);
  console.log(`synced ${name}@${resolvedVersion} -> ${dest}/db`);
}
