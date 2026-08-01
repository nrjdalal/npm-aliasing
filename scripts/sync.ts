#!/usr/bin/env bun
/**
 * Mirrors an upstream npm package under a name we hold, so the name stays
 * claimed and keeps working instead of rotting or being squatted.
 *
 * We repack the published upstream tarball rather than building from source.
 * Source layouts change (upstream became a pnpm monorepo and silently broke
 * this repo for a year); a published tarball is a stable contract.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
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

type Alias = { name: string; upstream: string; description?: string }

const dryRun = process.argv.includes('--dry-run')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
/** Write the built package here instead of publishing, so it can be tested. */
const out = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)

const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})\n${r.stderr || r.stdout}`)
  }
  return r.stdout.trim()
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
 * Rewrite the upstream name to the alias name inside text files. Upstream
 * embeds its own name in help output and in the `cli({ name })` call, so a
 * plain repack would introduce a package that calls itself something else.
 */
const rebrand = (root: string, from: string, to: string) => {
  for (const file of walk(root)) {
    if (!REWRITABLE.test(file)) continue
    const before = readFileSync(file, 'utf8')
    const after = before.replaceAll(from, to)
    if (after !== before) writeFileSync(file, after)
  }
}

const publishAlias = async (alias: Alias, version: string) => {
  const tmp = mkdtempSync(join(tmpdir(), 'npm-aliasing-'))
  try {
    run('npm', ['pack', `${alias.upstream}@${version}`, '--pack-destination', tmp])
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for ${alias.upstream}@${version}`)
    run('tar', ['-xzf', tarball], tmp)

    const dir = join(tmp, 'package')
    const manifestPath = join(dir, 'package.json')

    // Rebrand before touching the manifest so our own fields survive verbatim.
    rebrand(dir, alias.upstream, alias.name)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.name = alias.name
    manifest.version = version
    if (alias.description) manifest.description = alias.description
    manifest.repository = { type: 'git', url: 'git+https://github.com/nrjdalal/npm-aliasing.git' }
    manifest.homepage = 'https://github.com/nrjdalal/npm-aliasing#readme'
    manifest.bugs = 'https://github.com/nrjdalal/npm-aliasing/issues'
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
        `# ${alias.name}`,
        '',
        `\`${alias.name}\` is an alias of [\`${alias.upstream}\`](https://www.npmjs.com/package/${alias.upstream}) at version \`${version}\`.`,
        'It is the upstream tarball republished under this name, so the two behave identically.',
        '',
        `The name is held so it cannot be squatted. Published from [nrjdalal/npm-aliasing](https://github.com/nrjdalal/npm-aliasing).`,
        '',
        `Prefer the upstream package: \`npx ${alias.upstream}\`.`,
        '',
      ].join('\n'),
    )

    if (out) {
      const dest = resolve(out, alias.name)
      rmSync(dest, { recursive: true, force: true })
      cpSync(dir, dest, { recursive: true })
      console.log(`built ${alias.name}@${version} at ${dest}`)
      return
    }

    run('npm', ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], dir)
    console.log(`${dryRun ? 'would publish' : 'published'} ${alias.name}@${version}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const config = JSON.parse(readFileSync(new URL('../aliases.json', import.meta.url), 'utf8'))
const aliases: Alias[] = config.aliases.filter((a: Alias) => !only || a.name === only)

if (!aliases.length) throw new Error(only ? `no alias named ${only}` : 'no aliases configured')

let failed = false

for (const alias of aliases) {
  try {
    const upstream = await latestVersion(alias.upstream)
    if (!upstream) throw new Error(`upstream ${alias.upstream} has no published version`)

    const current = await latestVersion(alias.name)
    if (current === upstream) {
      console.log(`${alias.name}@${current} already matches ${alias.upstream}, skipping`)
      continue
    }

    console.log(`${alias.name}: ${current ?? 'unpublished'} -> ${alias.upstream}@${upstream}`)
    await publishAlias(alias, upstream)
  } catch (error) {
    failed = true
    console.error(`${alias.name}: ${error instanceof Error ? error.message : error}`)
  }
}

// Exit non-zero so a broken mirror is visible instead of a green check.
if (failed) process.exit(1)
