import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedThreatIds = Array.from(
  { length: 29 },
  (_, index) => `T${String(index + 1).padStart(2, '0')}`
)
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/u

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
    throw new TypeError(`${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

export function validateThreatEvidenceManifest(input) {
  const manifest = assertRecord(input, 'manifest')
  assertExactKeys(manifest, ['schemaVersion', 'threats'], 'manifest')
  if (manifest.schemaVersion !== 1) {
    throw new TypeError('manifest.schemaVersion must be 1')
  }
  if (!Array.isArray(manifest.threats)) {
    throw new TypeError('manifest.threats must be an array')
  }

  const seen = new Set()
  for (const [threatIndex, rawThreat] of manifest.threats.entries()) {
    const label = `manifest.threats[${threatIndex}]`
    const threat = assertRecord(rawThreat, label)
    assertExactKeys(threat, ['id', 'evidence'], label)
    if (!expectedThreatIds.includes(threat.id) || seen.has(threat.id)) {
      throw new TypeError(`${label}.id must be one unique T01-T29 id`)
    }
    seen.add(threat.id)
    if (!Array.isArray(threat.evidence) || threat.evidence.length === 0) {
      throw new TypeError(`${label}.evidence must be a non-empty array`)
    }
    for (const [evidenceIndex, rawEvidence] of threat.evidence.entries()) {
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`
      const evidence = assertRecord(rawEvidence, evidenceLabel)
      assertExactKeys(
        evidence,
        ['repository', 'path', 'testName'],
        evidenceLabel
      )
      if (
        evidence.repository !== 'extension' &&
        evidence.repository !== 'motrix'
      ) {
        throw new TypeError(
          `${evidenceLabel}.repository must be extension or motrix`
        )
      }
      if (
        typeof evidence.path !== 'string' ||
        evidence.path.startsWith('/') ||
        evidence.path.includes('\\') ||
        evidence.path.split('/').includes('..') ||
        !testFilePattern.test(evidence.path)
      ) {
        throw new TypeError(
          `${evidenceLabel}.path must be a relative test file`
        )
      }
      if (
        typeof evidence.testName !== 'string' ||
        evidence.testName.length === 0 ||
        evidence.testName.length > 240 ||
        /[\r\n\0]/u.test(evidence.testName)
      ) {
        throw new TypeError(
          `${evidenceLabel}.testName must be one bounded single-line title`
        )
      }
    }
  }

  const actualIds = [...seen].sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedThreatIds)) {
    const missing = expectedThreatIds.filter((id) => !seen.has(id))
    throw new TypeError(
      `manifest must map every T01-T29 id; missing: ${missing.join(', ')}`
    )
  }
  return manifest
}

function assertInsideRepository(repository, relativePath) {
  const root = realpathSync(resolve(repository))
  const absolutePath = resolve(root, relativePath)
  if (!absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`evidence path escapes repository: ${relativePath}`)
  }
  if (existsSync(absolutePath) && lstatSync(absolutePath).isSymbolicLink()) {
    throw new Error(
      `evidence file must not be a symbolic link: ${relativePath}`
    )
  }
  if (
    existsSync(absolutePath) &&
    !realpathSync(absolutePath).startsWith(`${root}${sep}`)
  ) {
    throw new Error(
      `evidence file resolves outside repository: ${relativePath}`
    )
  }
  return absolutePath
}

export function verifyThreatEvidence({
  manifestPath = resolve(
    scriptRoot,
    'e2e/bridge/remote-extension-threat-evidence.json'
  ),
  motrixRepository = scriptRoot,
  extensionRepository,
}) {
  const parsed = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
  const manifest = validateThreatEvidenceManifest(parsed)
  const roots = {
    motrix: resolve(motrixRepository),
    extension: resolve(extensionRepository),
  }

  let evidenceCount = 0
  for (const threat of manifest.threats) {
    for (const evidence of threat.evidence) {
      const absolutePath = assertInsideRepository(
        roots[evidence.repository],
        evidence.path
      )
      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        throw new Error(
          `${threat.id} evidence file is missing: ${evidence.path}`
        )
      }
      const source = readFileSync(absolutePath, 'utf8')
      if (!source.includes(evidence.testName)) {
        throw new Error(
          `${threat.id} evidence title is missing from ${evidence.path}: ${evidence.testName}`
        )
      }
      evidenceCount += 1
    }
  }
  return { threatCount: manifest.threats.length, evidenceCount }
}

function inferExtensionRepository() {
  if (process.env.MOTRIX_EXTENSION_REPO) {
    return resolve(process.env.MOTRIX_EXTENSION_REPO)
  }
  if (process.env.MOTRIX_EXTENSION_BUILD) {
    const build = resolve(process.env.MOTRIX_EXTENSION_BUILD)
    const candidate = resolve(build, '../../../..')
    const packagePath = resolve(candidate, 'package.json')
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (packageJson.name === 'motrix-extension') return candidate
    }
  }
  throw new Error(
    'set MOTRIX_EXTENSION_REPO or MOTRIX_EXTENSION_BUILD to the compatible Extension checkout/build'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyThreatEvidence({
      extensionRepository: inferExtensionRepository(),
    })
    console.log(
      `Verified ${result.threatCount} remote Extension threats with ${result.evidenceCount} stable test references`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
