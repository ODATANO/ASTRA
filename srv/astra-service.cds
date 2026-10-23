using { odatano.astra as astra } from '../db/schema';

/**
 * AstraService – analytics over Cardano (ODATANO) and Midnight (NIGHTGATE).
 * Reads are public by design (the dashboard calls them from the browser);
 * admin actions need the role 'admin'.
 */
@path: '/odata/v4/analytics'
@requires: 'any'
service AstraService {

  @readonly entity Metrics       as projection on astra.Metrics;
  @readonly entity MetricBuckets as projection on astra.MetricBuckets;
  @readonly entity EntityBuckets as projection on astra.EntityBuckets;
  @readonly entity Snapshots     as projection on astra.Snapshots;
  @readonly entity Reorgs        as projection on astra.Reorgs;
  @readonly entity VerificationRuns as projection on astra.VerificationRuns;

  /** Aggregation progress per chain (lease columns hidden). */
  @readonly entity SyncStatus    as projection on astra.ChainCursors excluding { leaseOwner, leaseUntil };

  type Window : String(6) enum { _1h = '1h'; _24h = '24h'; _7d = '7d'; _14d = '14d'; _30d = '30d'; }

  /**
   * Every metric ASTRA computes, so $metadata and the reference list the accepted values.
   * The catalogue (`Metrics`) says which chain has which; test/views.test.ts keeps both in step.
   */
  type MetricId : String(60) enum {
    blocks_count = 'blocks.count';
    blocks_size = 'blocks.size';
    blocks_interval = 'blocks.interval';
    blocks_empty = 'blocks.empty';
    blocks_txCount = 'blocks.txCount';
    tx_count = 'tx.count';
    tx_withMetadata = 'tx.withMetadata';
    fees_paid = 'fees.paid';
    tokens_transfers = 'tokens.transfers';
    tokens_mints = 'tokens.mints';
    tokens_burns = 'tokens.burns';
    tx_withAssets = 'tx.withAssets';
    value_transferred = 'value.transferred';
    utxo_created = 'utxo.created';
    utxo_spent = 'utxo.spent';
    value_received = 'value.received';
    value_sent = 'value.sent';
    blocks_produced = 'blocks.produced';
    stake_live = 'stake.live';
    stake_active = 'stake.active';
    stake_blocksLifetime = 'stake.blocksLifetime';
    stake_delegators = 'stake.delegators';
    governance_votingPower = 'governance.votingPower';
    tokens_received = 'tokens.received';
    tokens_sent = 'tokens.sent';
    stake_pools = 'stake.pools';
    stake_totalLive = 'stake.totalLive';
    governance_dreps = 'governance.dreps';
    governance_totalPower = 'governance.totalPower';
    certs_stakeRegistrations = 'certs.stakeRegistrations';
    certs_stakeDeregistrations = 'certs.stakeDeregistrations';
    certs_poolDelegations = 'certs.poolDelegations';
    certs_voteDelegations = 'certs.voteDelegations';
    certs_poolRegistrations = 'certs.poolRegistrations';
    certs_poolRetirements = 'certs.poolRetirements';
    certs_drepRegistrations = 'certs.drepRegistrations';
    certs_drepRetirements = 'certs.drepRetirements';
    certs_other = 'certs.other';
    withdrawals_count = 'withdrawals.count';
    withdrawals_value = 'withdrawals.value';
    withdrawals_zero = 'withdrawals.zero';
    script_interactions = 'script.interactions';
    stake_delegations = 'stake.delegations';
    governance_voteDelegations = 'governance.voteDelegations';
    tx_system = 'tx.system';
    tx_size = 'tx.size';
    tx_shielded = 'tx.shielded';
    tx_withProof = 'tx.withProof';
    tx_contractCalls = 'tx.contractCalls';
    tx_contractDeploys = 'tx.contractDeploys';
    tx_failed = 'tx.failed';
    fees_estimated = 'fees.estimated';
    fees_estimateError = 'fees.estimateError';
    tx_decoded = 'tx.decoded';
    tx_zswap = 'tx.zswap';
    dust_consumed = 'dust.consumed';
    dust_spends = 'dust.spends';
    dust_registrations = 'dust.registrations';
    zswap_inputs = 'zswap.inputs';
    zswap_outputs = 'zswap.outputs';
    zswap_transients = 'zswap.transients';
    contract_calls = 'contract.calls';
    circuit_calls = 'circuit.calls';
  }

  /**
   * One row per chain with the headline numbers – computed on read.
   *
   * Two lags, and both matter when reading the 1h/24h figures: `lagBlocks` is ASTRA behind
   * its source, `sourceLagBlocks` is the source behind the chain. The windows are anchored
   * to the wall clock, so while either lag is large the recent windows are empty — that is
   * missing data, not a quiet chain. `lastBlockAt` says how far the numbers actually reach.
   */
  @readonly @cds.persistence.skip
  entity ChainOverview {
    key chain             : astra.Chain;
        network           : String(20);     // preprod | mainnet, as the source reports it
        sourceSyncStatus  : String(20);
        sourceTipHeight   : Integer64;      // last height the source has indexed
        sourceChainHeight : Integer64;      // chain tip as the source reports it
        sourceLagBlocks   : Integer64;      // sourceChainHeight - sourceTipHeight: how far the SOURCE is behind the chain
        aggregatedHeight  : Integer64;
        lagBlocks         : Integer64;      // sourceTipHeight - aggregatedHeight: how far ASTRA is behind the source
        lastBlockAt       : Timestamp;
        backfilling       : Boolean;
        blocks1h          : Integer64;
        blocks1hPrev      : Integer64;
        blocks1hChangePct : Decimal(9, 2);
        avgBlockTime1h    : Decimal(12, 3);
        tx1h              : Integer64;
        tx1hPrev          : Integer64;
        tx1hChangePct     : Decimal(9, 2);
        tx24h             : Integer64;
        feesThroughHeight : Integer64;      // last height whose fees are aggregated (Midnight fills fees in after the block)
        feesThroughAt     : Timestamp;      // time of that block; the fee figures below are null while it is over an hour behind lastBlockAt
        fees24h           : Decimal(38, 6);
        fees24hPrev       : Decimal(38, 6);
        fees24hChangePct  : Decimal(9, 2);
        feeUnit           : String(20);
        medianFee24h      : Decimal(38, 6);
        p95Fee24h         : Decimal(38, 6);
        avgTxPerBlock24h  : Decimal(12, 3);
  }

  // ------------------------------------------------------------------ ready-made views
  //
  // The entities below answer the common questions without a metric id. They are computed on
  // read from the stored buckets and honour $filter (comparisons, and/or/not, parentheses),
  // $orderby, $top/$skip, $select and $count â see srv/views/query.ts. A plain GET reads newest
  // first. Adding a column or a ranking is one line in srv/views/daily.ts or figures.ts.

  /**
   * Every chain-wide metric over every rolling window: value, previous window, change in %.
   * `KeyFigures?$filter=chain eq 'cardano' and window eq '7d'` is the week at a glance;
   * `$filter=metric eq 'tx.count'` puts both chains and all windows side by side.
   */
  @readonly @cds.persistence.skip
  entity KeyFigures {
    key chain       : astra.Chain;
    key metric      : MetricId;
    key window      : Window;
        name        : String(120);
        unit        : String(20);
        kind        : astra.MetricKind;
        value       : Decimal(38, 6);   // sum for counters, average for distributions
        previous    : Decimal(38, 6);   // the same over the window before this one
        changePct   : Decimal(9, 2);
        count       : Integer64;
        sum         : Decimal(38, 6);
        avg         : Decimal(38, 6);
        min         : Decimal(38, 6);
        max         : Decimal(38, 6);
        p50         : Decimal(38, 6);
        p95         : Decimal(38, 6);
        windowStart : Timestamp;
        windowEnd   : Timestamp;
        fromHeight  : Integer64;
        toHeight    : Integer64;
  }

  /** Blocks per UTC day. The size columns are Cardano only (Midnight reports no block size). */
  @readonly @cds.persistence.skip
  entity BlocksDaily {
    key chain             : astra.Chain;
    key day               : Date;
        blocks            : Integer64;
        emptyBlocks       : Integer64;
        avgBlockTimeSec   : Decimal(12, 3);
        p95BlockTimeSec   : Decimal(12, 3);
        maxBlockTimeSec   : Decimal(12, 3);
        avgBlockSizeBytes : Decimal(14, 1);
        maxBlockSizeBytes : Integer64;
        avgTxPerBlock     : Decimal(12, 3);
        maxTxPerBlock     : Integer64;
        fromHeight        : Integer64;
        toHeight          : Integer64;
  }

  /**
   * Transactions per UTC day. UTxO, asset and metadata columns are Cardano; size, system,
   * shielded, proof, contract and failed columns are Midnight. A column a chain does not have
   * is null, the row stays, so both chains sit in one table.
   */
  @readonly @cds.persistence.skip
  entity TransactionsDaily {
    key chain            : astra.Chain;
    key day              : Date;
        transactions     : Integer64;
        withAssets       : Integer64;
        withMetadata     : Integer64;
        utxosCreated     : Integer64;
        utxosSpent       : Integer64;
        volume           : Decimal(38, 6);   // value in created outputs, in volumeUnit
        volumeUnit       : String(20);
        avgTxSizeBytes   : Decimal(14, 1);
        systemExtrinsics : Integer64;
        shielded         : Integer64;
        withProof        : Integer64;
        contractCalls    : Integer64;
        contractDeploys  : Integer64;
        failed           : Integer64;
        fromHeight       : Integer64;
        toHeight         : Integer64;
  }

  /** Fees per UTC day in the chain's fee unit (lovelace; specks, the DUST atom). The estimate columns are Midnight only. */
  @readonly @cds.persistence.skip
  entity FeesDaily {
    key chain              : astra.Chain;
    key day                : Date;
        totalFees          : Decimal(38, 6);
        feePayingTx        : Integer64;
        avgFee             : Decimal(38, 6);
        medianFee          : Decimal(38, 6);
        p95Fee             : Decimal(38, 6);
        maxFee             : Decimal(38, 6);
        feeUnit            : String(20);
        totalEstimatedFees : Decimal(38, 6);
        avgEstimateError   : Decimal(38, 6);
        fromHeight         : Integer64;
        toHeight           : Integer64;
  }

  /** Native-asset activity per UTC day (Cardano). */
  @readonly @cds.persistence.skip
  entity TokensDaily {
    key chain      : astra.Chain;
    key day        : Date;
        transfers  : Integer64;
        mints      : Integer64;
        burns      : Integer64;
        fromHeight : Integer64;
        toHeight   : Integer64;
  }

  /**
   * Certificates and withdrawals per UTC day (Cardano). Filled only for blocks the source
   * crawled with its certificate feature on; earlier days carry zeros, not nulls.
   */
  @readonly @cds.persistence.skip
  entity StakeDaily {
    key chain                : astra.Chain;
    key day                  : Date;
        stakeRegistrations   : Integer64;
        stakeDeregistrations : Integer64;
        poolDelegations      : Integer64;
        voteDelegations      : Integer64;
        poolRegistrations    : Integer64;
        poolRetirements      : Integer64;
        drepRegistrations    : Integer64;
        drepRetirements      : Integer64;
        otherCertificates    : Integer64;
        withdrawals          : Integer64;
        zeroWithdrawals      : Integer64;       // of `withdrawals`: 0 ADA, submitted by script stake credentials
        withdrawnAda         : Decimal(38, 6);
        fromHeight           : Integer64;
        toHeight             : Integer64;
  }

  /**
   * Contract use per UTC day (Cardano): wallets (stake addresses) that met a script address in a
   * transaction, the script addresses met, and the (wallet, script, transaction) triples.
   */
  @readonly @cds.persistence.skip
  entity ScriptUsersDaily {
    key chain        : astra.Chain;
    key day          : Date;
        users        : Integer64;
        scripts      : Integer64;
        interactions : Integer64;
        fromHeight   : Integer64;
        toHeight     : Integer64;
  }

  /** Stake and governance per epoch (Cardano): the snapshot ASTRA took at the epoch boundary. */
  @readonly @cds.persistence.skip
  entity StakeEpochs {
    key chain               : astra.Chain;
    key epoch               : Integer;
        takenAt             : Timestamp;
        pools               : Integer;
        totalLiveStakeAda   : Decimal(38, 6);
        activeDreps         : Integer;
        totalVotingPowerAda : Decimal(38, 6);
  }

  /**
   * One ranked row. `entities` is how many distinct entities the window holds; the rows are the
   * head of that (20 per chain and window unless the filter asks for a rank bound, up to 200).
   */
  aspect RankingRow {
    key chain       : astra.Chain;
    key window      : LeaderWindow;
    key rank        : Integer;
        entityId    : String(255);
        count       : Integer64;        // events: transfers, blocks, ...
        sum         : Decimal(38, 6);   // quantity, in unit
        unit        : String(20);
        entities    : Integer;
        windowStart : Timestamp;
        windowEnd   : Timestamp;
        fromHeight  : Integer64;
        toHeight    : Integer64;
  }

  /** Tokens by number of transfers (24h, 7d, 14d, 30d). entityId = unit (policyId + assetNameHex). */
  @readonly @cds.persistence.skip entity TopTokens         : RankingRow {}
  /** Policies by number of transfers. entityId = policyId. */
  @readonly @cds.persistence.skip entity TopPolicies       : RankingRow {}
  /** Addresses by value received (ADA). entityId = address. */
  @readonly @cds.persistence.skip entity TopAddresses      : RankingRow {}
  /** Script addresses by value received (ADA). */
  @readonly @cds.persistence.skip entity TopScripts        : RankingRow {}
  /** Script addresses by distinct wallets met in the window: count = wallets, sum = their transactions with the script. */
  @readonly @cds.persistence.skip entity TopScriptsByUsers : RankingRow {}
  /** Block producers by blocks produced (sum = bytes). Pool id on Cardano, author on Midnight. */
  @readonly @cds.persistence.skip entity TopBlockProducers : RankingRow {}
  /** Pools by live stake in the newest epoch snapshot (window epoch). */
  @readonly @cds.persistence.skip entity TopPools          : RankingRow {}
  /** DReps by voting power in the newest epoch snapshot (window epoch). */
  @readonly @cds.persistence.skip entity TopDReps          : RankingRow {}
  /** Pools by delegation certificates received in the window (a flow of new delegations, not the delegator count). */
  @readonly @cds.persistence.skip entity TopDelegatedPools : RankingRow {}
  /** DReps by vote delegation certificates received in the window; always-abstain and no-confidence rank as targets too. */
  @readonly @cds.persistence.skip entity TopVotedDReps     : RankingRow {}
  /** Contracts by calls (Midnight). entityId = contract address. */
  @readonly @cds.persistence.skip entity TopContracts      : RankingRow {}
  /** Circuits by calls across contracts (Midnight). entityId = circuit name. */
  @readonly @cds.persistence.skip entity TopCircuits       : RankingRow {}

  type WindowResult {
    chain       : astra.Chain;
    metric      : String(60);
    window      : Window;
    unit        : String(20);
    kind        : astra.MetricKind;
    windowStart : Timestamp;
    windowEnd   : Timestamp;
    value       : Decimal(38, 6);   // headline (sum for counters, avg for distributions)
    count       : Integer64;
    sum         : Decimal(38, 6);
    avg         : Decimal(38, 6);
    min         : Decimal(38, 6);
    max         : Decimal(38, 6);
    p50         : Decimal(38, 6);
    p95         : Decimal(38, 6);
    stddev      : Decimal(38, 6);
    prevValue   : Decimal(38, 6);
    changePct   : Decimal(9, 2);
    fromHeight  : Integer64;
    toHeight    : Integer64;
    bucketsUsed : Integer;
    computedAt  : Timestamp;
  }

  type SeriesPoint {
    bucketStart : Timestamp;
    count       : Integer64;
    sum         : Decimal(38, 6);
    avg         : Decimal(38, 6);
    min         : Decimal(38, 6);
    max         : Decimal(38, 6);
    p50         : Decimal(38, 6);
    p95         : Decimal(38, 6);
    fromHeight  : Integer64;
    toHeight    : Integer64;
  }

  type SeriesResult {
    chain       : astra.Chain;
    metric      : String(60);
    window      : Window;
    granularity : astra.Granularity;
    unit        : String(20);
    points      : many SeriesPoint;
  }

  type LeaderWindow : String(5) enum { _24h = '24h'; _7d = '7d'; _14d = '14d'; _30d = '30d'; epoch; }
  type RankBy       : String(5) enum { sum; count; }

  type LeaderRow {
    rank       : Integer;
    entityId   : String(140);
    count      : Integer64;
    sum        : Decimal(38, 6);
    fromHeight : Integer64;
    toHeight   : Integer64;
  }

  type LeaderboardResult {
    chain       : astra.Chain;
    dimension   : astra.Dimension;
    /** Second axis when the dimension has one: the unit for tokenHolder, the script address for scriptUser (open = all scripts). */
    subject     : String(140);
    metric      : String(60);
    window      : LeaderWindow;
    /** Distinct entities in the window — the rows below are the head of this. For scriptUser without a subject: the active wallets. */
    entities    : Integer;
    windowStart : Timestamp;
    windowEnd   : Timestamp;
    rows        : many LeaderRow;
  }

  /**
   * Top entities of a dimension by a metric — exact, not a stored top-N.
   *
   * `by` decides the question: 'sum' ranks by quantity moved, 'count' by number of events.
   * No 1h window: the entity store starts at hour granularity (see db/schema.cds).
   * `epoch` reads the newest stake/governance snapshot instead of a span of time.
   */
  function getTop(chain     : astra.Chain,
                  dimension : astra.Dimension,
                  metric    : MetricId,
                  window    : LeaderWindow,
                  limit     : Integer,
                  by        : RankBy,
                  subject   : String(140)) returns LeaderboardResult;

  /** Value of a metric over a rolling window, with the previous window and change in percent. */
  function getWindow(chain : astra.Chain, metric : MetricId, window : Window) returns WindowResult;

  /** Time series in the resolution that matches the window (1h → minutes, 24h → hours, 7d/30d → days). */
  function getSeries(chain : astra.Chain, metric : MetricId, window : Window) returns SeriesResult;

  /** The same metric for both chains side by side. */
  function compare(metric : MetricId, window : Window) returns array of WindowResult;

  type ConcentrationResult {
    chain       : astra.Chain;
    dimension   : astra.Dimension;
    metric      : String(60);
    window      : LeaderWindow;
    /** 'holding' for a stock such as pool stake, 'flow' for movement inside the window. */
    basis       : String(8);
    entities    : Integer;
    total       : Decimal(38, 6);
    gini        : Decimal(9, 6);
    nakamoto    : Integer;
    top1Share   : Decimal(9, 6);
    top10Share  : Decimal(9, 6);
    top100Share : Decimal(9, 6);
    windowStart : Timestamp;
    windowEnd   : Timestamp;
  }

  /**
   * How unevenly a dimension is spread — Gini, Nakamoto, and the share of the largest entities.
   *
   * Exact, because it reads every entity in the window rather than a stored top-N. Mind `basis`:
   * over a flow metric this describes how unevenly VOLUME moved, not how unevenly the chain is
   * held. Only pool stake and voting power are holdings.
   */
  function getConcentration(chain     : astra.Chain,
                            dimension : astra.Dimension,
                            metric    : MetricId,
                            window    : LeaderWindow,
                            by        : RankBy,
                            subject   : String(140)) returns ConcentrationResult;

  type DistributionBin { lo : Decimal(38, 6); hi : Decimal(38, 6); count : Integer64; share : Decimal(9, 6); }

  type DistributionResult {
    chain         : astra.Chain;
    metric        : String(60);
    window        : Window;
    unit          : String(20);
    count         : Integer64;
    binsPerOctave : Integer;
    min           : Decimal(38, 6);
    max           : Decimal(38, 6);
    p50           : Decimal(38, 6);
    p95           : Decimal(38, 6);
    bins          : many DistributionBin;
    windowStart   : Timestamp;
    windowEnd     : Timestamp;
  }

  /** The stored histogram as bins, so a client can draw the shape instead of two percentiles. */
  function getDistribution(chain : astra.Chain, metric : MetricId, window : Window) returns DistributionResult;

  type Anomaly {
    metric       : String(60);
    unit         : String(20);
    day          : Timestamp;
    value        : Decimal(38, 6);
    baseline     : Decimal(38, 6);
    stddev       : Decimal(38, 6);
    z            : Decimal(12, 4);
    direction    : String(4);
    baselineDays : Integer;
  }

  type AnomalyReport {
    chain        : astra.Chain;
    threshold    : Decimal(6, 2);
    baselineDays : Integer;
    day          : Timestamp;
    anomalies    : many Anomaly;
  }

  /**
   * Days that sit far from their own recent baseline, measured in standard deviations.
   *
   * Looks at the last COMPLETE day only — a day still filling would flag itself. Every number the
   * verdict rests on comes back with it, so a reader can disagree.
   */
  function getAnomalies(chain : astra.Chain, threshold : Decimal(6, 2), baselineDays : Integer) returns AnomalyReport;

  type VerificationMismatch { height : Integer64; field : String(10); ours : String(80); reference : String(80); }

  type VerificationResult {
    chain      : astra.Chain;
    reference  : String(40);
    samples    : Integer;
    checked    : Integer;
    mismatches : many VerificationMismatch;
    fromHeight : Integer64;
    toHeight   : Integer64;
    durationMs : Integer;
    ranAt      : Timestamp;
    /** Set when the check could not run — no verdict beats a falsely clean one. */
    error      : String(200);
  }

  /** Compare random indexed blocks (hash, transaction count, size, fees) against an independent public indexer. */
  @requires: 'admin'
  action verifyNow(chain : astra.Chain, samples : Integer) returns VerificationResult;

  /** Drop aggregates from a height on and recompute (admin). fromHeight null = everything. */
  @requires: 'admin'
  action recompute(chain : astra.Chain, fromHeight : Integer64) returns SyncStatus;

  /** Run one aggregation cycle now instead of waiting for the poll (admin). */
  @requires: 'admin'
  action runNow(chain : astra.Chain) returns SyncStatus;
}
