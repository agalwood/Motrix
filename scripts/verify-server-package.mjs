import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectNativeBinaryTarget } from './native-binary-target.mjs'
import {
  betterSqlite3PrebuildName,
  normalizeRelativePath,
  parseServerTarget,
  resolveServerInput,
  stringifySortedJson,
  validateServerRuntimeContract,
  validateServerSizeBudgets,
} from './server-package-utils.mjs'
import { assertServerExternalsResolve } from './stage-server-app.mjs'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const FORMAT_BY_PLATFORM = {
  darwin: 'mach-o',
  linux: 'elf',
  win32: 'pe',
}
const FORBIDDEN_ROOT_PATHS = [
  '.git',
  '.github',
  '.pnpm-store',
  'dist/main',
  'dist/preload',
  'dist/renderer',
  'docs',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts',
  'src',
]
const EXPECTED_MANIFEST = {
  name: '@motrix/server-runtime',
  private: true,
  type: 'module',
  main: 'dist/server/index.mjs',
  engines: { node: '>=24' },
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function packageRecordFromManifestPath(relativePath) {
  const parts = relativePath.split('/')
  if (parts.at(-1) !== 'package.json') return undefined
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  if (nodeModulesIndex < 0) return undefined
  const firstNamePart = parts[nodeModulesIndex + 1]
  if (!firstNamePart) return undefined
  const manifestIndex = firstNamePart.startsWith('@')
    ? nodeModulesIndex + 3
    : nodeModulesIndex + 2
  if (manifestIndex !== parts.length - 1) return undefined
  const name = firstNamePart.startsWith('@')
    ? `${firstNamePart}/${parts[nodeModulesIndex + 2]}`
    : firstNamePart
  return {
    destination: parts.slice(0, manifestIndex).join('/'),
    name,
  }
}

async function walkStage(stageRoot) {
  const files = []
  const symlinks = []
  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) symlinks.push(relative)
      else if (info.isDirectory()) await walk(absolute, relative)
      else if (info.isFile())
        files.push({ absolute, path: relative, bytes: info.size })
      else throw new Error(`unsupported staged path type: ${relative}`)
    }
  }
  await walk(stageRoot, '')
  return { files, symlinks }
}

function expectedInputFiles(fingerprint) {
  const source = normalizeRelativePath(fingerprint.source, 'fingerprint source')
  const destination = normalizeRelativePath(
    fingerprint.destination,
    'fingerprint destination'
  )
  if (!Array.isArray(fingerprint.files) || fingerprint.files.length === 0) {
    throw new Error(`fingerprint ${source} has no files`)
  }
  return fingerprint.files.map((record) => {
    const sourcePath = normalizeRelativePath(record.path, 'fingerprint file')
    const relative = path.posix.relative(source, sourcePath)
    if (relative === '..' || relative.startsWith('../')) {
      throw new Error(`fingerprint file escapes ${source}: ${sourcePath}`)
    }
    if (
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    ) {
      throw new Error(`fingerprint record is invalid: ${sourcePath}`)
    }
    return {
      path:
        relative.length === 0
          ? destination
          : path.posix.join(destination, relative),
      bytes: record.bytes,
      sha256: record.sha256,
    }
  })
}

function sanitizeReport(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReport(entry, replacements))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeReport(entry, replacements),
      ])
    )
  }
  if (typeof value !== 'string') return value
  let sanitized = value
  for (const [root, label] of replacements) {
    if (root) sanitized = sanitized.replaceAll(root, label)
  }
  return sanitized
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (index === 0 && argument === '--') continue
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`)
    const key = argument.slice(2)
    if (!['app-dir', 'arch', 'libc', 'platform', 'report'].includes(key)) {
      throw new Error(`unknown option: --${key}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }
    options[key] = value
    index += 1
  }
  if (!options['app-dir']) throw new Error('--app-dir is required')
  return options
}

