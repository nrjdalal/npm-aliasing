# NPM Aliasing

Holds npm names by mirroring their upstream package, so the names stay claimed, stay working, and cannot be squatted.

| Alias                                                                    | Mirrors                                                                    | Status                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------ |
| [`create-router-app`](https://www.npmjs.com/package/create-router-app)   | [`create-tsrouter-app`](https://www.npmjs.com/package/create-tsrouter-app) | held here                                  |
| [`create-start-app`](https://www.npmjs.com/package/create-start-app)     | [`create-tsrouter-app`](https://www.npmjs.com/package/create-tsrouter-app) | handed over to TanStack, no longer mirrored |

## How it works

`scripts/sync.ts` reads `aliases.json`. For each alias it compares the alias's published version against upstream's, and when they differ it:

1. `npm pack`s the upstream tarball at that version,
2. rewrites the upstream name to the alias name (upstream embeds its own name in `bin`, in help output, and in the `cli({ name })` call),
3. repoints `repository` / `homepage` / `bugs` at this repo and drops `scripts`, `devDependencies` and `packageManager`,
4. publishes.

The alias version always equals the upstream version it mirrors.

Nothing is built from source. Upstream restructured into a pnpm monorepo, which silently broke the previous clone-and-build approach for a year, because the root `package.json` became `"private": true` and `npm publish || true` hid the error. A published tarball is a stable contract; a source layout is not.

## Adding an alias

Add an entry to `aliases.json`:

```json
{ "name": "the-name-you-hold", "upstream": "the-package-to-mirror" }
```

## Running it

```sh
bun run sync:dry                     # resolve versions, npm publish --dry-run
bun scripts/sync.ts --out=/tmp/build # build to disk instead of publishing, for testing
bun run sync                         # publish
```

Publishing needs `NODE_AUTH_TOKEN` (CI reads it from the `NPM_TOKEN` secret). The workflow runs on push to `main`, daily at 06:00 UTC, and on manual dispatch. It exits non-zero on failure, so a broken mirror shows up as a red check instead of a green one.
