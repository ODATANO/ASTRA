import type { Chain, ChainSource } from './types';
import { connectSource, disconnectSource, type SourceDbConfig } from './source-db';
import { CardanoSource } from './cardano-source';
import { MidnightSource } from './midnight-source';

export * from './types';
export { configuredChains, connectSource, resolveSourceConfig, loadSourceModel, ensureSqliteSchema, resetSourceCache, disconnectSource } from './source-db';
export { CardanoSource } from './cardano-source';
export { MidnightSource } from './midnight-source';

/** Builds the source adapter for a chain over its (read-only) database connection. */
export async function openChainSource(chain: Chain, override?: SourceDbConfig): Promise<ChainSource> {
  const db = await connectSource(chain, override);
  return chain === 'cardano' ? new CardanoSource(db) : new MidnightSource(db);
}

/** Drops the chain's cached connection (a pool that stopped answering) and opens a new one. */
export async function reopenChainSource(chain: Chain): Promise<ChainSource> {
  await disconnectSource(chain);
  return openChainSource(chain);
}
