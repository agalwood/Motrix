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
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  normalizeRelativePath,
  packageNameFromSpecifier,
  parseTarget,
  stringifySortedJson,
  validateRuntimeDependencyContract,
} from './electron-package-utils.mjs'
import { assertNativeBinaryTarget } from './native-binary-target.mjs'

const BUILD_OUTPUTS = [
  { directory: 'dist/core/plugin/host', entry: 'quick-js-worker.cjs' },
  { directory: 'dist/main', entry: 'index.cjs' },
  { directory: 'dist/preload', entry: 'preload.cjs' },
  { directory: 'dist/renderer', entry: 'index.html' },
]
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'electron',
])
const GENERATED_MANIFEST_FIELDS = [
  'name',
  'productName',
  'version',
  'description',
  'homepage',
  'author',
  'license',
  'type',
  'main',
  'private',
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

async function assertBuildOutputs(repoRoot) {
  for (const output of BUILD_OUTPUTS) {
    const entry = path.join(repoRoot, output.directory, output.entry)
    const info = await stat(entry).catch(() => null)
    if (!info?.isFile()) {
      throw new Error(`missing Electron build output: ${entry}`)
    }
  }
}

async function fingerprintBuildOutputs(repoRoot) {
  const fingerprints = []
  for (const output of BUILD_OUTPUTS) {
    const relativePath = path.posix.join(output.directory, output.entry)
    const bytes = await readFile(path.join(repoRoot, relativePath))
    fingerprints.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return fingerprints.sort((left, right) => left.path.localeCompare(right.path))
}

function targetList(contract, target) {
  const platform = contract.platforms[target.platform]
  return {
    required: [...contract.common, ...platform.required],
    optional: [...platform.optional],
  }
}

function generatedManifest(rootManifest, contract, target) {
  const manifest = {}
  for (const field of GENERATED_MANIFEST_FIELDS) {
    if (rootManifest[field] !== undefined) manifest[field] = rootManifest[field]
  }

  const roots = targetList(contract, target)
  manifest.dependencies = Object.fromEntries(
    roots.required.map((name) => {
      const version = rootManifest.dependencies?.[name]
      if (typeof version !== 'string') {
        throw new Error(`required runtime root ${name} is not in dependencies`)
      }
      return [name, version]
    })
  )
  if (roots.optional.length > 0) {
    manifest.optionalDependencies = Object.fromEntries(
      roots.optional.map((name) => {
        const version = rootManifest.optionalDependencies?.[name]
        if (typeof version !== 'string') {
          throw new Error(
            `optional runtime root ${name} is not in optionalDependencies`
          )
        }
        return [name, version]
      })
    )
  }
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
      throw new Error(
        `resolved package ${name} escapes repository root: ${sourceRoot}`
      )
    }
    return {
      lexicalRoot: path.dirname(candidate),
      manifest,
      sourceRoot,
    }
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
  const rootCandidate = path.join(repoRoot, 'node_modules', name)
  const canonical = await realpath(rootCandidate).catch(() => null)
  return canonical === sourceRoot
}

async function assertSafeTree(sourceRoot, canonicalRepoRoot, options = {}) {
  const visited = new Set()

  async function walk(directory) {
    const canonical = await realpath(directory)
    if (visited.has(canonical)) return
    visited.add(canonical)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
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

async function normalizeModes(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await chmod(entryPath, 0o755)
      await normalizeModes(entryPath)
    } else {
      const info = await lstat(entryPath)
      if (info.isSymbolicLink()) {
        throw new Error(`staging emitted a symlink: ${entryPath}`)
      }
      await chmod(entryPath, (info.mode & 0o111) === 0 ? 0o644 : 0o755)
    }
  }
}

async function copyTree(source, destination, canonicalRepoRoot, options = {}) {
  await assertSafeTree(source, canonicalRepoRoot, options)
  await mkdir(path.dirname(destination), { recursive: true })
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
  await normalizeModes(destination)
}

function packageCopyFilter(name, target) {
  if (name === 'better-sqlite3') {
    const selected = path.join('prebuilds', `${target.key}.node`)
    return (relative) => {
      if (relative.length === 0) return true
      const portable = relative.replaceAll(path.sep, '/')
      return (
        portable === 'package.json' ||
        /^LICENSE(?:\..*)?$/i.test(portable) ||
        portable === 'lib' ||
        portable.startsWith('lib/') ||
        portable === 'prebuilds' ||
        relative === selected
      )
    }
  }
  if (name === '@resvg/resvg-wasm') {
    return (relative) => relative.replaceAll(path.sep, '/') !== 'index_bg.wasm'
  }
  if (name === 'electron-liquid-glass') {
    return (relative) => {
      const portable = relative.replaceAll(path.sep, '/')
      if (portable === 'prebuilds' || !portable.startsWith('prebuilds/')) {
        return true
      }
      return (
        portable === `prebuilds/${target.key}` ||
        portable.startsWith(`prebuilds/${target.key}/`)
      )
    }
  }
  return undefined
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
  if (packageName === 'better-sqlite3' && nativeModules.length !== 1) {
    throw new Error(
      `better-sqlite3 must stage exactly one ${target.key} prebuild`
    )
  }
}

function readStaticString(source, start) {
  const quote = source[start]
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === quote) return { value, end: index + 1 }
    if (character === '\\') {
      index += 1
      if (index >= source.length) return undefined
      value += source[index]
    } else {
      value += character
    }
  }
  return undefined
}

