import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage, statFile } from '@electron/asar'
import {
  bytesToMiB,
  packageNameFromSpecifier,
  parseTarget,
  sanitizeMachinePaths,
  stringifySortedJson,
  validateSizeBudgetContract,
} from './electron-package-utils.mjs'
import { detectNativeBinaryTarget } from './native-binary-target.mjs'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const DEFAULT_BUDGETS_PATH = path.join(
  REPOSITORY_ROOT,
  'scripts/electron-package-size-budgets.json'
)
const EXPECTED_OUTPUTS = [
  'dist/core/plugin/host/quick-js-worker.cjs',
  'dist/main/index.cjs',
  'dist/preload/preload.cjs',
  'dist/renderer/index.html',
]
const FORBIDDEN_OUTPUTS = [
  'dist/builtin-moext',
  'dist/builtin-plugins',
  'dist/renderer-web',
  'dist/server',
]
const LEGAL_RESOURCES = [
  'THIRD_PARTY_LICENSES/aria2-COPYING',
  'THIRD_PARTY_LICENSES/aria2-LICENSE.OpenSSL',
  'THIRD_PARTY_NOTICES.md',
  'THIRD_PARTY_NOTICES.zh-CN.md',
  'legal/THIRD_PARTY_DEPENDENCIES.md',
  'legal/THIRD_PARTY_LICENSES.txt',
  'legal/sbom.spdx.json',
]
const FORMAT_BY_PLATFORM = {
  darwin: 'mach-o',
  linux: 'elf',
  win32: 'pe',
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function portable(value) {
  return value.split(path.sep).join('/')
}

export function normalizeArchiveEntry(value) {
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\/+/, '')
}

function archiveLookupPath(value) {
  return value.split('/').join(path.sep)
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

async function pathInfo(filePath) {
  return lstat(filePath).catch(() => null)
}

async function walkFiles(root) {
  const result = []
  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => []
    )
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(absolute, nextRelative)
      else if (entry.isFile()) {
        const info = await stat(absolute)
        result.push({ absolute, path: nextRelative, bytes: info.size })
      }
    }
  }
  await visit(root, '')
  return result
}

function resourcesDirectory(appDir, platform) {
  return platform === 'darwin'
    ? path.join(appDir, 'Contents/Resources')
    : path.join(appDir, 'resources')
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

function chooseExportTarget(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const selected = chooseExportTarget(entry)
      if (selected) return selected
    }
    return undefined
  }
  if (value && typeof value === 'object') {
    for (const condition of ['node', 'require', 'import', 'default']) {
      const selected = chooseExportTarget(value[condition])
      if (selected) return selected
    }
  }
  return undefined
}

