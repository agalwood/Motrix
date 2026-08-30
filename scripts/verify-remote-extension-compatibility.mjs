import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u
const PLACEHOLDER_SHA_PATTERN = /^(?:0{40}|f{40})$/u
const EXPECTED_PROTOCOL = 'MDXP-over-MBP1'

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(
      `${label} must contain exactly: ${wanted.join(', ')}; got: ${actual.join(', ')}`
    )
  }
}

function assertFullCommit(value, label) {
  if (
    typeof value !== 'string' ||
    !FULL_SHA_PATTERN.test(value) ||
    PLACEHOLDER_SHA_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be a non-placeholder full lowercase SHA`)
  }
}

export function validateRemoteExtensionCompatibilityManifest(input) {
  const manifest = assertRecord(input, 'manifest')
  assertExactKeys(
    manifest,
    ['schemaVersion', 'protocol', 'extension', 'motrix', 'e2e'],
    'manifest'
  )
  if (manifest.schemaVersion !== 1) {
    throw new TypeError('manifest.schemaVersion must be 1')
  }
  if (manifest.protocol !== EXPECTED_PROTOCOL) {
    throw new TypeError(`manifest.protocol must be ${EXPECTED_PROTOCOL}`)
  }

  const extension = assertRecord(manifest.extension, 'manifest.extension')
  const motrix = assertRecord(manifest.motrix, 'manifest.motrix')
  const e2e = assertRecord(manifest.e2e, 'manifest.e2e')
  assertExactKeys(extension, ['repository', 'commit'], 'manifest.extension')
  assertExactKeys(motrix, ['repository', 'commit'], 'manifest.motrix')
  assertExactKeys(e2e, ['browserCases', 'command'], 'manifest.e2e')

  if (extension.repository !== 'motrix-extension') {
    throw new TypeError(
      'manifest.extension.repository must be motrix-extension'
    )
  }
  if (motrix.repository !== 'motrix-app') {
    throw new TypeError('manifest.motrix.repository must be motrix-app')
  }
  assertFullCommit(extension.commit, 'manifest.extension.commit')
  assertFullCommit(motrix.commit, 'manifest.motrix.commit')
  if (!Number.isInteger(e2e.browserCases) || e2e.browserCases < 5) {
    throw new TypeError('manifest.e2e.browserCases must be an integer >= 5')
  }
  if (e2e.command !== 'pnpm test:e2e:remote-extension') {
    throw new TypeError(
      'manifest.e2e.command must be pnpm test:e2e:remote-extension'
    )
  }

  return manifest
}

function runGit(repository, args) {
  return spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function verifyPinnedCommit(repository, commit, label) {
  const resolvedRepository = resolve(repository)
  const object = runGit(resolvedRepository, [
    'cat-file',
    '-e',
    `${commit}^{commit}`,
  ])
  if (object.status !== 0) {
    throw new Error(
      `${label} commit ${commit} does not resolve in ${resolvedRepository}`
    )
  }
  const ancestor = runGit(resolvedRepository, [
    'merge-base',
    '--is-ancestor',
    commit,
    'HEAD',
  ])
  if (ancestor.status !== 0) {
    throw new Error(
      `${label} commit ${commit} is not an ancestor of HEAD in ${resolvedRepository}`
    )
  }
}

export function verifyRemoteExtensionCompatibility({
  manifestPath,
  motrixRepository,
  extensionRepository,
}) {
  const parsed = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
  const manifest = validateRemoteExtensionCompatibilityManifest(parsed)
  verifyPinnedCommit(
    extensionRepository,
    manifest.extension.commit,
    'Extension'
  )
  verifyPinnedCommit(motrixRepository, manifest.motrix.commit, 'Motrix')
  return manifest
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new TypeError(
        'usage: node scripts/verify-remote-extension-compatibility.mjs --manifest <path> --motrix-repo <path> --extension-repo <path>'
      )
    }
    values.set(key, value)
  }
  for (const required of ['--manifest', '--motrix-repo', '--extension-repo']) {
    if (!values.has(required)) {
      throw new TypeError(`missing required argument: ${required}`)
    }
  }
  return {
    manifestPath: values.get('--manifest'),
    motrixRepository: values.get('--motrix-repo'),
    extensionRepository: values.get('--extension-repo'),
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  try {
    const manifest = verifyRemoteExtensionCompatibility(
      parseArguments(process.argv.slice(2))
    )
    console.log(
      `Verified ${manifest.protocol}: Extension ${manifest.extension.commit}, Motrix ${manifest.motrix.commit}, ${manifest.e2e.browserCases} browser cases`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