export function scanStaticExternals(source) {
  const specifiers = new Set()
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') {
      index = source.indexOf('\n', index + 2)
      if (index === -1) break
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      const literal = readStaticString(source, index)
      index = literal?.end ?? source.length
      continue
    }

    const identifier = source.startsWith('require', index)
      ? 'require'
      : source.startsWith('import', index)
        ? 'import'
        : undefined
    if (!identifier) {
      index += 1
      continue
    }
    const before = source[index - 1]
    const after = source[index + identifier.length]
    if (/[\w$]/.test(before ?? '') || /[\w$]/.test(after ?? '')) {
      index += identifier.length
      continue
    }
    let cursor = index + identifier.length
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== '(') {
      index += identifier.length
      continue
    }
    cursor += 1
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== '"' && source[cursor] !== "'") {
      index = cursor
      continue
    }
    const literal = readStaticString(source, cursor)
    if (literal) specifiers.add(literal.value)
    index = literal?.end ?? source.length
  }
  return [...specifiers].sort()
}

async function collectJavaScriptFiles(directory) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (/\.(?:c|m)?js$/.test(entry.name)) files.push(entryPath)
    }
  }
  await walk(directory)
  return files.sort()
}

async function validateStaticExternals(stageRoot) {
  const specifiers = new Set()
  for (const directory of ['dist/main', 'dist/core/plugin/host']) {
    for (const file of await collectJavaScriptFiles(
      path.join(stageRoot, directory)
    )) {
      const source = await readFile(file, 'utf8')
      for (const specifier of scanStaticExternals(source)) {
        if (
          !BUILTIN_MODULES.has(specifier) &&
          packageNameFromSpecifier(specifier)
        ) {
          specifiers.add(specifier)
        }
      }
    }
  }

  const require = createRequire(path.join(stageRoot, 'package.json'))
  for (const specifier of specifiers) {
    try {
      require.resolve(specifier)
    } catch (error) {
      throw new Error(
        `staged application cannot resolve external ${specifier}`,
        { cause: error }
      )
    }
  }
  return [...specifiers].sort()
}

async function inventoryTree(directory) {
  let files = 0
  let bytes = 0
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else {
        const info = await stat(entryPath)
        files += 1
        bytes += info.size
      }
    }
  }
  await walk(directory)
  return { files, bytes }
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

