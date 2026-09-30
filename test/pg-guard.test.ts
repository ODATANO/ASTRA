import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { guardFactory, guardPostgresPools } from '../srv/pg-guard';

function fakeFactory(options?: Record<string, unknown>) {
  const created: any[] = [];
  return {
    created,
    factory: {
      options,
      create: async () => {
        const client: any = new EventEmitter();
        client.open = true;
        created.push(client);
        return client;
      },
      destroy: () => undefined,
      validate: (c: any) => c.open,
    },
  };
}

describe('guardFactory', () => {
  it('turns an error on an idle client into a dead client instead of an uncaught exception', async () => {
    const { factory } = fakeFactory();
    const guarded = guardFactory(factory, 'astra-source-cardano');
    const client = await guarded.create();

    const fatal = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    // Without a listener EventEmitter throws here; that was the crash.
    expect(() => client.emit('error', fatal)).not.toThrow();
    expect(client.open).toBe(false);
    expect(guarded.validate(client)).toBe(false);
  });

  it('tests clients on borrow unless the pool options say otherwise', () => {
    expect(guardFactory(fakeFactory().factory, 'db').options).toEqual({ testOnBorrow: true });
    expect(guardFactory(fakeFactory({ max: 4, testOnBorrow: false }).factory, 'db').options)
      .toEqual({ testOnBorrow: false, max: 4 });
  });

  it('passes the create arguments through', async () => {
    const seen: any[] = [];
    const guarded = guardFactory({
      create: async (...args: any[]) => { seen.push(args); return new EventEmitter(); },
      destroy: () => undefined,
      validate: () => true,
    }, 'db');
    await guarded.create('tenant-a', 2);
    expect(seen).toEqual([['tenant-a', 2]]);
  });
});

describe('guardPostgresPools', () => {
  it('patches the @cap-js/postgres factory once', async () => {
    expect(guardPostgresPools()).toBe(true);
    expect(guardPostgresPools()).toBe(true);
    const { createRequire } = await import('node:module');
    const PostgresService = createRequire(path.join(process.cwd(), 'package.json'))('@cap-js/postgres/lib/PostgresService.js');
    const factory = Object.getOwnPropertyDescriptor(PostgresService.prototype, 'factory')!.get!
      .call({ name: 'db', options: { pool: { max: 2 } } });
    expect(factory.options).toEqual({ testOnBorrow: true, max: 2 });
  });
});
