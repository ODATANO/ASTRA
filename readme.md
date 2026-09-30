# ODATANO ASTRA

Analytics for Cardano and Midnight as OData V4, with a public dashboard on top.
ASTRA reads the databases the hosted [ODATANO](https://github.com/ODATANO/ODATANO)
and [NIGHTGATE](https://github.com/ODATANO/NIGHTGATE) instances already fill,
aggregates them into time buckets (minute, hour, day) and serves windows, series,
rankings and cross-chain comparisons under `/odata/v4/astra`. Every number names
the block range it was computed from.

## How it works

- **No second indexer.** ASTRA connects read-only (role `astra_ro`, SELECT only) to the
  Postgres databases of ODATANO and NIGHTGATE and queries them through copies of their
  CDS models (`source-models/`, synced with `npm run sources:sync`). The products are not
  a runtime dependency.
- **Buckets, not raw data.** A scheduler polls each source's sync cursor, aggregates new
  blocks in chunks into minute, hour and day buckets (count, sum, min, max, log histogram)
  and per-entity buckets for rankings. Reorgs in the sources are detected and recomputed.
- **Midnight fees trail the blocks.** NIGHTGATE writes each fee as 0 and fills in the real
  value later (indexer supplement, `lastSupplementedHeight`). ASTRA aggregates the fee
  metrics in a pass of their own up to that height (`SyncStatus.feeHeight`);
  `ChainOverview` reports `feesThroughHeight` / `feesThroughAt` and leaves the 24 h fee
  figures empty while the fees are more than an hour behind the newest block.
- **Midnight decoded facts trail the blocks too.** NIGHTGATE's payload decode pass fills DUST
  consumed, DUST spends and registrations, Zswap inputs/outputs/transients and the circuit
  name, and settles the transaction type (`lastDecodedHeight`). ASTRA aggregates them in a
  pass of their own up to that height (`SyncStatus.decodeHeight`): `tx.decoded`, `tx.zswap`,
  `tx.shielded`, `tx.withProof`, `tx.contractCalls`, `tx.contractDeploys`, `dust.*`,
  `zswap.*`, and the rankings `TopContracts` / `TopCircuits`. When the source lowers that
  height to decode a range again (`redecodeFromHeight`), ASTRA drops what it aggregated
  above it and follows the source up again.
- **Views are memoised.** A ready-made view (`ChainOverview`, `KeyFigures`, the daily
  entities, the rankings) is computed once per parameter set and kept for
  `ASTRA_VIEW_CACHE_MS` (default 5 s, 0 = off); readers that arrive while it computes
  share the result. Query options still apply per request.
- **One instance per network.** The `network` label comes from the sources themselves;
  mainnet, preprod and preview each run their own ASTRA next to their own sources.

## API

Ready-made entities need no metric id and take `$filter`, `$orderby`, `$top`/`$skip`,
`$select` and `$count`; a plain GET reads newest first.

| Entity / function | Answers |
| --- | --- |
| `ChainOverview` | per chain: network, tip, lags, blocks and transactions of the last hour, fees of the last 24 h |
| `KeyFigures` | every chain-wide metric over every window (1h, 24h, 7d, 14d, 30d): value, previous window, change in % |
| `BlocksDaily`, `TransactionsDaily`, `FeesDaily`, `TokensDaily`, `StakeDaily` | one row per chain and UTC day with named columns |
| `StakeEpochs` | pools, live stake, DReps and voting power per epoch (Cardano) |
| `TopTokens`, `TopPolicies`, `TopAddresses`, `TopScripts`, `TopBlockProducers`, `TopPools`, `TopDReps`, `TopDelegatedPools`, `TopVotedDReps` | rankings per chain and window |
| `getWindow`, `getSeries`, `compare`, `getDistribution`, `getAnomalies`, `getTop`, `getConcentration` | the generic functions for one metric (`metric` is the enum `MetricId`) |
| `Metrics`, `MetricBuckets`, `EntityBuckets`, `Snapshots`, `Reorgs`, `VerificationRuns`, `SyncStatus` | the raw aggregates and the state of the pipeline, with `$apply` |

```http
GET /odata/v4/astra/ChainOverview
GET /odata/v4/astra/KeyFigures?$filter=chain eq 'cardano' and window eq '7d'
GET /odata/v4/astra/FeesDaily?$top=14&$orderby=day desc
GET /odata/v4/astra/TopBlockProducers?$filter=window eq '7d' and rank le 10
GET /odata/v4/astra/compare(metric='tx.count',window='14d')
GET /odata/v4/astra/getSeries(chain='midnight',metric='fees.paid',window='24h')
```

Both chains share every entity: a column a chain does not have is null and the row stays.
Reads are public (`@requires: 'any'`); the admin actions `recompute`, `runNow` and
`verifyNow` need the `admin` role.

## Dashboard

`app/` is a static page (no framework, brand tokens from `@odatano/brand`) that CAP serves
at `/`: headline numbers of both chains, a blocks-per-minute heartbeat, transactions, fees,
fee distribution, transaction mix, block fill and block interval over a window (24 h, 7 d,
30 d), token mints and burns, the Midnight ledger (DUST, shielded activity, contracts and
circuits), Cardano stake and governance (epoch figures, certificates, withdrawals, pools and
DReps), and the rankings. Sections of a chain the instance has no source for are left out.
Day and night theme, every chart with a crosshair tooltip.

The page lives next to the API pages, one host per network: `astra.preview.odatano.dev`,
`astra.preprod.odatano.dev`, `astra.odatano.dev` (mainnet), each the reverse proxy in front
of that network's ASTRA on `127.0.0.1:4017`. The network switch asks `/api/networks`, which
probes the sister instances from the server (`ASTRA_NETWORKS`, default the three hosts) and
shows an instance that does not answer as "soon". [ODATANO ACCESS](https://github.com/ODATANO/ACCESS)
links the dashboard from its header (`ASTRA_DASHBOARD_URL`, default derived from its own
host). `?api=<url>` points the page at another instance for local work.

## Local development

```bash
npm install
npm run sources:sync        # db/*.cds of @odatano/core and @odatano/nightgate (pinned versions)
npm run sources:seed        # synthetic chain data → sources/*.sqlite
npx cds deploy              # ASTRA's own db.sqlite
npm run watch               # http://localhost:4004/ (dashboard), /odata/v4/astra (service)
```

`npm run sources:seed` again appends blocks up to now; `-- --reorg` simulates a reorg.
`npm test` runs the vitest suite, `npm run typecheck` the compiler.

## Deployment

ASTRA runs on the same host as the sources it reads (`docker/docker-compose.yml`: one
container plus its own Postgres for aggregates, joined to the source containers' networks).

1. Create the read-only role in both source databases: `scripts/sql/readonly-role.sql` via `psql`
   inside each source's Postgres container (the file's header shows the command).
2. Copy the repo to the host and create `.env` from `.env.example` (the `astra_ro` URLs, the
   source containers' Docker networks, a password for ASTRA's own Postgres).
3. `docker compose -f docker/docker-compose.yml --env-file .env up -d --build`
4. `curl -s 127.0.0.1:4017/odata/v4/astra/SyncStatus` shows the backfill; `backfilling` turns false once caught up.

Nothing is published beyond loopback. The API route is fronted by
[ODATANO ACCESS](https://github.com/ODATANO/ACCESS) (keys and units); the dashboard gets its
own host on the box's reverse proxy, straight to ASTRA, since its reads are public:

```caddyfile
astra.preprod.odatano.dev {
    reverse_proxy 127.0.0.1:4017
}
```

## License

Apache License 2.0, see [LICENSE](LICENSE). The copies under `source-models/` are the
Apache-2.0 CDS models of `@odatano/core` and `@odatano/nightgate`.
