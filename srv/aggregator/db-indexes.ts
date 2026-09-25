/**
 * Secondary indexes the CDS model cannot declare. The EntityBuckets key starts with dimension and
 * entityId, so reads by time window (chain, granularity, bucketStart) would scan the table.
 * Created at start with CREATE INDEX IF NOT EXISTS; failures are logged, never fatal.
 */
import cds from '@sap/cds';

const LOG = cds.log('astra');

export interface IndexSpec {
  name: string;
  /** Table name as @cap-js creates it (namespace_Entity). */
  table: string;
  columns: string;
}

export const DB_INDEXES: readonly IndexSpec[] = Object.freeze([
  // leaderboard windows: entity rows of a chain and granularity in a time range
  { name: 'odatano_astra_entitybuckets_window', table: 'odatano_astra_EntityBuckets', columns: 'chain, granularity, bucketStart' },
]);

export function indexStatement(spec: IndexSpec): string {
  return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.columns})`;
}

type SqlRunner = { run: (sql: string) => Promise<unknown>; kind?: string };

export async function ensureDbIndexes(runner: SqlRunner | undefined = cds.db as unknown as SqlRunner | undefined): Promise<string[]> {
  const failed: string[] = [];
  if (!runner || runner.kind === 'hana') return failed;
  for (const spec of DB_INDEXES) {
    try {
      await runner.run(indexStatement(spec));
    } catch (e: any) {
      failed.push(spec.name);
      LOG.warn(`index ${spec.name} not ensured: ${e?.message ?? e}`);
    }
  }
  return failed;
}
