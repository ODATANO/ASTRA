/**
 * Spot-check the indexed data against an independent public indexer: random blocks, compared on
 * hash, transaction count, size and fees. Catches systematic defects; cannot prove a single
 * block right. The only outbound call besides the source databases; a failure never touches
 * aggregation.
 */
import cds from '@sap/cds';
import type { Chain, ChainSource } from '../sources/types';

const { SELECT, UPSERT } = cds.ql;
const RUNS = 'odatano.astra.VerificationRuns';

/** Public Koios endpoints, per network. Preprod is what the box runs; mainnet is the same shape. */
const KOIOS: Record<string, string> = {
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
  mainnet: 'https://api.koios.rest/api/v1',
};

/** Koios answers at most this many hashes per call. */
const BATCH = 50;

export interface Mismatch {
  height: number;
  field: 'hash' | 'txCount' | 'size' | 'fees';
  ours: string | number | null;
  reference: string | number | null;
}

export interface VerificationResult {
  chain: Chain;
  reference: string;
  samples: number;
  checked: number;
  mismatches: Mismatch[];
  fromHeight: number;
  toHeight: number;
  durationMs: number;
  ranAt: string;
  /** Set when the run could not be carried out at all — no verdict, rather than a false clean one. */
  error?: string;
}

/** Distinct random heights in [from, to]; fewer than asked when the range is smaller. */
export function sampleHeights(from: number, to: number, count: number, rnd = Math.random): number[] {
  const span = to - from + 1;
  if (span <= 0) return [];
  if (span <= count) return Array.from({ length: span }, (_, i) => from + i);
  const picked = new Set<number>();
  // bounded: draws far more often than it collides while count stays well under the span
  for (let guard = 0; picked.size < count && guard < count * 20; guard++) {
    picked.add(from + Math.floor(rnd() * span));
  }
  return [...picked].sort((a, b) => a - b);
}

async function koiosBlockInfo(base: string, hashes: string[]): Promise<Map<string, any>> {
  const byHash = new Map<string, any>();
  for (let i = 0; i < hashes.length; i += BATCH) {
    const slice = hashes.slice(i, i + BATCH);
    const res = await fetch(`${base}/block_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _block_hashes: slice }),
    });
    if (!res.ok) throw new Error(`koios block_info ${res.status}`);
    for (const row of (await res.json()) as any[]) {
      if (row?.hash) byHash.set(String(row.hash), row);
    }
  }
  return byHash;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Draw `samples` random blocks from the range the source has crawled and compare them.
 *
 * @param network which Koios instance to ask; must be the network the source indexes.
 */
export async function verifySample(
  db: any,
  source: ChainSource,
  chain: Chain,
  network: string,
  samples = 100,
  now = new Date(),
): Promise<VerificationResult> {
  const t0 = Date.now();
  const ranAt = now.toISOString();
  const base = KOIOS[network];
  const blank = (error: string): VerificationResult => ({
    chain, reference: `koios:${network}`, samples: 0, checked: 0, mismatches: [],
    fromHeight: 0, toHeight: 0, durationMs: Date.now() - t0, ranAt, error,
  });

  if (!base) return blank(`no independent reference configured for network '${network}'`);

  const tip = await source.getTip();
  const start = await source.getCrawlStartHeight();
  if (!tip || start === null || tip.height <= start) return blank('source has no crawled range yet');

  // stay below the tip: the newest blocks may still be settling on either side
  const to = tip.height - 10;
  const heights = sampleHeights(start, to, samples);
  if (!heights.length) return blank('crawled range too small to sample');

  const blocks = [];
  for (const h of heights) {
    const found = await source.getBlocks(h, h);
    if (found.length) blocks.push(found[0]);
  }
  if (!blocks.length) return blank('no blocks readable in the sampled heights');

  let reference: Map<string, any>;
  try {
    reference = await koiosBlockInfo(base, blocks.map(b => b.hash));
  } catch (e) {
    return blank(`reference unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const mismatches: Mismatch[] = [];
  let checked = 0;
  for (const b of blocks) {
    const ref = reference.get(b.hash);
    if (!ref) {
      // the reference does not know this hash — our block is not on its chain
      mismatches.push({ height: b.height, field: 'hash', ours: b.hash, reference: null });
      continue;
    }
    checked++;
    const refHeight = numOrNull(ref.block_height);
    if (refHeight !== null && refHeight !== b.height) {
      mismatches.push({ height: b.height, field: 'hash', ours: b.height, reference: refHeight });
    }
    const refTx = numOrNull(ref.tx_count);
    if (refTx !== null && b.txCount !== null && b.txCount !== undefined && refTx !== b.txCount) {
      mismatches.push({ height: b.height, field: 'txCount', ours: b.txCount, reference: refTx });
    }
    const refSize = numOrNull(ref.block_size);
    if (refSize !== null && b.size !== null && b.size !== undefined && refSize !== b.size) {
      mismatches.push({ height: b.height, field: 'size', ours: b.size, reference: refSize });
    }
    const refFees = numOrNull(ref.total_fees);
    const ourFees = numOrNull(b.fees);
    if (refFees !== null && ourFees !== null && refFees !== ourFees) {
      mismatches.push({ height: b.height, field: 'fees', ours: ourFees, reference: refFees });
    }
  }

  const result: VerificationResult = {
    chain,
    reference: `koios:${network}`,
    samples: blocks.length,
    checked,
    mismatches,
    fromHeight: heights[0],
    toHeight: heights[heights.length - 1],
    durationMs: Date.now() - t0,
    ranAt,
  };

  await db.run(UPSERT.into(RUNS).entries({
    chain, ranAt,
    reference: result.reference,
    samples: result.samples,
    checked: result.checked,
    mismatches: mismatches.length,
    fromHeight: result.fromHeight,
    toHeight: result.toHeight,
    durationMs: result.durationMs,
    // bounded: a broken index would otherwise write a megabyte of identical complaints
    details: JSON.stringify(mismatches.slice(0, 25)),
  }));

  return result;
}

/** The most recent run, so a caller can ask "when was this last checked, and did it hold". */
export async function lastVerification(db: any, chain: Chain): Promise<any | null> {
  const rows = await db.run(SELECT.from(RUNS).where({ chain }).orderBy('ranAt desc').limit(1));
  return rows?.[0] ?? null;
}
