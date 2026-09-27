import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyWindowsStorePayload } from './verify-windows-store-payload.mjs'
import { verifyWindowsStoreSource } from './verify-windows-store-source.mjs'
import {
  renderWindowsStoreManifest,
  renderWindowsStorePriConfig,
  WINDOWS_STORE_SCALE_200_ASSETS,
} from './windows-store-manifest.mjs'
import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'
import { resolveWindowsStoreOutput } from './windows-store-output.mjs'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

async function loadAssets(root) {
  const result = []
  for (const asset of WINDOWS_STORE_SCALE_200_ASSETS) {
    const file = path.join(root, asset.source)
    if (!(await lstat(file)).isFile()) {
      throw new Error(`Asset must be a regular file: ${asset.source}`)
    }
    const relative = path.relative(root, await realpath(file))
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Asset must remain inside the checkout: ${asset.source}`)
    }
    const bytes = await readFile(file)
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== asset.width ||
      bytes.readUInt32BE(20) !== asset.height
    ) {
      throw new Error(`Invalid scale-200 PNG dimensions: ${asset.source}`)
    }
    result.push({ asset, bytes })
  }
  return result
}

function requirePassed(report, label) {
  if (!report.ok) {
    throw new Error(
      `${label} verification failed; no complete layout was produced`
    )
  }
}

/**
 * Assemble an unsigned test layout, not a distributable package. Package-system
 * integration and production assets are unfinished, so Store mode fails closed.
 */
export async function prepareWindowsStoreLayout({
  repoRoot,
  appDir,
  metadata: raw,
  outputDirectory,
}) {
  const { metadata } = validateWindowsStoreMetadata(raw)
  if (metadata.profile !== 'test') {
    throw new Error(
      'Only test layouts are supported until production assets and package integration are complete'
    )
  }
  if (
    typeof repoRoot !== 'string' ||
    !repoRoot ||
    typeof appDir !== 'string' ||
    !appDir
  ) {
    throw new Error('repoRoot and appDir must be explicit directories')
  }
  const root = await realpath(repoRoot)
  const output = await resolveWindowsStoreOutput({
    outputDirectory,
    inputDirectories: [root, appDir],
  })
  const sourceReport = await verifyWindowsStoreSource({
    repoRoot: root,
    metadata,
  })
  requirePassed(sourceReport, 'Source')
  const payloadReport = await verifyWindowsStorePayload({
    appDir,
    metadata,
  })
  requirePassed(payloadReport, 'Payload')
  const assets = await loadAssets(root)
  const manifest = renderWindowsStoreManifest(metadata)
  const priConfig = renderWindowsStorePriConfig(metadata)

  await mkdir(output)
  const layout = path.join(output, 'layout')
  await mkdir(layout)
  await cp(appDir, path.join(layout, 'app'), {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  })
  // Verify the actual copied tree, including ASAR and native files. A tree that
  // changed during copy must not acquire a successful completion record.
  const copiedReport = await verifyWindowsStorePayload({
    appDir: path.join(layout, 'app'),
    metadata,
  })
  requirePassed(copiedReport, 'Copied payload')
  if (
    json(payloadReport.inventory.physicalFiles) !==
    json(copiedReport.inventory.physicalFiles)
  ) {
    throw new Error('Payload changed during layout assembly')
  }
  const assetInventory = []
  for (const { asset, bytes } of assets) {
    for (const directory of [layout, path.join(output, 'pri-root')]) {
      const destination = path.join(directory, asset.destination)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { flag: 'wx' })
    }
    assetInventory.push({
      path: asset.destination,
      bytes: bytes.length,
      sha256: digest(bytes),
    })
  }
  await writeFile(path.join(layout, 'AppxManifest.xml'), manifest, {
    flag: 'wx',
  })
  await writeFile(path.join(output, 'priconfig.xml'), priConfig, { flag: 'wx' })
  await writeFile(path.join(output, 'release-metadata.json'), json(metadata), {
    flag: 'wx',
  })
  await writeFile(
    path.join(output, 'payload-report.json'),
    json(payloadReport),
    { flag: 'wx' }
  )
  const finalSourceReport = await verifyWindowsStoreSource({
    repoRoot: root,
    metadata,
  })
  requirePassed(finalSourceReport, 'Final source')
  await writeFile(
    path.join(output, 'source-report.json'),
    json(finalSourceReport),
    { flag: 'wx' }
  )
  await writeFile(
    path.join(output, 'TEST-ONLY.txt'),
    'Unsigned test layout. Not for Store submission or public distribution.\n' +
      'Use an isolated Windows test user or VM: startup and browser integration are unfinished.\n' +
      'No Windows SDK, signing, installation, upgrade, or runtime validation has run.\n',
    { flag: 'wx' }
  )
  const report = {
    schemaVersion: 1,
    scope: 'windows-test-layout',
    profile: 'test',
    identity: metadata.identity,
    productVersion: metadata.productVersion,
    packageVersion: metadata.packageVersion,
    sourceCommit: metadata.source.commit,
    manifestSha256: digest(manifest),
    priConfigSha256: digest(priConfig),
    assets: assetInventory,
    payload: copiedReport.inventory.physicalFiles,
    copiedPayloadMatched: true,
    payloadSourceVerified: false,
    windowsSdkExecuted: false,
    windowsRuntimeVerified: false,
    storeSubmissionReady: false,
  }
  // No successful record exists if any earlier check or write fails.
  await writeFile(path.join(output, 'layout-report.json'), json(report), {
    flag: 'wx',
  })
  return report
}

function parseArgs(argv) {
  const keys = ['--repo-root', '--app-dir', '--metadata', '--out']
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!keys.includes(key) || Object.hasOwn(options, key))
      throw new Error(`Unknown or duplicate argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`${key} requires a value`)
    options[key] = value
  }
  if (keys.some((key) => !options[key])) {
    throw new Error(
      'Required: --repo-root <checkout> --app-dir <payload> --metadata <file> --out <absolute-directory>'
    )
  }
  return options
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const report = await prepareWindowsStoreLayout({
      repoRoot: options['--repo-root'],
      appDir: options['--app-dir'],
      metadata: JSON.parse(await readFile(options['--metadata'], 'utf8')),
      outputDirectory: options['--out'],
    })
    process.stdout.write(json(report))
  } catch (error) {
    process.stderr.write(`Windows test layout failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
