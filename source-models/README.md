# Source models

Read-only copies of the CDS data models of the two products ASTRA reads:

| Directory | Package | Pinned in |
| --- | --- | --- |
| `odatano/` | [`@odatano/core`](https://www.npmjs.com/package/@odatano/core) (Cardano) | `package.json` → `sourceModels` |
| `nightgate/` | [`@odatano/nightgate`](https://www.npmjs.com/package/@odatano/nightgate) (Midnight) | `package.json` → `sourceModels` |

Both packages are Apache-2.0, like ASTRA. Only their `db/*.cds` files are copied,
never their services or plugins: ASTRA compiles its queries against these
definitions so they hit the same physical tables the hosted instances fill,
and never deploys them itself (this directory sits outside `db/`, `srv/` and
`app/` on purpose).

`npm run sources:sync` refreshes the copies from the npm registry at the pinned
versions and rewrites each directory's `VERSION` file. Bump the pin when the
hosted instance is upgraded, then run the tests: they build fake source
databases from these models in SQLite and show at once whether the adapters
still fit.