export async function stageElectronApp(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot ?? fileURLToPath(new URL('..', import.meta.url))
  )
  const canonicalRepoRoot = await realpath(repoRoot)
  const target = parseTarget({
    platform: options.platform,
    arch: options.arch,
    strict: options.strict,
    ci: options.ci,
  })
  const contract = validateRuntimeDependencyContract(
    options.contract ??
      (await readJson(
        path.join(repoRoot, 'scripts/electron-runtime-dependencies.json'),
        'runtime dependency contract'
      ))
  )
  if (!contract.supportedTargets.includes(target.key)) {
    throw new Error(`unsupported Electron package target ${target.key}`)
  }

  const requestedStageRoot = path.resolve(
    options.outputDir ?? path.join(repoRoot, 'dist/electron-app')
  )
  const stageRelative = path.relative(repoRoot, requestedStageRoot)
  if (
    stageRelative.length === 0 ||
    stageRelative === '..' ||
    stageRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(stageRelative)
  ) {
    throw new Error(
      `stage output must stay within repository root: ${requestedStageRoot}`
    )
  }
  const stageRoot = path.join(canonicalRepoRoot, stageRelative)
  await assertBuildOutputs(repoRoot)
  const buildOutputs = await fingerprintBuildOutputs(repoRoot)

  const rootManifest = await readJson(
    path.join(repoRoot, 'package.json'),
    'root package manifest'
  )
  const appManifest = generatedManifest(rootManifest, contract, target)
  const temporaryRoot = await mkdtemp(
    path.join(path.dirname(stageRoot), `.${path.basename(stageRoot)}-`)
  )

  try {
    for (const output of BUILD_OUTPUTS) {
      await copyTree(
        path.join(repoRoot, output.directory),
        path.join(temporaryRoot, output.directory),
        canonicalRepoRoot
      )
    }
    await writeFile(
      path.join(temporaryRoot, 'package.json'),
      stringifySortedJson(appManifest)
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

      const lookup = nodeLookupDestinations(consumer.destination, name)
      for (const candidate of lookup) {
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
    const roots = targetList(contract, target)
    for (const name of roots.required) {
      await addDependency(name, rootConsumer, false)
    }
    for (const name of roots.optional) {
      await addDependency(name, rootConsumer, true)
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

    const packageRecords = [...placements.values()]
      .sort((left, right) => left.destination.localeCompare(right.destination))
      .map((placement) => ({
        destination: placement.destination,
        name: placement.manifest.name,
        source: normalizeRelativePath(
          path.relative(canonicalRepoRoot, placement.sourceRoot),
          `source for ${placement.manifest.name}`
        ),
        version: placement.manifest.version,
      }))

    for (const placement of [...placements.values()].sort((left, right) =>
      left.destination.localeCompare(right.destination)
    )) {
      const packageFilter = packageCopyFilter(placement.manifest.name, target)
      await copyTree(
        placement.sourceRoot,
        path.join(temporaryRoot, placement.destination),
        canonicalRepoRoot,
        { filter: packageFilter, skipNodeModules: true }
      )
      await validateStagedNativeModules(
        path.join(temporaryRoot, placement.destination),
        target,
        placement.manifest.name
      )
    }

    const externals = await validateStaticExternals(temporaryRoot)
    optionalOmissions.sort((left, right) =>
      `${left.name}\0${left.requestedBy}`.localeCompare(
        `${right.name}\0${right.requestedBy}`
      )
    )
    const inventory = await inventoryTree(temporaryRoot)
    const resvgPlacement = [...placements.values()].find(
      (placement) => placement.manifest.name === '@resvg/resvg-wasm'
    )
    let resvgWasmSha256
    if (resvgPlacement) {
      const resourcePath = path.join(repoRoot, 'extra/tray/resvg.wasm')
      const resource = await readFile(resourcePath).catch((error) => {
        throw new Error(`missing macOS resvg resource: ${resourcePath}`, {
          cause: error,
        })
      })
      resvgWasmSha256 = createHash('sha256').update(resource).digest('hex')
    }
    const stageManifest = {
      schemaVersion: 1,
      target,
      rootVersion: rootManifest.version,
      buildOutputs,
      externals,
      packages: packageRecords,
      optionalOmissions,
      inventory,
      ...(resvgWasmSha256 ? { resvgWasmSha256 } : {}),
    }
    await writeFile(
      path.join(temporaryRoot, '.motrix-package-stage.json'),
      stringifySortedJson(stageManifest)
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
    if (!['--platform', '--arch'].includes(option)) {
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
  const result = await stageElectronApp({
    platform: args.get('--platform'),
    arch: args.get('--arch'),
    strict: args.has('--strict') || Boolean(process.env.CI),
  })
  console.log(
    `Staged ${result.manifest.target.key} Electron app at ${result.stageRoot}`
  )
  return result
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
