import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { auditServerRuntime } from './audit-server-runtime.mjs'
import { assertNativeBinaryTarget } from './native-binary-target.mjs'
import {
  betterSqlite3PrebuildName,
  normalizeRelativePath,
  parseServerTarget,
  resolveServerInput,
  stringifySortedJson,
  validateServerRuntimeContract,
  validateServerSizeBudgets,
} from './server-package-utils.mjs'

const execFileAsync = promisify(execFile)
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const GENERATED_MANIFEST_FIELDS = [
  'author',
  'description',
  'homepage',
  'license',
  'productName',
  'version',
]

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is unreadable: ${filePath}`, { cause: error })
  }
}

function generatedManifest(rootManifest, contract) {
  const manifest = {
    name: '@motrix/server-runtime',
  }
  for (const field of GENERATED_MANIFEST_FIELDS) {
    if (rootManifest[field] !== undefined) manifest[field] = rootManifest[field]
  }
  manifest.private = true
  manifest.type = 'module'
  manifest.main = 'dist/server/index.mjs'
  manifest.engines = { node: '>=24' }
  manifest.dependencies = Object.fromEntries(
    contract.runtimeRoots.map((name) => {
      const version = rootManifest.dependencies?.[name]
      if (typeof version !== 'string') {
        throw new Error(`runtime root ${name} is not in root dependencies`)
      }
      return [name, version]
    })
  )
  return manifest
}

function packageAppliesToTarget(manifest, target) {
  function matches(values, actual) {
    if (!Array.isArray(values) || values.length === 0) return true
    const denied = values.includes(`!${actual}`)
    const positive = values.filter((entry) => !entry.startsWith('!'))
    return !denied && (positive.length === 0 || positive.includes(actual))
  }
  return (
    matches(manifest.os, target.platform) && matches(manifest.cpu, target.arch)
  )
}

async function resolvePackageInstance(name, fromRoot, canonicalRepoRoot) {
  const require = createRequire(path.join(fromRoot, 'package.json'))
  const candidates = []
  try {
    candidates.push(require.resolve(`${name}/package.json`))
  } catch {
    for (const searchPath of require.resolve.paths(name) ?? []) {
      candidates.push(path.join(searchPath, name, 'package.json'))
    }
    try {
      let current = path.dirname(require.resolve(name))
      while (current !== path.dirname(current)) {
        candidates.push(path.join(current, 'package.json'))
        current = path.dirname(current)
      }
    } catch {
      // The caller decides whether a missing dependency is optional.
    }
  }

  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (!info?.isFile()) continue
    const manifest = await readJson(candidate, `package ${name}`)
    if (manifest.name !== name || typeof manifest.version !== 'string') continue
    const sourceRoot = await realpath(path.dirname(candidate))
    if (
      sourceRoot !== canonicalRepoRoot &&
      !isInside(canonicalRepoRoot, sourceRoot)
    ) {
      throw new Error(`resolved package ${name} escapes repository root`)
    }
    return { manifest, sourceRoot }
  }
  return undefined
}

function nodeLookupDestinations(consumerDestination, name) {
  const destinations = []
  let current = consumerDestination
  while (true) {
    if (path.posix.basename(current) !== 'node_modules') {
      destinations.push(path.posix.join(current, 'node_modules', name))
    }
    const parent = path.posix.dirname(current)
    if (parent === current || current === '.') break
    current = parent
  }
  destinations.push(path.posix.join('node_modules', name))
  return [...new Set(destinations.map((entry) => entry.replace(/^\.\//, '')))]
}

async function isRootHoisted(repoRoot, name, sourceRoot) {
  const candidate = await realpath(
    path.join(repoRoot, 'node_modules', name)
  ).catch(() => null)
  return candidate === sourceRoot
}

async function assertSafeDirectory(
  sourceRoot,
  canonicalRepoRoot,
  options = {}
) {
  const visited = new Set()
  async function walk(directory) {
    const canonical = await realpath(directory)
    if (visited.has(canonical)) return
    visited.add(canonical)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (options.skipNodeModules && entry.name === 'node_modules') continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(entryPath).catch(() => null)
        if (
          !target ||
          (target !== canonicalRepoRoot && !isInside(canonicalRepoRoot, target))
        ) {
          throw new Error(
            `source symlink escapes repository root: ${entryPath}`
          )
        }
        const targetInfo = await stat(target)
        if (targetInfo.isDirectory()) await walk(target)
      } else if (entry.isDirectory()) {
        await walk(entryPath)
      }
    }
  }
  await walk(sourceRoot)
}

async function normalizeDirectoryModes(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await chmod(entryPath, 0o755)
      await normalizeDirectoryModes(entryPath)
    } else {
      const info = await lstat(entryPath)
      if (info.isSymbolicLink()) {
        throw new Error(`staging emitted a symlink: ${entryPath}`)
      }
      await chmod(entryPath, (info.mode & 0o111) === 0 ? 0o644 : 0o755)
    }
  }
}

async function copyPath(source, destination, canonicalRepoRoot, options = {}) {
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink()) {
    throw new Error(`top-level staging input is a symlink: ${source}`)
  }
  await mkdir(path.dirname(destination), { recursive: true })
  if (sourceInfo.isFile()) {
    await cp(source, destination)
    await chmod(destination, (sourceInfo.mode & 0o111) === 0 ? 0o644 : 0o755)
    return
  }
  if (!sourceInfo.isDirectory()) {
    throw new Error(`staging input is not a file or directory: ${source}`)
  }
  await assertSafeDirectory(source, canonicalRepoRoot, options)
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate)
      if (
        options.skipNodeModules &&
        (relative === 'node_modules' ||
          relative.startsWith(`node_modules${path.sep}`))
      ) {
        return false
      }
      return options.filter ? options.filter(relative) : true
    },
  })
  await chmod(destination, 0o755)
  await normalizeDirectoryModes(destination)
}

function packageCopyFilter(name, target) {
  if (name !== 'better-sqlite3') return undefined
  const selected = `prebuilds/${betterSqlite3PrebuildName(target)}`
  return (relative) => {
    if (relative.length === 0) return true
    const portable = relative.replaceAll(path.sep, '/')
    return (
      portable === 'package.json' ||
      /^LICENSE(?:\..*)?$/i.test(portable) ||
      portable === 'lib' ||
      portable.startsWith('lib/') ||
      portable === 'prebuilds' ||
      portable === selected
    )
  }
}

async function collectNativeModules(directory) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.name.endsWith('.node')) files.push(entryPath)
    }
  }
  await walk(directory)
  return files.sort()
}

async function validateStagedNativeModules(directory, target, packageName) {
  const nativeModules = await collectNativeModules(directory)
  for (const file of nativeModules) {
    await assertNativeBinaryTarget(file, target.platform, target.arch, {
      label: `${packageName} native module`,
    })
  }
  if (packageName === 'better-sqlite3') {
    const expected = path.join(
      directory,
      'prebuilds',
      betterSqlite3PrebuildName(target)
    )
    if (nativeModules.length !== 1 || nativeModules[0] !== expected) {
      throw new Error(
        `better-sqlite3 must stage exactly one ${target.key} prebuild`
      )
    }
  }
}

async function fingerprintInput(repoRoot, input) {
  const source = path.join(repoRoot, input.source)
  const records = []
  async function addFile(filePath, relativePath) {
    const bytes = await readFile(filePath)
    records.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  if (input.type === 'file') {
    await addFile(source, input.source)
  } else {
    async function walk(directory, relativeDirectory) {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name)
        const relativePath = path.posix.join(relativeDirectory, entry.name)
        if (entry.isDirectory()) await walk(entryPath, relativePath)
        else if (entry.isFile()) await addFile(entryPath, relativePath)
        else
          throw new Error(`fingerprint input contains a symlink: ${entryPath}`)
      }
    }
    await walk(source, input.source)
  }
  return {
    source: input.source,
    destination: input.destination,
    files: records,
  }
}

async function inventoryTree(directory) {
  let bytes = 0
  let files = 0
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile()) {
        bytes += (await stat(entryPath)).size
        files += 1
      } else {
        throw new Error(`staged application contains a symlink: ${entryPath}`)
      }
    }
  }
  await walk(directory)
  return { bytes, files }
}

export async function assertServerExternalsResolve(stageRoot, specifiers) {
  const script = [
    `const specifiers = ${JSON.stringify(specifiers)}`,
    'for (const specifier of specifiers) {',
    '  try { import.meta.resolve(specifier) }',
    '  catch (error) {',
    '    console.error(specifier + ": " + error.message)',
    '    process.exitCode = 1',
    '  }',
    '}',
  ].join('\n')
  try {
    await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: stageRoot,
        encoding: 'utf8',
      }
    )
  } catch (error) {
    throw new Error(
      `staged Server cannot resolve built externals: ${error.stderr?.trim() ?? error.message}`,
      { cause: error }
    )
  }
}

async function replaceStageAtomically(stageRoot, temporaryRoot) {
  const backup = `${stageRoot}.previous-${process.pid}-${Date.now()}`
  let hadPrevious = false
  try {
    await rename(stageRoot, backup)
    hadPrevious = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await rename(temporaryRoot, stageRoot)
  } catch (error) {
    if (hadPrevious) await rename(backup, stageRoot)
    throw error
  }
  if (hadPrevious) await rm(backup, { recursive: true })
}

export async function stageServerApp(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPOSITORY_ROOT)
  const canonicalRepoRoot = await realpath(repoRoot)
  const target = parseServerTarget({
    platform: options.platform,
    arch: options.arch,
    libc: options.libc,
    strict: options.strict,
    ci: options.ci,
  })
  const contract = validateServerRuntimeContract(
    options.contract ??
      (await readJson(
        path.join(repoRoot, 'scripts/server-runtime-dependencies.json'),
        'server runtime contract'
      ))
  )
  const budgets = validateServerSizeBudgets(
    options.budgets ??
      (await readJson(
        path.join(repoRoot, 'scripts/server-package-size-budgets.json'),
        'server size budgets'
      ))
  )
  if (!contract.supportedTargets.includes(target.key)) {
    throw new Error(`unsupported Server package target ${target.key}`)
  }
  const resolvedContract = {
    ...contract,
    buildInputs: contract.buildInputs.map((input) =>
      resolveServerInput(input, target)
    ),
    resourceInputs: contract.resourceInputs.map((input) =>
      resolveServerInput(input, target)
    ),
  }
  const inputs = [
    ...resolvedContract.buildInputs,
    ...resolvedContract.resourceInputs,
  ]
  const inputDestinations = inputs.map((input) => input.destination)
  if (new Set(inputDestinations).size !== inputDestinations.length) {
    throw new Error(
      `Server runtime contract has duplicate destinations for ${target.key}`
    )
  }

  const requestedStageRoot = path.resolve(
    options.outputDir ?? path.join(repoRoot, 'dist/server-app')
  )
  const stageRelative = path.relative(repoRoot, requestedStageRoot)
  if (
    stageRelative.length === 0 ||
    stageRelative === '..' ||
    stageRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(stageRelative)
  ) {
    throw new Error(`stage output must stay within repository root`)
  }
  const stageRoot = path.join(canonicalRepoRoot, stageRelative)
  await mkdir(path.dirname(stageRoot), { recursive: true })

  const audit = await auditServerRuntime({
    repoRoot,
    contract: resolvedContract,
    budgets,
  })
  const rootManifest = await readJson(
    path.join(repoRoot, 'package.json'),
    'root package manifest'
  )
  const appManifest = generatedManifest(rootManifest, contract)
  const inputFingerprints = []
  for (const input of inputs) {
    inputFingerprints.push(await fingerprintInput(repoRoot, input))
  }

  const temporaryRoot = await mkdtemp(
    path.join(path.dirname(stageRoot), `.${path.basename(stageRoot)}-`)
  )
  try {
    for (const input of inputs) {
      await copyPath(
        path.join(repoRoot, input.source),
        path.join(temporaryRoot, input.destination),
        canonicalRepoRoot
      )
    }
    await writeFile(
      path.join(temporaryRoot, 'package.json'),
      stringifySortedJson(appManifest),
      { mode: 0o644 }
    )

    const placements = new Map()
    const queue = []
    const optionalOmissions = []

    async function addDependency(name, consumer, optional) {
      const instance = await resolvePackageInstance(
        name,
        consumer.sourceRoot,
        canonicalRepoRoot
      )
      if (!instance) {
        if (optional) {
          optionalOmissions.push({
            name,
            requestedBy: `${consumer.manifest.name}@${consumer.manifest.version}`,
          })
          return
        }
        throw new Error(
          `required dependency ${name} requested by ${consumer.manifest.name}@${consumer.manifest.version} is missing`
        )
      }
      if (!packageAppliesToTarget(instance.manifest, target)) {
        if (optional) {
          optionalOmissions.push({
            name,
            requestedBy: `${consumer.manifest.name}@${consumer.manifest.version}`,
          })
          return
        }
        throw new Error(
          `required dependency ${name} is incompatible with ${target.key}`
        )
      }

      for (const candidate of nodeLookupDestinations(
        consumer.destination,
        name
      )) {
        const existing = placements.get(candidate)
        if (existing?.sourceRoot === instance.sourceRoot) return
      }

      let destination = path.posix.join(
        consumer.destination,
        'node_modules',
        name
      )
      if (await isRootHoisted(repoRoot, name, instance.sourceRoot)) {
        destination = path.posix.join('node_modules', name)
      }
      destination = normalizeRelativePath(
        destination,
        `destination for ${name}`
      )
      const conflict = placements.get(destination)
      if (conflict) {
        if (conflict.sourceRoot === instance.sourceRoot) return
        throw new Error(
          `dependency placement conflict at ${destination}: ${conflict.manifest.version} vs ${instance.manifest.version}`
        )
      }
      const placement = { ...instance, destination }
      placements.set(destination, placement)
      queue.push(placement)
    }

    const rootConsumer = {
      destination: '.',
      manifest: rootManifest,
      sourceRoot: canonicalRepoRoot,
    }
    for (const name of contract.runtimeRoots) {
      await addDependency(name, rootConsumer, false)
    }
    for (let index = 0; index < queue.length; index += 1) {
      const placement = queue[index]
      for (const name of Object.keys(
        placement.manifest.dependencies ?? {}
      ).sort()) {
        await addDependency(name, placement, false)
      }
      for (const name of Object.keys(
        placement.manifest.optionalDependencies ?? {}
      ).sort()) {
        await addDependency(name, placement, true)
      }
    }

    const sortedPlacements = [...placements.values()].sort((left, right) =>
      left.destination.localeCompare(right.destination)
    )
    const packageRecords = sortedPlacements.map((placement) => ({
      destination: placement.destination,
      name: placement.manifest.name,
      source: normalizeRelativePath(
        path.relative(canonicalRepoRoot, placement.sourceRoot),
        `source for ${placement.manifest.name}`
      ),
      version: placement.manifest.version,
    }))
    for (const placement of sortedPlacements) {
      const destination = path.join(temporaryRoot, placement.destination)
      await copyPath(placement.sourceRoot, destination, canonicalRepoRoot, {
        filter: packageCopyFilter(placement.manifest.name, target),
        skipNodeModules: true,
      })
      await validateStagedNativeModules(
        destination,
        target,
        placement.manifest.name
      )
    }

    await assertServerExternalsResolve(
      temporaryRoot,
      audit.externals.specifiers
    )
    optionalOmissions.sort((left, right) =>
      `${left.name}\0${left.requestedBy}`.localeCompare(
        `${right.name}\0${right.requestedBy}`
      )
    )
    const inventory = await inventoryTree(temporaryRoot)
    const stageManifest = {
      schemaVersion: 1,
      target,
      rootVersion: rootManifest.version,
      externals: audit.externals,
      inputFingerprints,
      packages: packageRecords,
      optionalOmissions,
      inventory,
    }
    await writeFile(
      path.join(temporaryRoot, '.motrix-server-stage.json'),
      stringifySortedJson(stageManifest),
      { mode: 0o644 }
    )
    await replaceStageAtomically(stageRoot, temporaryRoot)
    return { manifest: stageManifest, stageRoot }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true }).catch(() => undefined)
    throw error
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--' && index === 0) continue
    if (option === '--strict') {
      values.set(option, true)
      continue
    }
    if (!['--arch', '--libc', '--platform'].includes(option)) {
      throw new Error(`unknown staging argument: ${option}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for staging argument: ${option}`)
    }
    if (values.has(option))
      throw new Error(`duplicate staging argument: ${option}`)
    values.set(option, value)
    index += 1
  }
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv)
  const result = await stageServerApp({
    platform: args.get('--platform'),
    arch: args.get('--arch'),
    libc: args.get('--libc'),
    strict: args.has('--strict') || Boolean(process.env.CI),
  })
  console.log(
    `Staged ${result.manifest.target.key} Server app at ${result.stageRoot}`
  )
  return result
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