function pathExistsInArchive(paths, candidate) {
  const normalized = path.posix
    .normalize(candidate.replace(/^\.\//, ''))
    .replace(/\/$/, '')
  const candidates = [
    normalized,
    `${normalized}.js`,
    `${normalized}.cjs`,
    `${normalized}.mjs`,
    `${normalized}.json`,
    `${normalized}/index.js`,
    `${normalized}/index.cjs`,
    `${normalized}/index.mjs`,
    `${normalized}/index.json`,
  ]
  return candidates.some((entry) => paths.has(entry))
}

function resolveExternal(external, packages, archivePaths) {
  const packageName = packageNameFromSpecifier(external)
  if (!packageName) return false
  const packageRecord = packages.find(
    (entry) =>
      entry.name === packageName &&
      entry.destination === `node_modules/${packageName}`
  )
  if (!packageRecord) return false
  const subpath = external.slice(packageName.length).replace(/^\//, '')
  const exportKey = subpath ? `./${subpath}` : '.'
  const packageExports = packageRecord.manifest.exports
  const selectedExport =
    typeof packageExports === 'string' || Array.isArray(packageExports)
      ? packageExports
      : packageExports &&
          Object.keys(packageExports).some((key) => key.startsWith('.'))
        ? packageExports[exportKey]
        : packageExports
  const exportTarget = chooseExportTarget(selectedExport)
  const target =
    exportTarget ?? subpath ?? packageRecord.manifest.main ?? 'index.js'
  return pathExistsInArchive(
    archivePaths,
    `${packageRecord.destination}/${target}`
  )
}

async function archiveFileBytes(asarPath, relativePath) {
  return extractFile(asarPath, archiveLookupPath(relativePath))
}

async function archiveLogicalBytes(asarPath, relativePath) {
  const info = await statFile(asarPath, archiveLookupPath(relativePath))
  return info.size ?? 0
}

async function archiveFileInfo(asarPath, relativePath) {
  return statFile(asarPath, archiveLookupPath(relativePath))
}

function nativeTargetMatches(detected, platform, arch, allowUniversal = false) {
  return Boolean(
    detected &&
      detected.format === FORMAT_BY_PLATFORM[platform] &&
      detected.arches.includes(arch) &&
      (allowUniversal || detected.arches.length === 1)
  )
}

async function readToolVersions() {
  async function packageVersion(relativePath) {
    return JSON.parse(
      await readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8')
    ).version
  }
  return {
    asar: await packageVersion(
      'node_modules/@electron/asar/package.json'
    ).catch(() => 'unknown'),
    electronBuilder: await packageVersion(
      'node_modules/electron-builder/package.json'
    ).catch(() => 'unknown'),
    node: process.versions.node,
  }
}

function sanitizeReport(value, roots) {
  if (Array.isArray(value))
    return value.map((entry) => sanitizeReport(entry, roots))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeReport(entry, roots),
      ])
    )
  }
  return typeof value === 'string' ? sanitizeMachinePaths(value, roots) : value
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (index === 0 && argument === '--') continue
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`)
    const key = argument.slice(2)
    if (!['app-dir', 'arch', 'platform', 'report'].includes(key)) {
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

export async function verifyElectronPackage(options) {
  const appDir = path.resolve(options.appDir)
  const target = parseTarget({
    platform: options.platform,
    arch: options.arch,
    strict: true,
  })
  const reportPath = path.resolve(
    options.reportPath ??
      path.join(REPOSITORY_ROOT, 'release/size-reports', `${target.key}.json`)
  )
  const rawBudgets =
    options.budgets ?? JSON.parse(await readFile(DEFAULT_BUDGETS_PATH, 'utf8'))
  const budgets = validateSizeBudgetContract(rawBudgets)
  const resources = resourcesDirectory(appDir, target.platform)
  const asarPath = path.join(resources, 'app.asar')
  const unpackedPath = `${asarPath}.unpacked`
  const checks = []
  const errors = []
  const archivePaths = new Set()
  let archiveEntries = []
  let stage
  let packagedManifest
  const packages = []
  const nativeBinaries = []
  let appFiles = []
  let unpackedFiles = []
  let asarBytes = 0
  let betterSqlite3Bytes = 0
  let foreignBetterSqlite3Prebuilds = 0
  let duplicateResvgWasmFiles = 0
  let unexpectedPackageNames = []
  const externalResources = {
    aria2: [],
    builtins: [],
    legal: [],
    nativeHost: [],
    resvg: [],
    updateMetadata: [],
  }

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

  await check('application-directory', async () => {
    const info = await pathInfo(appDir)
    if (!info?.isDirectory())
      throw new Error('application directory is missing')
    appFiles = await walkFiles(appDir)
    return `${appFiles.length} physical files`
  })

  await check('asar-inventory', async () => {
    const info = await pathInfo(asarPath)
    if (!info?.isFile()) throw new Error('resources/app.asar is missing')
    asarBytes = info.size
    archiveEntries = await listPackage(asarPath)
    for (const entry of archiveEntries)
      archivePaths.add(normalizeArchiveEntry(entry))
    unpackedFiles = await walkFiles(unpackedPath)
    return `${archiveEntries.length} archive entries`
  })

  await check('stage-manifest', async () => {
    stage = JSON.parse(
      (
        await archiveFileBytes(asarPath, '.motrix-package-stage.json')
      ).toString()
    )
    packagedManifest = JSON.parse(
      (await archiveFileBytes(asarPath, 'package.json')).toString()
    )
    if (
      stage.schemaVersion !== 1 ||
      stage.target?.platform !== target.platform ||
      stage.target?.arch !== target.arch ||
      stage.target?.key !== target.key
    ) {
      throw new Error(`packaged stage does not match ${target.key}`)
    }
    if (stage.rootVersion !== packagedManifest.version) {
      throw new Error('packaged stage and package version differ')
    }
    if (!Array.isArray(stage.packages) || !Array.isArray(stage.externals)) {
      throw new Error('packaged stage inventory is invalid')
    }
    return `${stage.packages.length} staged packages`
  })

  await check('required-build-outputs', async () => {
    if (!stage) throw new Error('stage manifest is unavailable')
    const actualOutputs = (stage.buildOutputs ?? [])
      .map((entry) => entry.path)
      .sort()
    if (JSON.stringify(actualOutputs) !== JSON.stringify(EXPECTED_OUTPUTS)) {
      throw new Error(
        'stage must contain the exact four Electron build outputs'
      )
    }
    for (const output of stage.buildOutputs) {
      if (!archivePaths.has(output.path))
        throw new Error(`missing ${output.path}`)
      const bytes = await archiveFileBytes(asarPath, output.path)
      if (bytes.length !== output.bytes || sha256(bytes) !== output.sha256) {
        throw new Error(`packaged output does not match stage: ${output.path}`)
      }
    }
    return EXPECTED_OUTPUTS.join(', ')
  })

  await check('forbidden-dist-outputs', async () => {
    const leaked = FORBIDDEN_OUTPUTS.filter((prefix) =>
      [...archivePaths].some(
        (entry) => entry === prefix || entry.startsWith(`${prefix}/`)
      )
    )
    if (leaked.length > 0)
      throw new Error(`forbidden outputs: ${leaked.join(', ')}`)
    return 'no server, web, or builtin mirror output'
  })

  await check('package-inventory', async () => {
    if (!stage) throw new Error('stage manifest is unavailable')
    for (const relativePath of [...archivePaths].sort()) {
      const record = packageRecordFromManifestPath(relativePath)
      if (!record) continue
      const manifest = JSON.parse(
        (await archiveFileBytes(asarPath, relativePath)).toString()
      )
      packages.push({ ...record, version: manifest.version, manifest })
    }
    packages.sort((left, right) =>
      left.destination.localeCompare(right.destination)
    )
    const expected = stage.packages
      .map(({ destination, name, version }) => ({ destination, name, version }))
      .sort((left, right) => left.destination.localeCompare(right.destination))
    const actual = packages.map(({ destination, name, version }) => ({
      destination,
      name,
      version,
    }))
    unexpectedPackageNames = uniqueSorted(
      actual
        .filter(
          (entry) =>
            !expected.some((candidate) => candidate.name === entry.name)
        )
        .map((entry) => entry.name)
    )
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        'packaged package names, versions, or placements differ from stage'
      )
    }
    return `${actual.length} exact package placements`
  })

  await check('static-externals', async () => {
    if (!stage) throw new Error('stage manifest is unavailable')
    const unresolved = stage.externals.filter(
      (external) => !resolveExternal(external, packages, archivePaths)
    )
    if (unresolved.length > 0) {
      throw new Error(`unresolved externals: ${unresolved.sort().join(', ')}`)
    }
    return `${stage.externals.length} externals resolved`
  })

  await check('native-binaries', async () => {
    const nativePaths = [...archivePaths]
      .filter((entry) => entry.endsWith('.node'))
      .sort()
    for (const relativePath of nativePaths) {
      const detected = detectNativeBinaryTarget(
        await archiveFileBytes(asarPath, relativePath)
      )
      nativeBinaries.push({ path: relativePath, ...detected })
      if (!nativeTargetMatches(detected, target.platform, target.arch)) {
        throw new Error(`invalid native binary target: ${relativePath}`)
      }
    }
    return `${nativePaths.length} native modules`
  })

  await check('better-sqlite3-layout', async () => {
    const sqlitePackages = packages.filter(
      (entry) => entry.name === 'better-sqlite3'
    )
    if (sqlitePackages.length !== 1) {
      throw new Error('better-sqlite3 must have exactly one package placement')
    }
    const root = sqlitePackages[0].destination
    const files = []
    for (const entry of [...archivePaths]
      .filter((candidate) => candidate.startsWith(`${root}/`))
      .sort()) {
      const entryInfo = await archiveFileInfo(asarPath, entry)
      if (!entryInfo.files) files.push(entry)
    }
    const leaked = files.filter(
      (entry) =>
        entry === `${root}/binding.gyp` ||
        entry.startsWith(`${root}/deps/`) ||
        entry.startsWith(`${root}/src/`)
    )
    if (leaked.length > 0)
      throw new Error(`SQLite sources leaked: ${leaked.join(', ')}`)
    const prebuilds = files.filter(
      (entry) =>
        entry.startsWith(`${root}/prebuilds/`) && entry.endsWith('.node')
    )
    const expectedPrebuild = `${root}/prebuilds/${target.key}.node`
    foreignBetterSqlite3Prebuilds = prebuilds.filter(
      (entry) => entry !== expectedPrebuild
    ).length
    if (prebuilds.length !== 1 || prebuilds[0] !== expectedPrebuild) {
      throw new Error(`expected only ${expectedPrebuild}`)
    }
    const detected = detectNativeBinaryTarget(
      await archiveFileBytes(asarPath, expectedPrebuild)
    )
    if (!nativeTargetMatches(detected, target.platform, target.arch)) {
      foreignBetterSqlite3Prebuilds += 1
      throw new Error('better-sqlite3 prebuild has an invalid native header')
    }
    for (const relativePath of files) {
      betterSqlite3Bytes += await archiveLogicalBytes(asarPath, relativePath)
    }
    return `${prebuilds[0]} (${betterSqlite3Bytes} bytes)`
  })

  await check('resvg-wasm-placement', async () => {
    const packageCopies = [...archivePaths].filter(
      (entry) =>
        entry.endsWith('node_modules/@resvg/resvg-wasm/index_bg.wasm') ||
        entry === 'node_modules/@resvg/resvg-wasm/index_bg.wasm'
    )
    duplicateResvgWasmFiles = packageCopies.length
    if (packageCopies.length > 0) {
      throw new Error(
        `package resvg WASM leaked: ${packageCopies.sort().join(', ')}`
      )
    }
    const resourcePath = path.join(resources, 'extra/tray/resvg.wasm')
    const resourceInfo = await pathInfo(resourcePath)
    if (target.platform !== 'darwin') {
      if (resourceInfo) throw new Error('resvg WASM resource is macOS-only')
      return 'non-macOS target has no resvg WASM resource'
    }
    if (!resourceInfo?.isFile())
      throw new Error('macOS resvg WASM resource is missing')
    const bytes = await readFile(resourcePath)
    const digest = sha256(bytes)
    externalResources.resvg.push({
      path: 'extra/tray/resvg.wasm',
      bytes: bytes.length,
      sha256: digest,
    })
    if (!stage?.resvgWasmSha256 || digest !== stage.resvgWasmSha256) {
      throw new Error('macOS resvg WASM hash does not match stage')
    }
    return 'single external resvg WASM matches stage'
  })

  await check('external-resources', async () => {
    const hostName =
      target.platform === 'win32'
        ? 'motrix-native-host.exe'
        : 'motrix-native-host'
    const engineName = target.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
    const required = [
      {
        category: 'aria2',
        path: `extra/${target.platform}/${target.arch}/${engineName}`,
        executable: true,
      },
      { category: 'nativeHost', path: `bin/${hostName}`, executable: true },
      ...LEGAL_RESOURCES.map((relativePath) => ({
        category: 'legal',
        path: relativePath,
        executable: false,
      })),
    ]
    for (const resource of required) {
      const absolute = path.join(resources, resource.path)
      const info = await pathInfo(absolute)
      if (!info?.isFile() || info.size === 0) {
        throw new Error(`required resource is missing: ${resource.path}`)
      }
      if (resource.executable) {
        const detected = detectNativeBinaryTarget(await readFile(absolute))
        if (
          !nativeTargetMatches(
            detected,
            target.platform,
            target.arch,
            target.platform === 'darwin'
          )
        ) {
          throw new Error(`resource has invalid target: ${resource.path}`)
        }
        if (target.platform !== 'win32') {
          await access(absolute, constants.X_OK).catch(() => {
            throw new Error(`resource is not executable: ${resource.path}`)
          })
        }
      }
      externalResources[resource.category].push({
        path: resource.path,
        bytes: info.size,
      })
    }
    for (const forbidden of [
      'motrix-flatpak-native-host',
      'motrix-flatpak-native-host.exe',
      'motrix-native-host-broker',
      'motrix-native-host-broker.exe',
    ]) {
      if (await pathInfo(path.join(resources, 'bin', forbidden))) {
        throw new Error(`Flatpak-only native host leaked: bin/${forbidden}`)
      }
    }
    return `${required.length} required resource files`
  })

  await check('builtin-plugins', async () => {
    const root = path.join(resources, 'builtin-plugins')
    const files = await walkFiles(root)
    const manifests = files
      .filter((entry) => entry.path.endsWith('/motrix-plugin.json'))
      .map((entry) => entry.path)
      .sort()
    if (manifests.length === 0)
      throw new Error('builtin plugin manifests are missing')
    for (const manifest of manifests) {
      const pluginRoot = path.posix.dirname(manifest)
      if (
        !files.some((entry) => entry.path === `${pluginRoot}/dist/plugin.js`)
      ) {
        throw new Error(`builtin plugin payload is missing: ${pluginRoot}`)
      }
    }
    externalResources.builtins = files.map(({ path: relativePath, bytes }) => ({
      path: `builtin-plugins/${portable(relativePath)}`,
      bytes,
    }))
    return `${manifests.length} builtin plugins`
  })

  await check('update-metadata-policy', async () => {
    const relativePath = 'app-update.yml'
    const info = await pathInfo(path.join(resources, relativePath))
    if (info && (!info.isFile() || info.size === 0)) {
      throw new Error('app-update.yml exists but is not a non-empty file')
    }
    externalResources.updateMetadata = info
      ? [{ path: relativePath, bytes: info.size, policy: 'distributable' }]
      : [{ path: relativePath, present: false, policy: 'directory-output' }]
    return info
      ? 'distributable update metadata is present'
      : 'directory output intentionally has no update metadata'
  })

  const unpackedBytes = unpackedFiles.reduce(
    (sum, entry) => sum + entry.bytes,
    0
  )
  const payloadBytes = asarBytes + unpackedBytes
  const appBytes = appFiles.reduce((sum, entry) => sum + entry.bytes, 0)
  const localeFiles = appFiles.filter((entry) =>
    target.platform === 'darwin'
      ? entry.path.includes('.lproj/')
      : entry.path.startsWith('locales/')
  )
  const localeRoots = uniqueSorted(
    localeFiles.map((entry) => {
      const lproj = entry.path.match(/(^|\/)([^/]+\.lproj)\//)
      if (lproj) return lproj[2]
      const locale = entry.path.match(/(^|\/)locales\/([^/]+)/)
      return locale?.[2] ?? entry.path
    })
  )
  const metrics = {
    betterSqlite3Bytes,
    duplicateResvgWasmFiles,
    foreignBetterSqlite3Prebuilds,
    payloadBytes,
    unexpectedPackageNames: unexpectedPackageNames.length,
  }

  for (const [metric, value] of Object.entries(metrics)) {
    await check(`budget-${metric}`, async () => {
      const budget = budgets[metric]
      if (value > budget)
        throw new Error(`${metric} ${value} exceeds budget ${budget}`)
      return `${value} <= ${budget}`
    })
  }

  const report = sanitizeReport(
    {
      schemaVersion: 1,
      target,
      passed: checks.every((entry) => entry.passed),
      tools: await readToolVersions(),
      inputStage: stage
        ? {
            schemaVersion: stage.schemaVersion,
            target: stage.target,
            rootVersion: stage.rootVersion,
            inventory: stage.inventory,
            packages: stage.packages.map(({ destination, name, version }) => ({
              destination,
              name,
              version,
            })),
            externals: [...stage.externals].sort(),
            optionalOmissions: [...(stage.optionalOmissions ?? [])].sort(),
          }
        : null,
      sizes: {
        appBytes,
        appMiB: bytesToMiB(appBytes),
        asarBytes,
        asarMiB: bytesToMiB(asarBytes),
        unpackedBytes,
        unpackedMiB: bytesToMiB(unpackedBytes),
        payloadBytes,
        payloadMiB: bytesToMiB(payloadBytes),
        localeBytes: localeFiles.reduce((sum, entry) => sum + entry.bytes, 0),
        localeRoots,
      },
      packages: {
        count: packages.length,
        names: uniqueSorted(packages.map((entry) => entry.name)),
        records: packages.map(({ destination, name, version }) => ({
          destination,
          name,
          version,
        })),
        betterSqlite3Bytes,
        unexpectedNames: unexpectedPackageNames,
      },
      nativeBinaries,
      externalResources,
      budgets,
      metrics,
      checks,
      errors,
    },
    [appDir, path.dirname(appDir), os.homedir(), REPOSITORY_ROOT]
  )
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, stringifySortedJson(report))
  return report
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const target = parseTarget({
    platform: args.platform,
    arch: args.arch,
    strict: true,
  })
  const report = await verifyElectronPackage({
    appDir: args['app-dir'],
    platform: target.platform,
    arch: target.arch,
    reportPath: args.report,
  })
  const prefix = report.passed ? 'passed' : 'failed'
  console.log(
    `[verify-electron-package] ${prefix} ${target.key}: ${report.sizes.payloadBytes} bytes`
  )
  if (!report.passed) {
    for (const error of report.errors) {
      console.error(`[verify-electron-package] ${error}`)
    }
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`[verify-electron-package] ${error.message}`)
    process.exitCode = 1
  })
}
