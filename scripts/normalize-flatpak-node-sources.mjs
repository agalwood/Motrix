#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PLAYWRIGHT_CACHE_PREFIX = 'flatpak-node/cache/ms-playwright/'

// The CI contract compares the committed file byte-for-byte against a fresh
// generator run piped through this script, so the byte format must have a
// single authority. That authority is biome (the repo-wide formatter) — not
// JSON.stringify, whose array layout differs from biome's, and not the
// generator, whose format varies across versions.
export function biomeFormatJson(filePath) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'biome', 'format', '--write', filePath],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    throw new Error(`biome format failed for ${filePath}`)
  }
}

export function normalizeFlatpakNodeSources(sources) {
  if (!Array.isArray(sources)) {
    throw new TypeError('Flatpak Node sources must be an array')
  }

  // The application build installs with --ignore-scripts and never launches
  // Playwright. flatpak-node-generator nevertheless adds all test-browser
  // payloads when it sees the devDependency, which would add hundreds of MiB
  // to every source fetch. Keep the package tarballs, Electron runtime, and
  // Electron headers; remove only Playwright's unused browser cache.
  return sources.filter((source) => {
    if (typeof source !== 'object' || source === null) return true
    const dest = source.dest
    return typeof dest !== 'string' || !dest.startsWith(PLAYWRIGHT_CACHE_PREFIX)
  })
}

export async function normalizeFlatpakNodeSourcesFile(filePath) {
  const source = JSON.parse(await readFile(filePath, 'utf8'))
  const normalized = normalizeFlatpakNodeSources(source)
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  biomeFormatJson(filePath)
  return {
    before: source.length,
    after: normalized.length,
  }
}

async function main() {
  const filePath = path.resolve(
    process.argv[2] ?? 'flatpak/generated-sources.json'
  )
  const result = await normalizeFlatpakNodeSourcesFile(filePath)
  process.stdout.write(
    `normalized Flatpak Node sources: ${result.before} -> ${result.after}\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main()
}
