/**
 * @cap-js/postgres puts no 'error' listener on its clients, so a PostgreSQL restart kills the
 * process. Each client gets one that marks it dead; the pool tests clients on borrow.
 */
import cds from '@sap/cds';
import path from 'node:path';
import { createRequire } from 'node:module';

const LOG = cds.log('astra');

interface PoolFactory {
  options?: Record<string, unknown>;
  create: (...args: any[]) => Promise<any>;
  destroy: (client: any) => unknown;
  validate: (client: any) => unknown;
}

/** Wraps a pool factory: listener on every client, testOnBorrow unless configured. */
export function guardFactory(factory: PoolFactory, name: string): PoolFactory {
  return {
    ...factory,
    options: { testOnBorrow: true, ...(factory.options ?? {}) },
    create: async (...args: any[]) => {
      const client = await factory.create(...args);
      client.on?.('error', (err: any) => {
        client.open = false;
        LOG.warn(`postgres connection of ${name} lost (${err?.code ?? '-'}): ${err?.message ?? err}`);
      });
      return client;
    },
  };
}

let installed = false;

/** Patches the PostgresService factory once; false when @cap-js/postgres is not installed. */
export function guardPostgresPools(): boolean {
  if (installed) return true;
  let PostgresService: any;
  try {
    PostgresService = createRequire(path.join(cds.root, 'package.json'))('@cap-js/postgres/lib/PostgresService.js');
  } catch {
    return false;
  }
  const proto = PostgresService?.prototype;
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'factory');
  if (!descriptor?.get) {
    LOG.warn('@cap-js/postgres has no factory getter; pooled connections stay unguarded');
    return false;
  }
  const original = descriptor.get;
  Object.defineProperty(proto, 'factory', {
    configurable: true,
    get() {
      return guardFactory(original.call(this), this.name ?? 'db');
    },
  });
  installed = true;
  return true;
}
