#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { dump, loadAll } from 'js-yaml'

// pnpm 12 records its package manager in a separate YAML document. The
// pinned Flatpak generator reads one document and only consumes its packages
// table. Export the complete source inventory, including bootstrap packages,
// without rewriting the install lock or dropping either dependency graph.
export function prepareFlatpakNodeLock(source) {
  const packages = new Map()
  const documents = loadAll(source)
  if (documents.length === 0) throw new Error('Empty pnpm lockfile')
  for (const document of documents) {
    if (document?.lockfileVersion !== '9.0') {
      throw new Error('Flatpak source export requires pnpm lockfile v9')
    }
    if (!document.packages || typeof document.packages !== 'object') {
      throw new Error('pnpm lockfile document is missing its packages table')
    }
    for (const [name, entry] of Object.entries(document.packages)) {
      if (packages.has(name) && !isDeepStrictEqual(packages.get(name), entry)) {
        throw new Error(`Conflicting pnpm source metadata: ${name}`)
      }
      packages.set(name, entry)
    }
  }
  return dump({
    lockfileVersion: '9.0',
    packages: Object.fromEntries(
      [...packages].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    ),
  })
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , input, output] = process.argv
  if (!input || !output) {
    throw new Error('Usage: prepare-flatpak-node-lock.mjs <input> <output>')
  }
  if (path.resolve(input) === path.resolve(output)) {
    throw new Error('The source export must not replace the install lockfile')
  }
  await writeFile(output, prepareFlatpakNodeLock(await readFile(input, 'utf8')))
}
