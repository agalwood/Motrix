import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStrictSemVer } from './release-metadata.mjs'

const DEFAULT_ARCHITECTURES = ['amd64', 'arm64']
const CHANNEL_PATTERN =
  /^(?<track>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<risk>stable|candidate|beta|edge)$/
const SNAP_NAME_PATTERN = /^[a-z0-9](?:-?[a-z0-9])*$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseChannel(channel) {
  const match = CHANNEL_PATTERN.exec(channel)
  if (!match?.groups) {
    throw new Error(
      `Invalid channel "${channel}"; expected <track>/<stable|candidate|beta|edge>`
    )
  }
  return {
    track: match.groups.track,
    risk: match.groups.risk,
  }
}

function validateArchitectures(architectures) {
  if (
    !Array.isArray(architectures) ||
    architectures.length === 0 ||
    new Set(architectures).size !== architectures.length ||
    architectures.some((arch) => !['amd64', 'arm64'].includes(arch))
  ) {
    throw new Error('Architectures must be a unique subset of amd64,arm64')
  }
}

function validateVersion(version) {
  parseStrictSemVer(version, 'Snap version')
  if (version.length > 32) throw new Error('Snap version exceeds 32 characters')
}

function normalizeRevision(value, label) {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9]\d*$/.test(value))
  ) {
    return String(value)
  }
  throw new Error(`${label} must be a positive Snap revision`)
}

function validateExpectedRevisions(expectedRevisions, architectures) {
  if (expectedRevisions === undefined) return undefined
  if (!isRecord(expectedRevisions)) {
    throw new Error('Expected revisions must be an object')
  }
  const keys = Object.keys(expectedRevisions).sort()
  if (
    keys.length !== architectures.length ||
    architectures.some((architecture) => !keys.includes(architecture))
  ) {
    throw new Error(
      'Expected revisions must contain exactly the requested architectures'
    )
  }
  return Object.fromEntries(
    architectures.map((architecture) => [
      architecture,
      normalizeRevision(
        expectedRevisions[architecture],
        `Expected ${architecture} revision`
      ),
    ])
  )
}

export function readStoreChannelSnapshot(
  payload,
  { channel, architectures = DEFAULT_ARCHITECTURES, snapName }
) {
  const { track, risk } = parseChannel(channel)
  validateArchitectures(architectures)
  if (!isRecord(payload) || !Array.isArray(payload['channel-map'])) {
    throw new Error('Snap Store response is missing channel-map')
  }
  if (
    snapName !== undefined &&
    (payload.name !== snapName ||
      !isRecord(payload.snap) ||
      payload.snap.name !== snapName)
  ) {
    throw new Error(`Snap Store response identity does not match ${snapName}`)
  }

  const entries = {}
  const unexpectedArchitectures = new Set()
  for (const entry of payload['channel-map']) {
    if (!isRecord(entry) || !isRecord(entry.channel)) continue
    const candidate = entry.channel
    if (candidate.track !== track || candidate.risk !== risk) continue
    if (candidate.name !== risk) continue
    if (typeof candidate.architecture !== 'string') continue
    if (!architectures.includes(candidate.architecture)) {
      unexpectedArchitectures.add(candidate.architecture)
      continue
    }
    if (entries[candidate.architecture]) {
      throw new Error(
        `Snap Store ${channel} has duplicate ${candidate.architecture} entries`
      )
    }
    entries[candidate.architecture] = {
      revision: normalizeRevision(
        entry.revision,
        `${candidate.architecture} revision`
      ),
      version: entry.version,
    }
  }
  if (unexpectedArchitectures.size > 0) {
    throw new Error(
      `Snap Store ${channel} has unexpected architectures: ${[
        ...unexpectedArchitectures,
      ]
        .sort()
        .join(',')}`
    )
  }

  return {
    architectures: [...architectures],
    channel,
    entries,
  }
}

