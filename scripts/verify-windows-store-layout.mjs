import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifyWindowsStorePayload } from './verify-windows-store-payload.mjs'
import {
  loadPreparedWindowsStoreDiagnostic,
  WINDOWS_STORE_DIAGNOSTIC_BUILD_REPORT,
} from './windows-store-diagnostics.mjs'
import {
  renderWindowsStoreManifest,
  renderWindowsStorePriConfig,
  WINDOWS_STORE_SCALE_200_ASSETS,
} from './windows-store-manifest.mjs'
import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'

const PREPARATION_FILES = [
  'priconfig.xml',
  'release-metadata.json',
  'payload-report.json',
  'source-report.json',
  'TEST-ONLY.txt',
  'layout-report.json',
]
// MakeAppx unpack extracts the block map, but not the ZIP content-types part.
const UNPACKED_FILES = ['AppxBlockMap.xml']
const OPTIONAL_CATALOG = 'AppxMetadata/CodeIntegrity.cat'
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function directory(value, label) {
  if (typeof value !== 'string' || !value)
    throw new Error(`${label} must be an explicit directory`)
  const absolute = path.resolve(value)
  const prefix = path.parse(absolute).root
  let current = prefix
  for (const segment of absolute
    .slice(prefix.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        `${label} and its ancestors must be directories without symlinks`
      )
  }
  return realpath(absolute)
}

async function scanTree(root) {
  const files = new Map()
  const directories = new Set()
  async function visit(relative) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const entry = relative ? `${relative}/${name}` : name
      const info = await lstat(path.join(root, entry))
      if (info.isSymbolicLink())
        throw new Error(`Symlink is forbidden: ${entry}`)
      if (info.isDirectory()) {
        directories.add(entry)
        await visit(entry)
      } else if (info.isFile()) files.set(entry, info.size)
      else throw new Error(`Non-regular entry is forbidden: ${entry}`)
    }
  }
  await visit('')
  return { files, directories }
}

function assertTree(tree, expected, label) {
  const files = new Set(expected)
  const directories = new Set()
  for (const file of files) {
    let parent = path.posix.dirname(file)
    while (parent !== '.') {
      directories.add(parent)
      parent = path.posix.dirname(parent)
    }
  }
  if (
    !isDeepStrictEqual(new Set(tree.files.keys()), files) ||
    !isDeepStrictEqual(tree.directories, directories)
  ) {
    throw new Error(`${label} has missing or extra files or directories`)
  }
}

async function withFile(root, relative, operation) {
  const file = path.join(root, relative)
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`Expected a regular file: ${relative}`)
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const actual = await handle.stat()
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino
    )
      throw new Error(`File changed during verification: ${relative}`)
    const result = await operation(handle, actual)
    const after = await handle.stat()
    if (actual.size !== after.size || actual.mtimeMs !== after.mtimeMs)
      throw new Error(`File changed during verification: ${relative}`)
    return result
  } finally {
    await handle.close()
  }
}

function read(root, relative) {
  return withFile(root, relative, async (handle, info) => {
    if (info.size > 32 * 1024 * 1024)
      throw new Error(`Layout metadata or asset is too large: ${relative}`)
    return handle.readFile()
  })
}

function fingerprint(root, relative) {
  return withFile(root, relative, async (handle, info) => {
    if (info.size === 0)
      throw new Error(`Required generated file is empty: ${relative}`)
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk)
    return { path: relative, bytes: info.size, sha256: hash.digest('hex') }
  })
}

async function requireBytes(root, relative, expected) {
  const bytes = await read(root, relative)
  if (!bytes.equals(Buffer.from(expected)))
    throw new Error(`Content differs from the rendered contract: ${relative}`)
}

async function assetInventory(prepared, layout) {
  const inventory = []
  for (const asset of WINDOWS_STORE_SCALE_200_ASSETS) {
    const bytes = await read(layout, asset.destination)
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== asset.width ||
      bytes.readUInt32BE(20) !== asset.height
    ) {
      throw new Error(`Invalid scale-200 asset: ${asset.destination}`)
    }
    const priBytes = await read(prepared, `pri-root/${asset.destination}`)
    if (!bytes.equals(priBytes))
      throw new Error(`Layout and PRI-root assets differ: ${asset.destination}`)
    inventory.push({
      path: asset.destination,
      bytes: bytes.length,
      sha256: digest(bytes),
    })
  }
  return inventory
}

