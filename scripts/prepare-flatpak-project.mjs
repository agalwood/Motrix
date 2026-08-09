#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

function requireValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseArgs(argv) {
  const options = {
    manifest: 'flatpak/app.motrix.native.yml',
    output: 'flatpak/app.motrix.native.ci.yml',
    archive: 'flatpak/motrix-source.tar.gz',
    ref: 'HEAD',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!Object.hasOwn(options, flag.slice(2))) {
      throw new Error(`unknown flag: ${flag}`)
    }
    const key = flag.slice(2)
    options[key] = requireValue(argv, index, flag)
    index += 1
  }
  return options
}

function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

export function replaceApplicationSource(manifest, archivePath) {
  const root = requireRecord(structuredClone(manifest), 'Flatpak manifest')
  if (!Array.isArray(root.modules)) {
    throw new Error('Flatpak manifest modules must be an array')
  }
  const motrix = root.modules.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.name === 'motrix'
  )
  const module = requireRecord(motrix, 'motrix module')
  if (!Array.isArray(module.sources)) {
    throw new Error('motrix module sources must be an array')
  }
  const sourceIndexes = module.sources.flatMap((source, index) => {
    if (
      typeof source === 'object' &&
      source !== null &&
      source.type === 'git'
    ) {
      return [index]
    }
    return []
  })
  if (sourceIndexes.length !== 1) {
    throw new Error(
      `motrix module must have exactly one git source, found ${sourceIndexes.length}`
    )
  }
  module.sources[sourceIndexes[0]] = {
    type: 'archive',
    path: archivePath,
    'strip-components': 0,
  }
  return root
}

function createArchive(repoRoot, outputPath, ref) {
  const result = spawnSync(
    'git',
    ['archive', '--format=tar.gz', `--output=${outputPath}`, ref],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `git archive failed (${result.status ?? 'unknown'}): ${result.stderr.trim()}`
    )
  }
}

export async function prepareFlatpakProject(options, repoRoot = process.cwd()) {
  const manifestPath = path.resolve(repoRoot, options.manifest)
  const outputPath = path.resolve(repoRoot, options.output)
  const archivePath = path.resolve(repoRoot, options.archive)
  const outputDir = path.dirname(outputPath)
  const relativeArchive = path.relative(outputDir, archivePath)

  if (
    relativeArchive === '' ||
    relativeArchive.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArchive)
  ) {
    throw new Error('Flatpak CI archive must be inside the manifest directory')
  }

  await mkdir(outputDir, { recursive: true })
  createArchive(repoRoot, archivePath, options.ref)

  const manifest = yaml.load(await readFile(manifestPath, 'utf8'))
  const prepared = replaceApplicationSource(
    manifest,
    relativeArchive.split(path.sep).join('/')
  )
  await writeFile(
    outputPath,
    yaml.dump(prepared, {
      lineWidth: 100,
      noCompatMode: true,
      noRefs: true,
      quotingType: "'",
    }),
    'utf8'
  )
  return { manifestPath: outputPath, archivePath }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = await prepareFlatpakProject(options)
  process.stdout.write(`prepared ${result.manifestPath}\n`)
  process.stdout.write(`archived ${result.archivePath}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `Flatpak project preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exitCode = 1
  }
}
