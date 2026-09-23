import type { Chain, ChainSource } from './types';
import { connectSource, type SourceDbConfig } from './source-db';
import { CardanoSource } from './cardano-source';
import { MidnightSource } from './midnight-source';

export * from './types';
export { configuredChains, connectSource, resolveSourceConfig, loadSourceModel, ensureSqliteSchema, resetSourceCache } from './source-db';
export { CardanoSource } from './cardano-source';
export { MidnightSource } from './midnight-source';

/** Builds the source adapter for a chain over its (read-only) database connection. */
export async function openChainSource(chain: Chain, override?: SourceDbConfig): Promise<ChainSource> {
  const db = await connectSource(chain, override);
  return chain === 'cardano' ? new CardanoSource(db) : new MidnightSource(db);
}
