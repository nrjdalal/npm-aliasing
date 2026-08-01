# NPM Aliasing

Holds npm names so they cannot be squatted.

## Reserved

Names held for projects that have not shipped code to npm yet. Each publishes a stub that points at the real project.

| Name                                                             | Project                              |
| ---------------------------------------------------------------- | ------------------------------------ |
| [`artifacto`](https://www.npmjs.com/package/artifacto)           | [artifacto.sh](https://artifacto.sh) |
| [`artifacto-sh`](https://www.npmjs.com/package/artifacto-sh)     | [artifacto.sh](https://artifacto.sh) |
| [`dalonic`](https://www.npmjs.com/package/dalonic)               | [dalonic.com](https://dalonic.com)   |
| [`dalonic-ai`](https://www.npmjs.com/package/dalonic-ai)         | [dalonic.com](https://dalonic.com)   |
| [`turnly`](https://www.npmjs.com/package/turnly)                 | [turnly.gg](https://turnly.gg)       |

A reserved name is claimed once, at `0.0.1`. If the name already has any published version the sync skips it, so a real release can never be overwritten by a stub.

## Mirrored

Names held by republishing an upstream package's tarball under them, so the name stays claimed and keeps working. None are active right now.

Previously held: `create-router-app` and `create-start-app`, both mirroring `create-tsrouter-app`. `create-start-app` was handed over to TanStack, who now publish it themselves.

## How it works

`scripts/sync.ts` reads `names.json`.

For a **reserved** name, it publishes a small stub: description, homepage, and a README saying what the name is for.

For a **mirrored** name, it compares the held version against upstream's, and when they differ it `npm pack`s the upstream tarball, rewrites the upstream name to ours (upstream embeds its own name in `bin`, in help output, and in the `cli({ name })` call), repoints `repository` / `homepage` / `bugs` at this repo, drops `scripts` / `devDependencies` / `packageManager`, and publishes. The mirrored version always equals the version it mirrors.

Nothing is built from source. Upstream restructured into a pnpm monorepo, which silently broke the previous clone-and-build approach for a year, because the root `package.json` became `"private": true` and `npm publish || true` hid the error. A published tarball is a stable contract; a source layout is not.

## Adding a name

Add an entry to `names.json`:

```json
{ "name": "the-name", "description": "What it is.", "homepage": "https://where-it-lives" }
```

or, to mirror an upstream package:

```json
{ "name": "the-name-you-hold", "upstream": "the-package-to-mirror" }
```

## Running it

```sh
bun run sync:dry                     # resolve versions, npm publish --dry-run
bun scripts/sync.ts --out=/tmp/build # build to disk instead of publishing, for testing
bun scripts/sync.ts --only=turnly    # act on a single name
bun run sync                         # publish
```

Publishing needs `NODE_AUTH_TOKEN`, which CI reads from the `NPM_TOKEN` secret. It must be an **automation** token: a classic *Publish* token fails in CI with `EOTP` because it demands a one-time password.

The workflow runs on push to `main`, daily at 06:00 UTC, and on manual dispatch. It exits non-zero on failure, so a broken name shows up as a red check instead of a green one.
