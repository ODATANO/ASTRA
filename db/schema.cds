namespace odatano.astra;

/**
 * ODATANO ASTRA – own persistence.
 *
 * Only aggregates live here. Raw chain data stays in the databases of the
 * hosted ODATANO (odatano_cardano_*) and NIGHTGATE (midnight_*) instances,
 * which ASTRA reads through read-only secondary connections (see srv/sources).
 */

type Chain       : String(10) enum {
  cardano;
  midnight;
}

type Granularity : String(10) enum {
  minute;
  hour;
  day;
  epoch;
}

type MetricKind  : String(14) enum {
  counter; // headline = sum   (blocks.count, tx.count)
  distribution; // headline = avg   (blocks.size, blocks.interval, fees.paid)
  gauge; // headline = last  (snapshots only)
}

/**
 * Where a metric has numbers: time buckets (getWindow / getSeries), per entity (getTop), or both.
 * `value.received` exists per address only, `value.transferred` chain-wide only.
 */
type MetricScope : String(6) enum {
  chain;   // time buckets only — getWindow / getSeries
  entity;  // leaderboards only — getTop
  both;
}

/** Catalogue: one row per (chain, metric). */
entity Metrics {
  key chain       : Chain;
  key ID          : String(60); // 'blocks.count', 'fees.paid', ...
      name        : String(120);
      kind        : MetricKind;
      scope       : MetricScope default #both;
      unit        : String(20); // 'blocks', 'tx', 'bytes', 's', 'lovelace', 'DUST'
      description : String(500);
      buckets     : Association to many MetricBuckets
                      on  buckets.chain    = chain
                      and buckets.metricId = ID;
}

/**
 * Pre-aggregated time buckets. Every bucket names the block range it was
 * computed from, so each number can be verified against the raw tables.
 */
entity MetricBuckets {
  key chain       : Chain;
  key metricId    : String(60);
  key granularity : Granularity;
  key bucketStart : Timestamp;
      count       : Integer64;
      sum         : Decimal(38, 6);
      sumSq       : Decimal(38, 6); // for stddev / jitter / z-scores
      min         : Decimal(38, 6);
      max         : Decimal(38, 6);
      histogram   : LargeString; // JSON, log-scale bins (see srv/aggregator/histogram.ts)
      fromHeight  : Integer64;
      toHeight    : Integer64;
      computedAt  : Timestamp;
      metric      : Association to Metrics
                      on  metric.chain = chain
                      and metric.ID    = metricId;
}

/** What a leaderboard row counts: the kind of thing being ranked. */
type Dimension   : String(12) enum {
  token; // a native asset, keyed by its unit (policyId + assetNameHex)
  policy; // a minting policy, keyed by its id
  script; // a script address
  address; // a payment address
  producer; // a block producer (slot leader / author)
  pool;     // a stake pool, keyed by its bech32 pool id (epoch snapshots)
  drep;     // a delegated representative, keyed by its bech32 drep id (epoch snapshots)
  tokenHolder; // an address seen moving ONE token: entityId = address, subjectId = unit
  contract; // a contract, keyed by its address (Midnight)
  circuit;  // a circuit name, across contracts (Midnight)
}

/**
 * Per-entity counters for the leaderboards: the full entity set per period (no stored top-N),
 * ranked by SUM and ORDER BY at read time. Hour and day granularity only, so the shortest
 * leaderboard window is 24h.
 */
entity EntityBuckets {
  key chain       : Chain;
  key dimension   : Dimension;
  /** The thing being counted. For `tokenHolder` it is `unit|address`; the unit is mirrored into `subjectId`. */
  key entityId    : String(255);
  /** Second axis, empty when the dimension has none. For `tokenHolder`: the unit. */
      subjectId   : String(140) default '';
  key metricId    : String(60);
  key granularity : Granularity; // hour | day
  key bucketStart : Timestamp;
      count       : Integer64; // events (transfers, mints, calls, blocks produced)
      sum         : Decimal(38, 6); // quantity — meaningful here because one row is one entity
      fromHeight  : Integer64;
      toHeight    : Integer64;
      computedAt  : Timestamp;
      metric      : Association to Metrics
                      on  metric.chain = chain
                      and metric.ID    = metricId;
}

/** Spot checks of the indexed data against an independent public indexer (see srv/verification). */
entity VerificationRuns {
  key chain      : Chain;
  key ranAt      : Timestamp;
      reference  : String(40);    // which independent source was asked
      samples    : Integer;       // blocks drawn
      checked    : Integer;       // blocks the reference could answer for
      mismatches : Integer;
      fromHeight : Integer64;     // range the sample was drawn from
      toHeight   : Integer64;
      durationMs : Integer;
      details    : LargeString;   // JSON, the first few mismatches with both sides
}

/** Point-in-time values that are not derivable from blocks (stake, pools, supply, balances). */
entity Snapshots {
  key chain    : Chain;
  key metricId : String(60);
  key takenAt  : Timestamp;
      value    : Decimal(38, 6);
      payload  : LargeString; // JSON detail
      metric   : Association to Metrics
                   on  metric.chain = chain
                   and metric.ID    = metricId;
}

/** Aggregation watermark per chain (one row per chain). */
entity ChainCursors {
  key chain               : Chain;
      network             : String(20); // which network the source indexes (preprod, mainnet), as the source itself reports it
      startHeight         : Integer64; // first height covered (derived from startTime)
      lastHeight          : Integer64; // last height fully aggregated
      lastBlockTime       : Integer64; // unix seconds of block at lastHeight (for blocks.interval)
      lastReorgDetectedAt : Timestamp; // newest source reorg already handled
      sourceTipHeight     : Integer64; // source crawler: last indexed height
      sourceChainHeight   : Integer64; // node tip as reported by the source
      sourceSyncStatus    : String(20);
      sourceLastIndexedAt : Timestamp;
      // Fees the source fills in after the block (Midnight) are aggregated by their own pass.
      feeHeight           : Integer64; // last height whose fees are aggregated; null = pass not started
      feeBlockTime        : Integer64; // unix seconds of the newest block the fee pass has covered
      sourceFeeHeight     : Integer64; // last height whose fees the source has filled in
      // Facts the source decodes from the ledger payload after the block (Midnight), same scheme.
      decodeHeight        : Integer64; // last height whose decoded facts are aggregated; null = pass not started
      decodeBlockTime     : Integer64; // unix seconds of the newest block the decode pass has covered
      sourceDecodeHeight  : Integer64; // last height the source has decoded
      backfilling         : Boolean default true;
      lastRunAt           : Timestamp;
      lastRunMs           : Integer;
      lastError           : String(500);
      lastErrorAt         : Timestamp;
      leaseOwner          : String(128);
      leaseUntil          : Timestamp;
}

/** Reorgs seen in the source ReorgLog tables and what ASTRA recomputed because of them. */
entity Reorgs {
  key chain                : Chain;
  key sourceId             : String(36);
      detectedAt           : Timestamp;
      forkHeight           : Integer64;
      blocksRolledBack     : Integer;
      status               : String(20);
      recomputedFromHeight : Integer64;
      handledAt            : Timestamp;
}
