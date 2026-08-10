#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { biomeFormatJson } from './normalize-flatpak-node-sources.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

// flatpak-cargo-generator's output format varies across versions; the CI
// contract compares the committed file byte-for-byte, so re-serialize and
// biome-format here to make the committed format depend only on the repo's
// own formatter.
export function serializeFlatpakCargoSources(sources) {
  if (!Array.isArray(sources)) {
    throw new TypeError('Flatpak Cargo sources must be an array')
  }
  return `${JSON.stringify(sources, null, 2)}\n`
}

export async function normalizeFlatpakCargoSourcesFile(filePath) {
  const sources = JSON.parse(await readFile(filePath, 'utf8'))
  await writeFile(filePath, serializeFlatpakCargoSources(sources), 'utf8')
  biomeFormatJson(filePath)
  return { entries: sources.length }
}

async function main() {
  const filePath = path.resolve(process.argv[2] ?? 'flatpak/cargo-sources.json')
  const result = await normalizeFlatpakCargoSourcesFile(filePath)
  process.stdout.write(
    `normalized Flatpak Cargo sources: ${result.entries} entries\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main()
}