export async function verifyServerPackage(options) {
  const stageRoot = path.resolve(options.appDir)
  const target = parseServerTarget({
    platform: options.platform,
    arch: options.arch,
    libc: options.libc,
    strict: true,
  })
  const reportPath = path.resolve(
    options.reportPath ??
      path.join(
        REPOSITORY_ROOT,
        'release/size-reports',
        `server-${target.key}.json`
      )
  )
  const contract = validateServerRuntimeContract(
    options.contract ??
      JSON.parse(
        await readFile(
          path.join(
            REPOSITORY_ROOT,
            'scripts/server-runtime-dependencies.json'
          ),
          'utf8'
        )
      )
  )
  const budgets = validateServerSizeBudgets(
    options.budgets ??
      JSON.parse(
        await readFile(
          path.join(
            REPOSITORY_ROOT,
            'scripts/server-package-size-budgets.json'
          ),
          'utf8'
        )
      )
  )
  const resolvedResourceInputs = contract.resourceInputs.map((input) =>
    resolveServerInput(input, target)
  )
  const engineBinaryName = target.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const engineInput = resolvedResourceInputs.find(
    (input) => input.destination === `bin/${engineBinaryName}`
  )
  const engineLock = engineInput
    ? (options.engineLock ??
      JSON.parse(
        await readFile(
          path.join(REPOSITORY_ROOT, 'scripts/engine.lock.json'),
          'utf8'
        )
      ))
    : null
  const checks = []
  const errors = []
  let stageManifest
  let appManifest
  let tree = { files: [], symlinks: [] }
  const packageRecords = []
  const nativeBinaries = []
  let engineBinary = null
  let unexpectedRuntimeRoots = contract.runtimeRoots.length
  let unresolvedExternals = 0
  let foreignNativeBinaries = 0
  let betterSqlite3Prebuilds = 0

  async function check(id, operation) {
    try {
      const message = await operation()
      checks.push({ id, passed: true, message: message ?? 'passed' })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({ id, passed: false, message })
      errors.push(`${id}: ${message}`)
      return false
    }
  }

  await check('stage-directory', async () => {
    if (!(await stat(stageRoot)).isDirectory()) {
      throw new Error('staged Server app is not a directory')
    }
    return 'staged Server app directory exists'
  })
  await check('stage-manifest', async () => {
    stageManifest = JSON.parse(
      await readFile(path.join(stageRoot, '.motrix-server-stage.json'), 'utf8')
    )
    if (
      stageManifest?.schemaVersion !== 1 ||
      !Array.isArray(stageManifest.packages) ||
      !Array.isArray(stageManifest.inputFingerprints) ||
      !Array.isArray(stageManifest.externals?.specifiers)
    ) {
      throw new Error('stage manifest does not match schema version 1')
    }
    return 'stage manifest matches schema version 1'
  })
  await check('target', () => {
    if (stageManifest?.target?.key !== target.key) {
      throw new Error(
        `stage target ${stageManifest?.target?.key ?? 'missing'} does not match ${target.key}`
      )
    }
    return `stage target is ${target.key}`
  })
  await check('application-manifest', async () => {
    appManifest = JSON.parse(
      await readFile(path.join(stageRoot, 'package.json'), 'utf8')
    )
    for (const [key, expected] of Object.entries(EXPECTED_MANIFEST)) {
      if (JSON.stringify(appManifest[key]) !== JSON.stringify(expected)) {
        throw new Error(`generated package.json has invalid ${key}`)
      }
    }
    const actualRoots = Object.keys(appManifest.dependencies ?? {}).sort()
    const expectedRoots = [...contract.runtimeRoots].sort()
    const missing = expectedRoots.filter((name) => !actualRoots.includes(name))
    const extra = actualRoots.filter((name) => !expectedRoots.includes(name))
    unexpectedRuntimeRoots = missing.length + extra.length
    if (unexpectedRuntimeRoots > 0) {
      throw new Error(
        `runtime roots differ; missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`
      )
    }
    return `${actualRoots.length} runtime roots match the contract`
  })
  await check('operator-cli', async () => {
    const bundle = await lstat(
      path.join(stageRoot, 'dist/server/motrix-admin.mjs')
    )
    if (!bundle.isFile()) {
      throw new Error('dist/server/motrix-admin.mjs is not a regular file')
    }
    return 'operator CLI bundle is present'
  })
  await check('artifact-tree', async () => {
    tree = await walkStage(stageRoot)
    if (tree.symlinks.length > 0) {
      throw new Error(
        `staged Server app contains symlinks: ${tree.symlinks.join(', ')}`
      )
    }
    return `${tree.files.length} regular files and no symlinks`
  })
  await check('project-license', async () => {
    if (
      typeof appManifest?.license !== 'string' ||
      appManifest.license === ''
    ) {
      throw new Error('generated package.json has no project license')
    }
    const licensePath = path.join(stageRoot, 'LICENSE')
    const info = await lstat(licensePath)
    if (!info.isFile()) {
      throw new Error('LICENSE is not a regular file')
    }
    const text = await readFile(licensePath, 'utf8')
    if (text.trim() === '') {
      throw new Error('LICENSE is empty')
    }
    return `Motrix ${appManifest.license} license is included`
  })
  await check('bundled-engine', async () => {
    if (!engineInput) return 'runtime contract does not bundle an engine'
    const assetKey = `${target.platform}-${target.arch}`
    const asset = engineLock?.assets?.[assetKey]
    if (
      engineLock?.engine !== 'aria2' ||
      typeof engineLock.version !== 'string' ||
      !asset ||
      asset.bin !== engineBinaryName ||
      !/^[a-f0-9]{64}$/.test(asset.binarySha256)
    ) {
      throw new Error(`engine lock has no valid ${assetKey} aria2 asset`)
    }
    const absolute = path.join(stageRoot, ...engineInput.destination.split('/'))
    const info = await lstat(absolute)
    if (!info.isFile()) throw new Error('bundled aria2 is not a regular file')
    if (target.platform !== 'win32' && (info.mode & 0o111) === 0) {
      throw new Error('bundled aria2 is not executable')
    }
    const bytes = await readFile(absolute)
    const digest = sha256(bytes)
    if (digest !== asset.binarySha256) {
      throw new Error(
        `bundled aria2 digest mismatch; expected=${asset.binarySha256} actual=${digest}`
      )
    }
    const detected = detectNativeBinaryTarget(bytes)
    if (
      detected?.format !== FORMAT_BY_PLATFORM[target.platform] ||
      detected.arches.length !== 1 ||
      detected.arches[0] !== target.arch
    ) {
      throw new Error(
        `bundled aria2 does not match ${target.platform}-${target.arch}`
      )
    }
    engineBinary = {
      path: engineInput.destination,
      version: engineLock.version,
      sha256: digest,
      format: detected.format,
      arch: target.arch,
    }
    return `aria2 ${engineLock.version} matches the locked ${assetKey} binary`
  })
  await check('forbidden-payloads', () => {
    const paths = tree.files.map((entry) => entry.path)
    const forbidden = FORBIDDEN_ROOT_PATHS.filter((candidate) =>
      paths.some(
        (entry) => entry === candidate || entry.startsWith(`${candidate}/`)
      )
    )
    const sqliteBuildPayload = paths.filter(
      (entry) =>
        entry.startsWith('node_modules/better-sqlite3/src/') ||
        entry.startsWith('node_modules/better-sqlite3/deps/') ||
        entry.startsWith('node_modules/better-sqlite3/build/') ||
        entry === 'node_modules/better-sqlite3/binding.gyp'
    )
    if (forbidden.length > 0 || sqliteBuildPayload.length > 0) {
      throw new Error(
        `forbidden payloads found: ${[...forbidden, ...sqliteBuildPayload].join(', ')}`
      )
    }
    return 'source, package-manager, Electron, and native build payloads are absent'
  })
  await check('input-fingerprints', async () => {
    if (!stageManifest) throw new Error('stage manifest is unavailable')
    const expected = stageManifest.inputFingerprints
      .flatMap((fingerprint) => expectedInputFiles(fingerprint))
      .sort((left, right) => left.path.localeCompare(right.path))
    const expectedPaths = new Set(expected.map((entry) => entry.path))
    for (const record of expected) {
      const absolute = path.join(stageRoot, ...record.path.split('/'))
      const bytes = await readFile(absolute)
      if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
        throw new Error(`staged input fingerprint mismatch: ${record.path}`)
      }
    }
    for (const fingerprint of stageManifest.inputFingerprints) {
      const destination = normalizeRelativePath(
        fingerprint.destination,
        'fingerprint destination'
      )
      const destinationFiles = tree.files.filter(
        (entry) =>
          entry.path === destination || entry.path.startsWith(`${destination}/`)
      )
      const unexpected = destinationFiles.filter(
        (entry) => !expectedPaths.has(entry.path)
      )
      if (unexpected.length > 0) {
        throw new Error(`unexpected staged input file: ${unexpected[0].path}`)
      }
    }
    return `${expected.length} staged input fingerprints match`
  })
  await check('stage-inventory', () => {
    if (!stageManifest) throw new Error('stage manifest is unavailable')
    const inventoryFiles = tree.files.filter(
      (entry) => entry.path !== '.motrix-server-stage.json'
    )
    const bytes = inventoryFiles.reduce(
      (total, entry) => total + entry.bytes,
      0
    )
    if (
      stageManifest.inventory?.files !== inventoryFiles.length ||
      stageManifest.inventory?.bytes !== bytes
    ) {
      throw new Error('stage inventory does not match artifact contents')
    }
    return `${inventoryFiles.length} files match the stage inventory`
  })
  await check('package-closure', async () => {
    for (const file of tree.files) {
      const record = packageRecordFromManifestPath(file.path)
      if (!record) continue
      const manifest = JSON.parse(await readFile(file.absolute, 'utf8'))
      packageRecords.push({
        destination: record.destination,
        name: record.name,
        version: manifest.version,
      })
    }
    packageRecords.sort((left, right) =>
      left.destination.localeCompare(right.destination)
    )
    const expected = (stageManifest?.packages ?? [])
      .map(({ destination, name, version }) => ({ destination, name, version }))
      .sort((left, right) => left.destination.localeCompare(right.destination))
    if (JSON.stringify(packageRecords) !== JSON.stringify(expected)) {
      throw new Error('staged package closure differs from the stage manifest')
    }
    return `${packageRecords.length} package instances match the closure`
  })
  await check('external-resolution', async () => {
    if (!stageManifest) throw new Error('stage manifest is unavailable')
    try {
      await assertServerExternalsResolve(
        stageRoot,
        stageManifest.externals.specifiers
      )
    } catch (error) {
      unresolvedExternals = 1
      throw error
    }
    return `${stageManifest.externals.specifiers.length} external specifiers resolve`
  })
  await check('native-binaries', async () => {
    const expectedFormat = FORMAT_BY_PLATFORM[target.platform]
    const selectedPrebuild = `node_modules/better-sqlite3/prebuilds/${betterSqlite3PrebuildName(target)}`
    const nativeFiles = tree.files.filter((entry) =>
      entry.path.endsWith('.node')
    )
    betterSqlite3Prebuilds = nativeFiles.filter((entry) =>
      entry.path.startsWith('node_modules/better-sqlite3/prebuilds/')
    ).length
    for (const file of nativeFiles) {
      const detected = detectNativeBinaryTarget(await readFile(file.absolute))
      const matches = Boolean(
        detected &&
          detected.format === expectedFormat &&
          detected.arches.length === 1 &&
          detected.arches[0] === target.arch
      )
      if (!matches) foreignNativeBinaries += 1
      nativeBinaries.push({
        path: file.path,
        format: detected?.format ?? 'unknown',
        arches: detected?.arches ?? [],
        bytes: file.bytes,
        matchesTarget: matches,
      })
    }
    if (
      betterSqlite3Prebuilds !== 1 ||
      !nativeFiles.some((entry) => entry.path === selectedPrebuild) ||
      foreignNativeBinaries > 0
    ) {
      throw new Error(
        `native payload mismatch; selected=${selectedPrebuild} betterSqlite3=${betterSqlite3Prebuilds} foreign=${foreignNativeBinaries}`
      )
    }
    return `${nativeFiles.length} native binaries match ${target.key}`
  })

  const metrics = {
    artifactBytes: tree.files.reduce((total, entry) => total + entry.bytes, 0),
    dependencyBytes: tree.files
      .filter((entry) => entry.path.startsWith('node_modules/'))
      .reduce((total, entry) => total + entry.bytes, 0),
    packageInstances: packageRecords.length,
    unexpectedRuntimeRoots,
    unresolvedExternals,
    foreignNativeBinaries,
    betterSqlite3Prebuilds,
  }
  await check('size-budgets', () => {
    const failures = []
    for (const [key, actual] of Object.entries(metrics)) {
      const expected = budgets[key]
      const passes =
        key === 'betterSqlite3Prebuilds'
          ? actual === expected
          : actual <= expected
      if (!passes) failures.push(`${key}=${actual} budget=${expected}`)
    }
    if (failures.length > 0) {
      throw new Error(
        `Server package size budget exceeded: ${failures.join(', ')}`
      )
    }
    return 'all Server package size budgets pass'
  })

  const report = sanitizeReport(
    {
      schemaVersion: 1,
      target,
      passed: errors.length === 0,
      budgets,
      metrics,
      checks,
      errors,
      packages: packageRecords,
      engineBinary,
      nativeBinaries,
      toolVersions: { node: process.versions.node },
    },
    [
      [stageRoot, '<app-dir>'],
      [REPOSITORY_ROOT, '<repository>'],
      [os.homedir(), '<home>'],
    ]
  )
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, stringifySortedJson(report), { mode: 0o644 })
  if (errors.length > 0) {
    const error = new Error(
      `Server package verification failed:\n${errors.join('\n')}`
    )
    error.report = report
    throw error
  }
  return report
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw = parseArguments(process.argv.slice(2))
  verifyServerPackage({
    appDir: raw['app-dir'],
    platform: raw.platform,
    arch: raw.arch,
    libc: raw.libc,
    reportPath: raw.report,
  })
    .then((report) => {
      console.log(
        `Verified Server ${report.target.key}: ${report.metrics.artifactBytes} bytes, ${report.metrics.packageInstances} packages`
      )
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
