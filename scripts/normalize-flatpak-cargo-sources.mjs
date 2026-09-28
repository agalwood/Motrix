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

// Both native executables have independent locks. Preserve the generator's
// source objects, deduplicate identical destinations, and reject disagreements.
export function mergeFlatpakCargoSources(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    throw new TypeError('Flatpak Cargo sources must be arrays')
  }
  const merged = new Map()
  for (const source of [...left, ...right]) {
    const key = `${source.dest}/${source['dest-filename'] ?? ''}`
    const previous = merged.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) {
      throw new Error(`Conflicting Cargo source: ${key}`)
    }
    merged.set(key, source)
  }
  return [...merged.values()].sort((a, b) => {
    // Cargo config stays last, after each archive/checksum pair.
    const key = (s) =>
      s.dest === 'cargo' ? '~config' : `${s.dest}/${s['dest-filename'] ?? ''}`
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  })
}

export async function normalizeFlatpakCargoSourcesFile(
  filePath,
  additionalPath
) {
  let sources = JSON.parse(await readFile(filePath, 'utf8'))
  if (additionalPath) {
    sources = mergeFlatpakCargoSources(
      sources,
      JSON.parse(await readFile(additionalPath, 'utf8'))
    )
  }
  await writeFile(filePath, serializeFlatpakCargoSources(sources), 'utf8')
  biomeFormatJson(filePath)
  return { entries: sources.length }
}

async function main() {
  const filePath = path.resolve(process.argv[2] ?? 'flatpak/cargo-sources.json')
  const result = await normalizeFlatpakCargoSourcesFile(
    filePath,
    process.argv[3]
  )
  process.stdout.write(
    `normalized Flatpak Cargo sources: ${result.entries} entries\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main()
}