export function verifyStoreChannelPayload(
  payload,
  {
    channel,
    version,
    architectures = DEFAULT_ARCHITECTURES,
    expectedRevisions,
    snapName,
  }
) {
  validateVersion(version)
  const normalizedExpectedRevisions = validateExpectedRevisions(
    expectedRevisions,
    architectures
  )
  const snapshot = readStoreChannelSnapshot(payload, {
    channel,
    architectures,
    snapName,
  })

  const failures = []
  for (const architecture of architectures) {
    const observed = snapshot.entries[architecture]
    if (!observed) {
      failures.push(`${architecture}: missing`)
    } else if (observed.version !== version) {
      failures.push(
        `${architecture}: expected ${version}, received ${observed.version}`
      )
    } else if (
      normalizedExpectedRevisions &&
      observed.revision !== normalizedExpectedRevisions[architecture]
    ) {
      failures.push(
        `${architecture}: expected revision ${normalizedExpectedRevisions[architecture]}, received ${observed.revision}`
      )
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Snap Store ${channel} is incomplete: ${failures.join('; ')}`
    )
  }

  return {
    architectures: [...architectures],
    channel,
    revisions: Object.fromEntries(
      architectures.map((architecture) => [
        architecture,
        snapshot.entries[architecture].revision,
      ])
    ),
    version,
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function verifySnapStoreChannel({
  snapName,
  channel,
  version,
  architectures = DEFAULT_ARCHITECTURES,
  attempts = 1,
  delayMs = 0,
  expectedRevisions,
  fetchImpl = globalThis.fetch,
}) {
  if (!SNAP_NAME_PATTERN.test(snapName)) {
    throw new Error(`Invalid Snap name "${snapName}"`)
  }
  parseChannel(channel)
  validateArchitectures(architectures)
  validateVersion(version)
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error('Attempts must be an integer from 1 to 100')
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
    throw new Error('Delay must be an integer from 0 to 300000 milliseconds')
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')

  const endpoint = `https://api.snapcraft.io/v2/snaps/info/${encodeURIComponent(
    snapName
  )}`
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        headers: {
          Accept: 'application/json',
          'Snap-Device-Series': '16',
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        throw new Error(`Snap Store returned HTTP ${response.status}`)
      }
      const result = verifyStoreChannelPayload(await response.json(), {
        channel,
        version,
        architectures,
        expectedRevisions,
        snapName,
      })
      return {
        ...result,
        attempts: attempt,
      }
    } catch (error) {
      lastError = error
      if (attempt < attempts && delayMs > 0) await delay(delayMs)
    }
  }

  throw new Error(
    `Snap Store channel verification failed after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`,
    { cause: lastError }
  )
}

export async function readRevisionFile(filePath, architectures) {
  validateArchitectures(architectures)
  const resolved = path.resolve(filePath)
  const info = await lstat(resolved).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) {
    throw new Error(
      `Revision file is missing, unsafe, or too large: ${resolved}`
    )
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'))
  } catch (error) {
    throw new Error(`Revision file is not valid JSON: ${resolved}`, {
      cause: error,
    })
  }
  return validateExpectedRevisions(parsed, architectures)
}

export async function writeRevisionFile(filePath, revisions, architectures) {
  validateArchitectures(architectures)
  const normalized = validateExpectedRevisions(revisions, architectures)
  if (!normalized) throw new Error('Revisions are required')
  const requested = path.resolve(filePath)
  const canonicalParent = await realpath(path.dirname(requested)).catch(
    () => null
  )
  if (!canonicalParent) {
    throw new Error(`Revision file parent directory is missing: ${requested}`)
  }
  const destination = path.join(canonicalParent, path.basename(requested))
  const existing = await lstat(destination).catch(() => null)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Revision output path is unsafe: ${destination}`)
  }

  const temporary = path.join(
    canonicalParent,
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`
  )
  let file
  try {
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, destination)
  } catch (error) {
    await file?.close().catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
  return destination
}

function parsePositiveInteger(value, option) {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be an integer`)
  return Number(value)
}

function parseArguments(argv) {
  const allowed = new Set([
    '--snap',
    '--channel',
    '--version',
    '--architectures',
    '--attempts',
    '--delay-ms',
    '--expected-amd64-revision',
    '--expected-arm64-revision',
    '--expected-revisions',
    '--write-revisions',
  ])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(option) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument near "${option ?? ''}"`)
    }
    if (values.has(option)) throw new Error(`Duplicate argument: ${option}`)
    values.set(option, value)
  }
  return values
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  for (const option of ['--snap', '--channel', '--version']) {
    if (!args.has(option))
      throw new Error(`Missing required argument: ${option}`)
  }
  const architectures = (args.get('--architectures') ?? 'amd64,arm64').split(
    ','
  )
  const directExpectedRevisions = Object.fromEntries(
    ['amd64', 'arm64']
      .filter((architecture) => args.has(`--expected-${architecture}-revision`))
      .map((architecture) => [
        architecture,
        args.get(`--expected-${architecture}-revision`),
      ])
  )
  if (
    args.has('--expected-revisions') &&
    Object.keys(directExpectedRevisions).length > 0
  ) {
    throw new Error(
      'Use either --expected-revisions or per-architecture revision options'
    )
  }
  const expectedRevisions = args.has('--expected-revisions')
    ? await readRevisionFile(args.get('--expected-revisions'), architectures)
    : Object.keys(directExpectedRevisions).length > 0
      ? validateExpectedRevisions(directExpectedRevisions, architectures)
      : undefined

  const result = await verifySnapStoreChannel({
    snapName: args.get('--snap'),
    channel: args.get('--channel'),
    version: args.get('--version'),
    architectures,
    attempts: parsePositiveInteger(args.get('--attempts') ?? '1', '--attempts'),
    delayMs: parsePositiveInteger(args.get('--delay-ms') ?? '0', '--delay-ms'),
    expectedRevisions,
  })
  if (args.has('--write-revisions')) {
    await writeRevisionFile(
      args.get('--write-revisions'),
      result.revisions,
      result.architectures
    )
  }
  console.log(
    `Verified ${args.get('--snap')} ${result.version} in ${result.channel} for ${result.architectures.join(',')} after ${result.attempts} attempt(s)`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