/**
 * Recheck immutable on-disk layout contents without trusting old verifier results.
 * Generated SDK files are allowlisted and hashed, not parsed or authenticated.
 * The payload verifier uses and removes its own private temporary report.
 */
export async function verifyWindowsStoreLayout({
  preparedDirectory,
  layoutDirectory,
  phase,
} = {}) {
  const report = {
    schemaVersion: 1,
    scope: 'windows-test-layout-content-only',
    phase,
    ok: false,
    checks: [],
    generatedFiles: [],
    payloadSourceVerified: false,
    sourceCommitVerified: false,
    windowsSdkExecutionVerified: false,
    generatedFileFormatsVerified: false,
    signatureVerified: false,
    windowsRuntimeVerified: false,
    storeSubmissionReady: false,
  }
  async function check(name, operation) {
    try {
      await operation()
      report.checks.push({ name, ok: true })
      return true
    } catch (error) {
      report.checks.push({
        name,
        ok: false,
        message: error.code
          ? `Layout IO failed (${error.code})`
          : error.message,
      })
      return false
    }
  }

  let prepared
  let baseline
  let layout
  let preparedTree
  let targetTree
  if (
    !(await check('safe-inputs', async () => {
      if (!['prepared', 'indexed', 'unpacked'].includes(phase))
        throw new Error('phase must be prepared, indexed, or unpacked')
      prepared = await directory(preparedDirectory, 'preparedDirectory')
      baseline = await directory(
        path.join(prepared, 'layout'),
        'prepared layout'
      )
      layout =
        layoutDirectory === undefined
          ? baseline
          : await directory(layoutDirectory, 'layoutDirectory')
      if (phase === 'unpacked') {
        if (layoutDirectory === undefined || layout === baseline)
          throw new Error(
            'unpacked requires a distinct explicit layoutDirectory'
          )
      } else if (layout !== baseline)
        throw new Error(
          'prepared and indexed must use preparedDirectory/layout'
        )
      preparedTree = await scanTree(prepared)
      targetTree = phase === 'unpacked' ? await scanTree(layout) : null
    }))
  )
    return report

  let metadata
  let completion
  let manifest
  let priConfig
  let assets
  let diagnostic
  if (
    !(await check('metadata-and-static-content', async () => {
      const raw = JSON.parse(
        (await read(prepared, 'release-metadata.json')).toString('utf8')
      )
      metadata = validateWindowsStoreMetadata(raw).metadata
      if (metadata.profile !== 'test')
        throw new Error('Only test-profile layouts are supported')
      completion = JSON.parse(
        (await read(prepared, 'layout-report.json')).toString('utf8')
      )
      manifest = renderWindowsStoreManifest(metadata)
      priConfig = renderWindowsStorePriConfig(metadata)
      await requireBytes(baseline, 'AppxManifest.xml', manifest)
      await requireBytes(prepared, 'priconfig.xml', priConfig)
      assets = await assetInventory(prepared, baseline)
      if (metadata.testDiagnostics !== undefined) {
        diagnostic = await loadPreparedWindowsStoreDiagnostic({
          preparedDirectory: prepared,
          layoutDirectory: baseline,
          metadata,
        })
        report.testDiagnostics = metadata.testDiagnostics
        report.diagnostics = diagnostic
      }
      report.versions = {
        productVersion: metadata.productVersion,
        packageVersion: metadata.packageVersion,
      }
    }))
  )
    return report

  let payload
  if (
    !(await check('prepared-payload', async () => {
      payload = await verifyWindowsStorePayload({
        appDir: path.join(baseline, 'app'),
        metadata,
      })
      if (!payload.ok)
        throw new Error('Prepared payload failed a fresh verification')
    }))
  )
    return report

  if (
    !(await check('completion-record', () => {
      const expected = {
        schemaVersion: 1,
        scope: 'windows-test-layout',
        profile: 'test',
        identity: metadata.identity,
        productVersion: metadata.productVersion,
        packageVersion: metadata.packageVersion,
        sourceCommit: metadata.source.commit,
        manifestSha256: digest(manifest),
        priConfigSha256: digest(priConfig),
        assets,
        payload: payload.inventory.physicalFiles,
        ...(diagnostic ? { diagnostics: diagnostic } : {}),
        copiedPayloadMatched: true,
        payloadSourceVerified: false,
        windowsSdkExecuted: false,
        windowsRuntimeVerified: false,
        storeSubmissionReady: false,
      }
      if (!isDeepStrictEqual(completion, expected))
        throw new Error(
          'Completion record does not match the metadata and actual layout contents'
        )
    }))
  )
    return report

  const staticFiles = [
    'AppxManifest.xml',
    ...assets.map((asset) => asset.path),
    ...payload.inventory.physicalFiles.map((file) => `app/${file.path}`),
    ...(diagnostic ? [diagnostic.executable.path] : []),
  ]
  const indexedFiles = phase === 'prepared' ? [] : ['resources.pri']
  if (
    !(await check('prepared-tree', () => {
      assertTree(
        preparedTree,
        [
          ...PREPARATION_FILES,
          ...(diagnostic ? [WINDOWS_STORE_DIAGNOSTIC_BUILD_REPORT] : []),
          ...assets.map((asset) => `pri-root/${asset.path}`),
          ...staticFiles.concat(indexedFiles).map((file) => `layout/${file}`),
        ],
        'Prepared directory'
      )
    }))
  )
    return report

  let pri
  if (
    phase !== 'prepared' &&
    !(await check('indexed-pri', async () => {
      pri = await fingerprint(baseline, 'resources.pri')
      report.generatedFiles.push(pri)
    }))
  )
    return report

  if (phase === 'unpacked') {
    if (
      !(await check('unpacked-tree', async () => {
        const generated = [...UNPACKED_FILES]
        if (targetTree.files.has(OPTIONAL_CATALOG))
          generated.push(OPTIONAL_CATALOG)
        assertTree(
          targetTree,
          [...staticFiles, 'resources.pri', ...generated],
          'Unpacked layout'
        )
        const unpackedPri = await fingerprint(layout, 'resources.pri')
        if (!isDeepStrictEqual(unpackedPri, pri))
          throw new Error(
            'Unpacked resources.pri differs from the prepared index'
          )
        for (const file of generated)
          report.generatedFiles.push(await fingerprint(layout, file))
        await requireBytes(layout, 'AppxManifest.xml', manifest)
        if (!isDeepStrictEqual(await assetInventory(prepared, layout), assets))
          throw new Error('Unpacked assets differ from prepared assets')
        if (
          diagnostic &&
          !isDeepStrictEqual(
            await loadPreparedWindowsStoreDiagnostic({
              preparedDirectory: prepared,
              layoutDirectory: layout,
              metadata,
            }),
            diagnostic
          )
        )
          throw new Error(
            'Unpacked diagnostic probe differs from the prepared probe'
          )
      }))
    )
      return report
    if (
      !(await check('unpacked-payload', async () => {
        const unpacked = await verifyWindowsStorePayload({
          appDir: path.join(layout, 'app'),
          metadata,
        })
        if (
          !unpacked.ok ||
          !isDeepStrictEqual(
            unpacked.inventory.physicalFiles,
            payload.inventory.physicalFiles
          )
        )
          throw new Error(
            'Unpacked payload does not match the verified prepared payload'
          )
      }))
    )
      return report
  }

  report.ok = true
  return report
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (
      !['--prepared', '--layout', '--phase'].includes(key) ||
      Object.hasOwn(options, key)
    )
      throw new Error(`Unknown or duplicate argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`${key} requires a value`)
    options[key] = value
  }
  if (!options['--prepared'] || !options['--phase'])
    throw new Error(
      'Required: --prepared <directory> [--layout <directory>] --phase <prepared|indexed|unpacked>'
    )
  return {
    preparedDirectory: options['--prepared'],
    layoutDirectory: options['--layout'],
    phase: options['--phase'],
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await verifyWindowsStoreLayout(
      parseArgs(process.argv.slice(2))
    )
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, checks: [{ name: 'input', ok: false, message: error.message }], payloadSourceVerified: false, windowsRuntimeVerified: false, signatureVerified: false, storeSubmissionReady: false }, null, 2)}\n`
    )
    process.exitCode = 1
  }
}
