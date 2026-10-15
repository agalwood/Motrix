import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    consumer: { type: 'string', multiple: true },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(
    'Build an immutable local MDXP snapshot for Safari integration testing.\n' +
      'node scripts/safari-local-mdxp.mjs --source /path/to/mdxp [--consumer /path/to/extension] [--consumer /path/to/Motrix]\n' +
      'Consumers use the snapshot through node_modules only. Existing dependencies are backed up; manifests, lockfiles, and package stores remain unchanged.'
  )
  process.exit(0)
}
if (!values.source) throw new Error('--source is required')
const source = realpathSync(resolve(values.source))
const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
if (readJson(join(source, 'package.json')).name !== '@motrix/mdxp')
  throw new Error('The source must be the MDXP repository')
const consumers = (values.consumer ?? []).map((path) => {
  const consumer = realpathSync(resolve(path))
  if (!readJson(join(consumer, 'package.json')).dependencies?.['@motrix/mdxp'])
    throw new Error(`Not an MDXP consumer: ${consumer}`)
  const target = join(consumer, 'node_modules/@motrix/mdxp')
  if (!existsSync(target))
    throw new Error(`Install normal dependencies first: ${consumer}`)
  return { consumer, target }
})

const digest = createHash('sha256')
function hash(path) {
  const full = join(source, path)
  const stat = lstatSync(full)
  digest.update(`${path}\0`)
  if (stat.isDirectory()) {
    for (const child of readdirSync(full).sort()) hash(join(path, child))
  } else if (stat.isFile()) {
    const contents = readFileSync(full)
    digest.update(`${contents.length}\0`)
    digest.update(contents)
  } else
    throw new Error('MDXP source must contain regular files and directories')
}
const snapshotFiles = [
  'package.json',
  'tsconfig.json',
  'src',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
]
for (const path of snapshotFiles) hash(path)
const sourceHash = digest.digest('hex')
const snapshot = join(root, '.cache/safari-native/mdxp', sourceHash)
const marker = join(snapshot, 'safari-local-build.json')
if (!existsSync(marker)) {
  rmSync(snapshot, { recursive: true, force: true })
  mkdirSync(snapshot, { recursive: true })
  for (const path of snapshotFiles)
    cpSync(join(source, path), join(snapshot, path), { recursive: true })
  symlinkSync(
    join(source, 'node_modules'),
    join(snapshot, 'node_modules'),
    'dir'
  )
  const result = spawnSync(
    join(source, 'node_modules/.bin/tsc'),
    ['-p', join(snapshot, 'tsconfig.json')],
    { stdio: 'inherit' }
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('MDXP snapshot compilation failed')
  writeFileSync(marker, `${JSON.stringify({ source, sourceHash }, null, 2)}\n`)
}

function copyPackageContents(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (path) =>
      path === from ||
      !path
        .slice(from.length + 1)
        .split('/')
        .includes('node_modules'),
  })
}

function resolveDependency(from, name) {
  let directory = from
  while (true) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json')))
      return realpathSync(candidate)
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`Missing installed runtime dependency: ${name}`)
    directory = parent
  }
}

function copyRuntimeDependencies(
  from,
  destination,
  consumer,
  installed = new Map()
) {
  const manifest = readJson(join(from, 'package.json'))
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const dependency = resolveDependency(from, name)
    const dependencyManifest = readJson(join(dependency, 'package.json'))
    const shared = join(consumer, 'node_modules', name)
    if (existsSync(join(shared, 'package.json'))) {
      const location = relative(consumer, realpathSync(shared))
      if (
        location !== '..' &&
        !location.startsWith('../') &&
        !isAbsolute(location) &&
        readJson(join(shared, 'package.json')).version ===
          dependencyManifest.version
      )
        continue
    }
    const previous = installed.get(name)
    if (previous) {
      if (previous !== dependencyManifest.version)
        throw new Error(`Conflicting local runtime versions for ${name}`)
      continue
    }
    installed.set(name, dependencyManifest.version)
    const target = join(destination, 'node_modules', name)
    mkdirSync(dirname(target), { recursive: true })
    copyPackageContents(dependency, target)
    copyRuntimeDependencies(dependency, destination, consumer, installed)
  }
}

for (const { consumer, target } of consumers) {
  const activationMarker = join(target, 'safari-local-build.json')
  if (
    !lstatSync(target).isSymbolicLink() &&
    existsSync(activationMarker) &&
    readJson(activationMarker).sourceHash === sourceHash &&
    readJson(activationMarker).activationVersion === 2
  ) {
    console.log(JSON.stringify({ consumer, status: 'up-to-date', snapshot }))
    continue
  }
  // Rename the entry itself, never mutate a pnpm store or a followed symlink.
  const suffix = randomUUID()
  const backup = join(dirname(target), `.mdxp-before-safari-${suffix}`)
  const staged = join(dirname(target), `.mdxp-incoming-${suffix}`)
  try {
    // Keep the complete runtime closure inside each consumer's project boundary.
    // Packaging and license verification must not depend on external symlinks.
    copyPackageContents(snapshot, staged)
    copyRuntimeDependencies(snapshot, staged, consumer)
    writeFileSync(
      join(staged, 'safari-local-build.json'),
      `${JSON.stringify({ source, sourceHash, activationVersion: 2 }, null, 2)}\n`
    )
    renameSync(target, backup)
    try {
      renameSync(staged, target)
    } catch (error) {
      renameSync(backup, target)
      throw error
    }
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
  console.log(
    JSON.stringify({ consumer, status: 'activated', snapshot, backup })
  )
}
console.log(
  `Local MDXP source snapshot: ${sourceHash}; no package was published`
)
