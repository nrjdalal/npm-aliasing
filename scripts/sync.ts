#!/usr/bin/env bun
/**
 * Holds npm names so they cannot be squatted, two ways:
 *
 * - mirror:  republish an upstream package's tarball under a name we hold.
 *            We repack the published tarball rather than building from source,
 *            because source layouts change (upstream became a pnpm monorepo and
 *            silently broke this repo for a year) while a tarball is a contract.
 *
 * - reserve: publish a stub that points at the real project, for names we own
 *            but have not shipped code under yet.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REGISTRY = 'https://registry.npmjs.org'
const REWRITABLE = /\.(js|mjs|cjs|ts|mts|cts|json|md|txt)$/
const REPO = 'nrjdalal/npm-aliasing'
const AUTHOR = {
  name: 'Neeraj Dalal',
  email: 'admin@nrjdalal.com',
  url: 'https://nrjdalal.com',
}

type Mirror = { name: string; upstream: string; description?: string }
type Reserve = { name: string; description: string; homepage: string; keywords?: string[] }

const dryRun = process.argv.includes('--dry-run')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
/** Write built packages here instead of publishing, so they can be tested. */
const out = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)

/**
 * `interactive` hands our stdio to the child. npm's 2FA flow needs a TTY to
 * open a browser and wait for the challenge; piped stdio makes it print a URL
 * nobody can answer and fail with EOTP.
 */
const run = (
  cmd: string,
  args: string[],
  { cwd, interactive = false }: { cwd?: string; interactive?: boolean } = {},
) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : 'pipe',
  })
  if (r.status !== 0) {
    const detail = r.stderr || r.stdout
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})${detail ? `\n${detail}` : ''}`)
  }
  return r.stdout?.trim() ?? ''
}

/** Latest published version, or null when the name has never been published. */
const latestVersion = async (pkg: string) => {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(pkg)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`registry lookup for ${pkg} failed: ${res.status}`)
  const body = (await res.json()) as { 'dist-tags'?: Record<string, string> }
  return body['dist-tags']?.latest ?? null
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

/**
 * Rewrite the upstream name to ours inside text files. Upstream embeds its own
 * name in help output and in the `cli({ name })` call, so a plain repack would
 * produce a package that calls itself something else.
 */
const rebrand = (root: string, from: string, to: string) => {
  for (const file of walk(root)) {
    if (!REWRITABLE.test(file)) continue
    const before = readFileSync(file, 'utf8')
    const after = before.replaceAll(from, to)
    if (after !== before) writeFileSync(file, after)
  }
}

/** Publish the prepared directory, or divert it to --out for inspection. */
const ship = (dir: string, name: string, version: string) => {
  if (out) {
    const dest = resolve(out, name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(resolve(out), { recursive: true })
    cpSync(dir, dest, { recursive: true })
    console.log(`built ${name}@${version} at ${dest}`)
    return
  }
  run('npm', ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], {
    cwd: dir,
    interactive: true,
  })
  console.log(`${dryRun ? 'would publish' : 'published'} ${name}@${version}`)
}

const withTempDir = async (fn: (dir: string) => Promise<void> | void) => {
  const tmp = mkdtempSync(join(tmpdir(), 'npm-aliasing-'))
  try {
    await fn(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const publishMirror = (entry: Mirror, version: string) =>
  withTempDir((tmp) => {
    run('npm', ['pack', `${entry.upstream}@${version}`, '--pack-destination', tmp])
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for ${entry.upstream}@${version}`)
    run('tar', ['-xzf', tarball], { cwd: tmp })

    const dir = join(tmp, 'package')
    const manifestPath = join(dir, 'package.json')

    // Rebrand before touching the manifest so our own fields survive verbatim.
    rebrand(dir, entry.upstream, entry.name)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.name = entry.name
    manifest.version = version
    if (entry.description) manifest.description = entry.description
    manifest.repository = { type: 'git', url: `git+https://github.com/${REPO}.git` }
    manifest.homepage = `https://github.com/${REPO}#readme`
    manifest.bugs = `https://github.com/${REPO}/issues`
    // A mirror must never run upstream's lifecycle scripts on install.
    delete manifest.scripts
    delete manifest.devDependencies
    delete manifest.packageManager
    delete manifest.private
    delete manifest.publishConfig
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    writeFileSync(
      join(dir, 'README.md'),
      [
        `# ${entry.name}`,
        '',
        `\`${entry.name}\` is an alias of [\`${entry.upstream}\`](https://www.npmjs.com/package/${entry.upstream}) at version \`${version}\`.`,
        'It is the upstream tarball republished under this name, so the two behave identically.',
        '',
        `The name is held so it cannot be squatted. Published from [${REPO}](https://github.com/${REPO}).`,
        '',
        `Prefer the upstream package: \`npx ${entry.upstream}\`.`,
        '',
      ].join('\n'),
    )

    ship(dir, entry.name, version)
  })

const publishReserve = (entry: Reserve) =>
  withTempDir((tmp) => {
    const dir = join(tmp, 'package')
    mkdirSync(dir)

    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: entry.name,
          version: '0.0.1',
          description: entry.description,
          keywords: entry.keywords ?? [],
          homepage: entry.homepage,
          repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
          bugs: `https://github.com/${REPO}/issues`,
          license: 'MIT',
          author: AUTHOR,
          files: ['README.md'],
        },
        null,
        2,
      )}\n`,
    )

    writeFileSync(
      join(dir, 'README.md'),
      [
        `# ${entry.name}`,
        '',
        entry.description,
        '',
        `This name is held for [${entry.homepage.replace(/^https?:\/\//, '')}](${entry.homepage}).`,
        'No code ships under it yet, so nothing here is meant to be installed.',
        '',
        `Reserved from [${REPO}](https://github.com/${REPO}).`,
        '',
      ].join('\n'),
    )

    ship(dir, entry.name, '0.0.1')
  })

const config = JSON.parse(readFileSync(new URL('../names.json', import.meta.url), 'utf8')) as {
  mirror?: Mirror[]
  reserve?: Reserve[]
}

const matches = (name: string) => !only || name === only
const mirrors = (config.mirror ?? []).filter((m) => matches(m.name))
const reserves = (config.reserve ?? []).filter((r) => matches(r.name))

if (only && !mirrors.length && !reserves.length) throw new Error(`no name configured: ${only}`)
if (!mirrors.length && !reserves.length) console.log('nothing configured, nothing to do')

let failed = false

const attempt = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn()
  } catch (error) {
    failed = true
    console.error(`${name}: ${error instanceof Error ? error.message : error}`)
  }
}

for (const entry of mirrors) {
  await attempt(entry.name, async () => {
    const upstream = await latestVersion(entry.upstream)
    if (!upstream) throw new Error(`upstream ${entry.upstream} has no published version`)

    const current = await latestVersion(entry.name)
    if (current === upstream) {
      console.log(`${entry.name}@${current} already matches ${entry.upstream}, skipping`)
      return
    }

    console.log(`${entry.name}: ${current ?? 'unpublished'} -> ${entry.upstream}@${upstream}`)
    await publishMirror(entry, upstream)
  })
}

for (const entry of reserves) {
  await attempt(entry.name, async () => {
    // A reserved name is claimed once. Later versions belong to the real
    // project, so never overwrite whatever is already there.
    const current = await latestVersion(entry.name)
    if (current) {
      console.log(`${entry.name}@${current} already held, skipping`)
      return
    }

    console.log(`${entry.name}: unpublished -> reserving 0.0.1`)
    await publishReserve(entry)
  })
}

// Exit non-zero so a broken name shows up as a red check, not a green one.
if (failed) process.exit(1)
