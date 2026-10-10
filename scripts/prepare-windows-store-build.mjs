import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyWindowsStoreSource } from './verify-windows-store-source.mjs'
import { createWindowsStoreBuilderConfig } from './windows-store-builder-config.mjs'
import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'
import { resolveWindowsStoreOutput } from './windows-store-output.mjs'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function readSourceFile(root, name) {
  const file = path.join(root, name)
  if (!(await lstat(file)).isFile()) {
    throw new Error(`${name} must be a regular source file`)
  }
  return readFile(file)
}

/**
 * Write fresh build inputs only. Does not execute build commands, create an AppX,
 * sign, install, or publish. Run the eventual build from this same clean source.
 */
export async function prepareWindowsStoreBuild({
  repoRoot,
  metadata: raw,
  outputDirectory,
}) {
  const { metadata } = validateWindowsStoreMetadata(raw)
  if (typeof repoRoot !== 'string' || !repoRoot) {
    throw new Error('repoRoot must be an explicit checkout directory')
  }
  const root = await realpath(repoRoot)
  const output = await resolveWindowsStoreOutput({
    outputDirectory,
    inputDirectories: [root],
  })

  const sourceReport = await verifyWindowsStoreSource({
    repoRoot: root,
    metadata,
  })
  if (!sourceReport.ok) {
    const failed = sourceReport.checks
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.name}: ${entry.message}`)
    throw new Error(`Source checks failed: ${failed.join(', ')}`)
  }
  const baseBytes = await readSourceFile(root, 'electron-builder.json')
  const lockBytes = await readSourceFile(root, 'pnpm-lock.yaml')
  const config = createWindowsStoreBuilderConfig(JSON.parse(baseBytes), {
    outputDirectory: path.join(output, 'payload'),
  })
  const configBytes = json(config)
  const metadataBytes = json(metadata)
  const builderArgs = [
    'exec',
    'electron-builder',
    '--config',
    path.join(output, 'electron-builder.json'),
    '--win',
    '--x64',
    '--publish',
    'never',
  ]
  const plan = {
    schemaVersion: 1,
    scope: 'windows-directory-build-inputs',
    profile: metadata.profile,
    sourceCommit: metadata.source.commit,
    productVersion: metadata.productVersion,
    packageVersion: metadata.packageVersion,
    target: 'win32-x64',
    inputs: {
      metadataSha256: digest(metadataBytes),
      builderConfigSha256: digest(configBytes),
      baseBuilderConfigSha256: digest(baseBytes),
      dependencyLockSha256: digest(lockBytes),
    },
    // Argument arrays are instructions, never interpolated into a shell here.
    builder: { command: 'pnpm', args: builderArgs, cwd: 'source-checkout' },
    expectedPayload: 'payload/win-unpacked',
    sourceCheckoutChecked: true,
    buildExecuted: false,
    payloadSourceVerified: false,
    windowsRuntimeVerified: false,
    storeSubmissionReady: false,
  }

  // No recursive mkdir or overwrite: a failed write leaves an incomplete folder
  // for diagnosis. Retry with another fresh directory, never reuse partial input.
  await mkdir(output)
  await writeFile(path.join(output, 'electron-builder.json'), configBytes, {
    flag: 'wx',
  })
  await writeFile(path.join(output, 'release-metadata.json'), metadataBytes, {
    flag: 'wx',
  })
  await writeFile(path.join(output, 'source-report.json'), json(sourceReport), {
    flag: 'wx',
  })
  // Completion marker is written last.
  await writeFile(path.join(output, 'build-plan.json'), json(plan), {
    flag: 'wx',
  })
  return plan
}

function parseArgs(argv) {
  const allowed = ['--repo-root', '--metadata', '--out']
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!allowed.includes(key) || Object.hasOwn(options, key)) {
      throw new Error(`Unknown or duplicate argument: ${key}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`${key} requires a value`)
    options[key] = value
  }
  if (allowed.some((key) => !options[key])) {
    throw new Error(
      'Required: --repo-root <checkout> --metadata <file> --out <absolute-directory>'
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
    const plan = await prepareWindowsStoreBuild({
      repoRoot: options['--repo-root'],
      metadata: JSON.parse(await readFile(options['--metadata'], 'utf8')),
      outputDirectory: options['--out'],
    })
    process.stdout.write(json(plan))
  } catch (error) {
    process.stderr.write(`Windows build preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
