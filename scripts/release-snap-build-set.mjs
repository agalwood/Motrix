import { execFile } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parseStrictSemVer } from './release-metadata.mjs'
import {
  readStoreChannelSnapshot,
  verifySnapStoreChannel,
} from './verify-snap-store-channel.mjs'

const execFileAsync = promisify(execFile)
const ARCHITECTURES = ['amd64', 'arm64']
const SNAP_NAME_PATTERN = /^[a-z0-9](?:-?[a-z0-9])*$/
const DEFAULT_SNAPCRAFT_COMMAND_TIMEOUT_MS = 120_000

function normalizeRevision(value, architecture) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${architecture} revision must be a positive integer`)
  }
  return value
}

function normalizeRevisions(revisions) {
  if (
    typeof revisions !== 'object' ||
    revisions === null ||
    Array.isArray(revisions) ||
    Object.keys(revisions).sort().join(',') !== 'amd64,arm64'
  ) {
    throw new Error('Revisions must contain exactly amd64 and arm64')
  }
  return Object.fromEntries(
    ARCHITECTURES.map((architecture) => [
      architecture,
      normalizeRevision(revisions[architecture], architecture),
    ])
  )
}

function revisionsFromSnapshot(snapshot) {
  return Object.fromEntries(
    ARCHITECTURES.flatMap((architecture) => {
      const entry = snapshot.entries[architecture]
      return entry ? [[architecture, entry.revision]] : []
    })
  )
}

function snapshotsMatch(left, right) {
  return ARCHITECTURES.every(
    (architecture) => left[architecture] === right[architecture]
  )
}

function snapcraftChannel(channel) {
  const [track, risk, extra] = channel.split('/')
  return track === 'latest' && risk && extra === undefined ? risk : channel
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchChannelSnapshot({
  snapName,
  channel,
  fetchImpl,
  attempts,
  delayMs,
}) {
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
      return revisionsFromSnapshot(
        readStoreChannelSnapshot(await response.json(), {
          snapName,
          channel,
          architectures: ARCHITECTURES,
        })
      )
    } catch (error) {
      lastError = error
      if (attempt < attempts && delayMs > 0) await wait(delayMs)
    }
  }
  throw new Error(
    `Could not read ${snapName} ${channel} after ${attempts} attempt(s): ${
      lastError?.message ?? 'unknown error'
    }`,
    { cause: lastError }
  )
}

async function waitForSnapshot(options, expected) {
  let lastObserved
  let lastError
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      lastObserved = await fetchChannelSnapshot({
        ...options,
        attempts: 1,
        delayMs: 0,
      })
      lastError = undefined
      if (snapshotsMatch(lastObserved, expected)) return
    } catch (error) {
      lastError = error
    }
    if (attempt < options.attempts && options.delayMs > 0) {
      await wait(options.delayMs)
    }
  }
  throw new Error(
    `Restored channel did not converge: expected ${JSON.stringify(expected)}, ${
      lastObserved
        ? `received ${JSON.stringify(lastObserved)}`
        : `last read failed: ${lastError?.message ?? 'unknown error'}`
    }`,
    lastError ? { cause: lastError } : undefined
  )
}

async function defaultRunSnapcraft(snapcraftPath, args, timeoutMs) {
  await execFileAsync(snapcraftPath, args, {
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  })
}

export async function releaseSnapBuildSet({
  snapName,
  channel,
  version,
  revisions,
  snapcraftPath = '/snap/bin/snapcraft',
  snapcraftCommandTimeoutMs = DEFAULT_SNAPCRAFT_COMMAND_TIMEOUT_MS,
  attempts = 12,
  delayMs = 10_000,
  fetchImpl = globalThis.fetch,
  runSnapcraft = (args) =>
    defaultRunSnapcraft(snapcraftPath, args, snapcraftCommandTimeoutMs),
}) {
  if (!SNAP_NAME_PATTERN.test(snapName)) {
    throw new Error(`Invalid Snap name "${snapName}"`)
  }
  parseStrictSemVer(version, 'Snap version')
  if (version.length > 32) throw new Error('Snap version exceeds 32 characters')
  if (!path.isAbsolute(snapcraftPath)) {
    throw new Error('Snapcraft path must be absolute')
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error('Attempts must be an integer from 1 to 100')
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
    throw new Error('Delay must be an integer from 0 to 300000 milliseconds')
  }
  if (
    !Number.isSafeInteger(snapcraftCommandTimeoutMs) ||
    snapcraftCommandTimeoutMs < 1_000 ||
    snapcraftCommandTimeoutMs > 600_000
  ) {
    throw new Error(
      'Snapcraft command timeout must be an integer from 1000 to 600000 milliseconds'
    )
  }
  const approved = normalizeRevisions(revisions)
  // Snap Store API responses use the canonical latest/<risk> spelling, while
  // channel-restricted macaroons issued for the default track authorize the
  // short risk name used by Snapcraft's mutation commands.
  const mutationChannel = snapcraftChannel(channel)
  const snapshotOptions = {
    snapName,
    channel,
    fetchImpl,
    attempts,
    delayMs,
  }
  const previous = await fetchChannelSnapshot(snapshotOptions)

  try {
    // Treat even a rejected initial close as an uncertain mutation. The Store
    // may have committed the close before the CLI lost its response.
    await runSnapcraft(['close', snapName, mutationChannel])
    for (const architecture of ARCHITECTURES) {
      await runSnapcraft([
        'release',
        snapName,
        approved[architecture],
        mutationChannel,
      ])
    }
    await verifySnapStoreChannel({
      snapName,
      channel,
      version,
      architectures: ARCHITECTURES,
      expectedRevisions: approved,
      attempts,
      delayMs,
      fetchImpl,
    })
  } catch (releaseError) {
    try {
      await runSnapcraft(['close', snapName, mutationChannel])
      for (const architecture of ARCHITECTURES) {
        if (previous[architecture]) {
          await runSnapcraft([
            'release',
            snapName,
            previous[architecture],
            mutationChannel,
          ])
        }
      }
      await waitForSnapshot(snapshotOptions, previous)
    } catch (rollbackError) {
      let containmentError
      try {
        // A rollback can fail after restoring only one architecture. Close the
        // target again so a partially restored public channel is not left
        // available. A closed channel is safer than a mixed build set.
        await runSnapcraft(['close', snapName, mutationChannel])
      } catch (error) {
        containmentError = error
      }
      throw new AggregateError(
        [releaseError, rollbackError, containmentError].filter(Boolean),
        containmentError
          ? `Failed to release ${snapName} ${channel}; rollback and containment close both failed`
          : `Failed to release ${snapName} ${channel}; rollback failed and the target channel was closed`
      )
    }
    throw new Error(
      `Failed to release ${snapName} ${channel}; previous revisions were restored`,
      { cause: releaseError }
    )
  }

  return {
    channel,
    previous,
    released: approved,
    version,
  }
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
    '--amd64-revision',
    '--arm64-revision',
    '--snapcraft',
    '--snapcraft-timeout-ms',
    '--attempts',
    '--delay-ms',
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
  for (const option of [
    '--snap',
    '--channel',
    '--version',
    '--amd64-revision',
    '--arm64-revision',
  ]) {
    if (!args.has(option))
      throw new Error(`Missing required argument: ${option}`)
  }
  const result = await releaseSnapBuildSet({
    snapName: args.get('--snap'),
    channel: args.get('--channel'),
    version: args.get('--version'),
    revisions: {
      amd64: args.get('--amd64-revision'),
      arm64: args.get('--arm64-revision'),
    },
    snapcraftPath: args.get('--snapcraft') ?? '/snap/bin/snapcraft',
    snapcraftCommandTimeoutMs: parsePositiveInteger(
      args.get('--snapcraft-timeout-ms') ??
        String(DEFAULT_SNAPCRAFT_COMMAND_TIMEOUT_MS),
      '--snapcraft-timeout-ms'
    ),
    attempts: parsePositiveInteger(
      args.get('--attempts') ?? '12',
      '--attempts'
    ),
    delayMs: parsePositiveInteger(
      args.get('--delay-ms') ?? '10000',
      '--delay-ms'
    ),
  })
  console.log(
    `Released ${args.get('--snap')} ${result.version} to ${result.channel}: ${JSON.stringify(
      result.released
    )}`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
