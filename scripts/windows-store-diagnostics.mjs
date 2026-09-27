import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC as DIAGNOSTIC,
  validateWindowsStoreMetadata,
} from './windows-store-metadata.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const WINDOWS_STORE_DIAGNOSTIC_BUILD_REPORT =
  'diagnostic-build-report.json'

function requireDiagnostic(raw) {
  const { metadata } = validateWindowsStoreMetadata(raw)
  if (metadata.testDiagnostics !== DIAGNOSTIC.mode)
    throw new Error('The explicit test diagnostic mode is required')
  return metadata
}

async function readRegular(root, relative, maximum) {
  const absolute = path.resolve(root, relative)
  const parsed = path.parse(absolute)
  let parent = parsed.root
  for (const segment of path
    .dirname(absolute)
    .slice(parent.length)
    .split(path.sep)
    .filter(Boolean)) {
    parent = path.join(parent, segment)
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Diagnostic inputs must not traverse symlink directories')
  }
  const before = await lstat(absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size === 0 ||
    before.size > maximum
  )
    throw new Error(
      `Diagnostic input must be a bounded regular file: ${relative}`
    )
  const file = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const actual = await file.stat()
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.size !== before.size
    )
      throw new Error('Diagnostic input changed before reading')
    const buffer = Buffer.alloc(actual.size + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        count,
        buffer.length - count,
        count
      )
      if (bytesRead === 0) break
      count += bytesRead
    }
    const bytes = buffer.subarray(0, count)
    const after = await file.stat()
    if (
      bytes.length !== actual.size ||
      actual.size !== after.size ||
      actual.mtimeMs !== after.mtimeMs
    )
      throw new Error('Diagnostic input changed while reading')
    return bytes
  } finally {
    await file.close()
  }
}

function requireConsoleExecutable(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 256 ||
    bytes.length > 1024 * 1024 ||
    bytes.toString('ascii', 0, 2) !== 'MZ'
  )
    throw new Error('Diagnostic probe must be a bounded PE executable')
  const offset = bytes.readUInt32LE(0x3c)
  if (
    offset < 64 ||
    offset > bytes.length - 94 ||
    bytes.readUInt32LE(offset) !== 0x4550
  )
    throw new Error('Diagnostic probe PE header is invalid')
  const optionalSize = bytes.readUInt16LE(offset + 20)
  const flags = bytes.readUInt16LE(offset + 22)
  if (
    optionalSize < 70 ||
    offset + 24 + optionalSize > bytes.length ||
    bytes.readUInt16LE(offset + 4) !== 0x8664 ||
    bytes.readUInt16LE(offset + 24) !== 0x20b ||
    bytes.readUInt16LE(offset + 92) !== 3 ||
    (flags & 2) === 0 ||
    (flags & 0x2000) !== 0
  )
    throw new Error('Diagnostic probe must be an x64 PE32+ console executable')
}

/** Validate actual bytes; a compiler report is an association record, not an attestation. */
export function inspectWindowsStoreDiagnostic({
  metadata: raw,
  executableBytes,
  buildReportBytes,
  sourceBytes,
}) {
  const metadata = requireDiagnostic(raw)
  requireConsoleExecutable(executableBytes)
  if (!Buffer.isBuffer(buildReportBytes) || buildReportBytes.length > 16 * 1024)
    throw new Error('Diagnostic build report must be bounded JSON')
  const build = JSON.parse(buildReportBytes.toString('utf8'))
  const sourceHash = build?.source?.sha256
  if (
    typeof sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sourceHash) ||
    (sourceBytes !== undefined && digest(sourceBytes) !== sourceHash)
  )
    throw new Error('Diagnostic source hash does not match the source checkout')
  const executableHash = digest(executableBytes)
  const expected = {
    schemaVersion: 1,
    scope: 'windows-native-messaging-probe-build',
    ok: true,
    compiled: true,
    compiler: 'Windows .NET Framework64 csc',
    source: { path: DIAGNOSTIC.source, sha256: sourceHash },
    executable: {
      path: path.posix.basename(DIAGNOSTIC.executable),
      bytes: executableBytes.length,
      sha256: executableHash,
      peMachine: '0x8664',
      peMachineVerified: true,
      peOptionalHeaderMagic: '0x020b',
      peSubsystem: '0x0003',
      consoleSubsystemVerified: true,
    },
    directStdioVerified: false,
    packagedActivationVerified: false,
    browserNativeMessagingVerified: false,
    mbp1Verified: false,
  }
  if (!isDeepStrictEqual(build, expected))
    throw new Error(
      'Diagnostic compiler report does not match the fixed contract and executable'
    )
  return {
    mode: DIAGNOSTIC.mode,
    source: {
      commit: metadata.source.commit,
      path: DIAGNOSTIC.source,
      sha256: sourceHash,
    },
    executable: {
      path: DIAGNOSTIC.executable,
      bytes: executableBytes.length,
      sha256: executableHash,
    },
    buildReportSha256: digest(buildReportBytes),
    packagedActivationVerified: false,
    browserNativeMessagingVerified: false,
    mbp1Verified: false,
  }
}

/** Read only the two fixed build inputs and bind their report to the checked source. */
export async function loadWindowsStoreDiagnostic({
  repoRoot,
  probeBuildDirectory,
  metadata,
}) {
  requireDiagnostic(metadata)
  if (
    typeof probeBuildDirectory !== 'string' ||
    !path.isAbsolute(probeBuildDirectory)
  )
    throw new Error(
      'probeBuildDirectory must be an explicit absolute directory'
    )
  // Validate every ancestor before realpath resolves any alias.
  const executableBytes = await readRegular(
    probeBuildDirectory,
    path.posix.basename(DIAGNOSTIC.executable),
    1024 * 1024
  )
  const buildReportBytes = await readRegular(
    probeBuildDirectory,
    'build-report.json',
    16 * 1024
  )
  const sourceBytes = await readRegular(
    repoRoot,
    DIAGNOSTIC.source,
    1024 * 1024
  )
  const record = inspectWindowsStoreDiagnostic({
    metadata,
    executableBytes,
    buildReportBytes,
    sourceBytes,
  })
  return {
    directory: await realpath(probeBuildDirectory),
    executableBytes,
    buildReportBytes,
    record,
  }
}

/** Offline content verification retains source references without authenticating a checkout. */
export async function loadPreparedWindowsStoreDiagnostic({
  preparedDirectory,
  layoutDirectory,
  metadata,
}) {
  const executableBytes = await readRegular(
    layoutDirectory,
    DIAGNOSTIC.executable,
    1024 * 1024
  )
  const buildReportBytes = await readRegular(
    preparedDirectory,
    WINDOWS_STORE_DIAGNOSTIC_BUILD_REPORT,
    16 * 1024
  )
  return inspectWindowsStoreDiagnostic({
    metadata,
    executableBytes,
    buildReportBytes,
  })
}
