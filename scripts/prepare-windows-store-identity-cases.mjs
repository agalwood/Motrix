import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WINDOWS_PACKAGE_IDENTITY_FILE } from '../src/shared/schemas/windows-package-identity.ts'
import { prepareWindowsStoreLayout } from './prepare-windows-store-layout.mjs'
import { verifyWindowsStorePayload } from './verify-windows-store-payload.mjs'
import {
  validateWindowsStoreMetadata,
  WINDOWS_STORE_TEST_IDENTITY,
} from './windows-store-metadata.mjs'
import { resolveWindowsStoreOutput } from './windows-store-output.mjs'
import { createWindowsStoreRuntimeIdentity } from './windows-store-runtime-identity.mjs'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Build fresh test-only versioned layouts from verified, unchanged app code. */
export async function prepareWindowsStoreIdentityCases({
  repoRoot,
  appDir,
  metadata: raw,
  packageFamilyName,
  outputDirectory,
}) {
  const { metadata } = validateWindowsStoreMetadata(raw)
  if (
    metadata.profile !== 'test' ||
    metadata.packageVersion !== '1.0.0.0' ||
    metadata.identity.name !== WINDOWS_STORE_TEST_IDENTITY.name ||
    metadata.identity.publisher !== WINDOWS_STORE_TEST_IDENTITY.publisher ||
    metadata.testDiagnostics !== undefined
  )
    throw new Error(
      'Identity cases require the fixed ordinary test baseline 1.0.0.0'
    )
  createWindowsStoreRuntimeIdentity(metadata, packageFamilyName)
  const baseline = await verifyWindowsStorePayload({ appDir, metadata })
  if (!baseline.ok)
    throw new Error(
      'Baseline payload must pass before constructing identity cases'
    )
  const output = await resolveWindowsStoreOutput({
    outputDirectory,
    inputDirectories: [repoRoot, appDir],
  })
  await mkdir(output)
  const records = []
  const familyMismatch =
    packageFamilyName.slice(0, -1) +
    (packageFamilyName.endsWith('0') ? '1' : '0')
  for (const [label, version, family, outcome] of [
    ['rejected-family', '1.0.1.0', familyMismatch, 'identity_mismatch'],
    ['recovered', '1.0.2.0', packageFamilyName, 'accepted'],
  ]) {
    const caseRoot = path.join(output, label)
    await mkdir(caseRoot)
    const payload = path.join(caseRoot, 'payload')
    await cp(appDir, payload, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    })
    const next = {
      ...metadata,
      packageVersion: version,
      previousPackageVersions:
        label === 'recovered' ? ['1.0.0.0', '1.0.1.0'] : ['1.0.0.0'],
    }
    const runtimeBytes = json(createWindowsStoreRuntimeIdentity(next, family))
    await writeFile(
      path.join(payload, 'resources', WINDOWS_PACKAGE_IDENTITY_FILE),
      runtimeBytes
    )
    const current = await verifyWindowsStorePayload({
      appDir: payload,
      metadata: next,
    })
    if (!current.ok)
      throw new Error(
        'Versioned test payload did not pass structural verification'
      )
    const identityPath = `resources/${WINDOWS_PACKAGE_IDENTITY_FILE}`
    const untouched = (rows) => rows.filter((row) => row.path !== identityPath)
    if (
      json(untouched(current.inventory.physicalFiles)) !==
      json(untouched(baseline.inventory.physicalFiles))
    )
      throw new Error('Test case changed application code or another resource')
    const preparedDirectory = path.join(caseRoot, 'prepared')
    await prepareWindowsStoreLayout({
      repoRoot,
      appDir: payload,
      metadata: next,
      outputDirectory: preparedDirectory,
    })
    records.push({
      label,
      packageVersion: version,
      expectedStartup: outcome,
      preparedDirectory: `${label}/prepared`,
      runtimeIdentitySha256: sha(runtimeBytes),
      unchangedApplicationPayloadVerified: true,
    })
  }
  const report = {
    schemaVersion: 1,
    scope: 'fixed-test-identity-upgrade-cases',
    sourceCommit: metadata.source.commit,
    baselinePackageVersion: metadata.packageVersion,
    packageFamilyName,
    cases: records,
    installed: false,
    windowsRuntimeVerified: false,
    storeReady: false,
  }
  await writeFile(path.join(output, 'identity-cases.json'), json(report), {
    flag: 'wx',
  })
  return report
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const keys = [
      '--repo-root',
      '--app-dir',
      '--metadata',
      '--package-family-name',
      '--out',
    ]
    const options = {}
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i++) {
      const key = args[i]
      if (
        !keys.includes(key) ||
        Object.hasOwn(options, key) ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw new Error('Invalid or duplicate identity-case argument')
      options[key] = args[++i]
    }
    if (keys.some((key) => !options[key]))
      throw new Error('All identity-case input arguments are required')
    const report = await prepareWindowsStoreIdentityCases({
      repoRoot: options['--repo-root'],
      appDir: options['--app-dir'],
      metadata: JSON.parse(await readFile(options['--metadata'], 'utf8')),
      packageFamilyName: options['--package-family-name'],
      outputDirectory: options['--out'],
    })
    process.stdout.write(json(report))
  } catch (error) {
    process.stderr.write(`Identity-case preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
