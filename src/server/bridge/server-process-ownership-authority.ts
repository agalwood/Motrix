import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BridgeDataDirLockRecoveryAuthority } from '@core/bridge/bridge-data-dir-lock'

const BINDING_VERSION = 1
const BINDING_FILE_NAME = '.motrix-server-bridge-owner.json'
const MAX_BINDING_BYTES = 1024
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

export const ServerProcessOwnershipFailureReason = {
  ControlPlaneUnavailable: 'control-plane-unavailable',
  BindingMetadataUnavailable: 'binding-metadata-unavailable',
  BindingNotRegularFile: 'binding-not-regular-file',
  BindingLinkCountMismatch: 'binding-link-count-mismatch',
  BindingOwnerMismatch: 'binding-owner-mismatch',
  BindingInsecureMode: 'binding-insecure-mode',
  BindingOpenFailed: 'binding-open-failed',
  BindingStatFailed: 'binding-stat-failed',
  BindingChanged: 'binding-changed',
  BindingTooLarge: 'binding-too-large',
  BindingReadFailed: 'binding-read-failed',
  BindingEmpty: 'binding-empty',
  BindingInvalidJson: 'binding-invalid-json',
  BindingSchemaMismatch: 'binding-schema-mismatch',
  BindingSerializationMismatch: 'binding-serialization-mismatch',
  BindingCreateFailed: 'binding-create-failed',
  BindingWriteFailed: 'binding-write-failed',
  BindingPortMismatch: 'binding-port-mismatch',
  BindingHostMismatch: 'binding-host-mismatch',
  BindingTransportMismatch: 'binding-transport-mismatch',
  BindingDirectoryMismatch: 'binding-directory-mismatch',
} as const

export type ServerProcessOwnershipFailureReason =
  (typeof ServerProcessOwnershipFailureReason)[keyof typeof ServerProcessOwnershipFailureReason]

export class ServerProcessOwnershipError extends Error {
  constructor(readonly reason: ServerProcessOwnershipFailureReason) {
    super(`server bridge process ownership unavailable: ${reason}`)
    this.name = 'ServerProcessOwnershipError'
  }
}

interface BindingDocument {
  readonly version: typeof BINDING_VERSION
  readonly transport: 'tcp-control-plane'
  readonly host: '0.0.0.0'
  readonly port: number
  readonly bridgeDataDirectory: string
}

export interface ServerProcessOwnershipAuthorityOptions {
  readonly userDataDir: string
  readonly port: number
  /** True only while this process still owns the already-bound control plane. */
  readonly assertControlPlaneOwnership: () => boolean
}

function fail(
  reason: ServerProcessOwnershipFailureReason
): ServerProcessOwnershipError {
  return new ServerProcessOwnershipError(reason)
}

function serialize(document: BindingDocument): Buffer {
  return Buffer.from(`${JSON.stringify(document)}\n`, 'utf8')
}

function isExactBinding(value: unknown): value is BindingDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 5 ||
    record.version !== BINDING_VERSION ||
    record.transport !== 'tcp-control-plane' ||
    record.host !== '0.0.0.0' ||
    !Number.isSafeInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65535 ||
    typeof record.bridgeDataDirectory !== 'string' ||
    record.bridgeDataDirectory.length === 0
  ) {
    return false
  }
  return true
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  return (
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino)
  )
}

async function readExactBinding(filePath: string): Promise<BindingDocument> {
  let handle: fs.FileHandle | null = null
  try {
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await fs.lstat(filePath, { bigint: true })
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingMetadataUnavailable)
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw fail(ServerProcessOwnershipFailureReason.BindingNotRegularFile)
    }
    if (before.nlink !== 1n) {
      throw fail(ServerProcessOwnershipFailureReason.BindingLinkCountMismatch)
    }
    if (process.platform !== 'win32') {
      if (
        typeof process.geteuid === 'function' &&
        before.uid !== BigInt(process.geteuid())
      ) {
        throw fail(ServerProcessOwnershipFailureReason.BindingOwnerMismatch)
      }
      // The record contains no secret. Integrity requires that the owning UID
      // is the only identity able to modify it; read-only group/other access is
      // harmless and is common on NAS bind mounts with inherited ACLs.
      if ((before.mode & 0o022n) !== 0n) {
        throw fail(ServerProcessOwnershipFailureReason.BindingInsecureMode)
      }
    }
    const flags = constants.O_RDONLY | NO_FOLLOW
    try {
      handle = await fs.open(filePath, flags)
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingOpenFailed)
    }
    let during: Awaited<ReturnType<fs.FileHandle['stat']>>
    try {
      during = await handle.stat({ bigint: true })
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingStatFailed)
    }
    if (!sameFile(before, during)) {
      throw fail(ServerProcessOwnershipFailureReason.BindingChanged)
    }
    if (during.size > BigInt(MAX_BINDING_BYTES)) {
      throw fail(ServerProcessOwnershipFailureReason.BindingTooLarge)
    }
    let bytes: Buffer
    try {
      bytes = await handle.readFile()
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingReadFailed)
    }
    if (bytes.length === 0) {
      throw fail(ServerProcessOwnershipFailureReason.BindingEmpty)
    }
    if (bytes.length > MAX_BINDING_BYTES) {
      throw fail(ServerProcessOwnershipFailureReason.BindingTooLarge)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingInvalidJson)
    }
    if (!isExactBinding(parsed)) {
      throw fail(ServerProcessOwnershipFailureReason.BindingSchemaMismatch)
    }
    if (!bytes.equals(serialize(parsed))) {
      throw fail(
        ServerProcessOwnershipFailureReason.BindingSerializationMismatch
      )
    }
    let after: Awaited<ReturnType<typeof fs.lstat>>
    try {
      after = await fs.lstat(filePath, { bigint: true })
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingChanged)
    }
    if (!sameFile(during, after)) {
      throw fail(ServerProcessOwnershipFailureReason.BindingChanged)
    }
    return parsed
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function tightenNewBindingMode(handle: fs.FileHandle): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await handle.chmod(0o600)
  } catch {
    // Some mounted filesystems reject chmod even though create(0600) already
    // produced a safe file. Continue only when the handle proves that case.
    let info: Awaited<ReturnType<fs.FileHandle['stat']>>
    try {
      info = await handle.stat({ bigint: true })
    } catch {
      throw fail(ServerProcessOwnershipFailureReason.BindingStatFailed)
    }
    if (
      (typeof process.geteuid === 'function' &&
        info.uid !== BigInt(process.geteuid())) ||
      (info.mode & 0o022n) !== 0n
    ) {
      throw fail(ServerProcessOwnershipFailureReason.BindingInsecureMode)
    }
  }
}

async function persistBinding(
  filePath: string,
  expected: BindingDocument
): Promise<void> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw fail(ServerProcessOwnershipFailureReason.BindingCreateFailed)
    }
  }
  if (handle !== null) {
    try {
      await tightenNewBindingMode(handle)
      await handle.writeFile(serialize(expected))
      await handle.sync()
    } catch (error) {
      if (error instanceof ServerProcessOwnershipError) throw error
      throw fail(ServerProcessOwnershipFailureReason.BindingWriteFailed)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  const actual = await readExactBinding(filePath)
  if (actual.port !== expected.port) {
    throw fail(ServerProcessOwnershipFailureReason.BindingPortMismatch)
  }
  if (actual.host !== expected.host) {
    throw fail(ServerProcessOwnershipFailureReason.BindingHostMismatch)
  }
  if (actual.transport !== expected.transport) {
    throw fail(ServerProcessOwnershipFailureReason.BindingTransportMismatch)
  }
  if (actual.bridgeDataDirectory !== expected.bridgeDataDirectory) {
    throw fail(ServerProcessOwnershipFailureReason.BindingDirectoryMismatch)
  }
}

/**
 * Pins one Server data directory to the main TCP control-plane port. The
 * already-listening socket is the external OS exclusivity proof used to
 * recover a bridge lock left by a crash. A second process cannot substitute a
 * different port for the same data directory, and cannot own the pinned port
 * while the first process is alive.
 */
export async function establishServerProcessOwnershipAuthority(
  options: ServerProcessOwnershipAuthorityOptions
): Promise<BridgeDataDirLockRecoveryAuthority> {
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !options.assertControlPlaneOwnership()
  ) {
    throw fail(ServerProcessOwnershipFailureReason.ControlPlaneUnavailable)
  }

  await fs.mkdir(options.userDataDir, { recursive: true })
  const canonicalUserDataDir = await fs.realpath(options.userDataDir)
  const bridgeDataDirectory = path.join(canonicalUserDataDir, 'bridge')
  await fs.mkdir(bridgeDataDirectory, { recursive: true })
  const canonicalBridgeDataDirectory = await fs.realpath(bridgeDataDirectory)
  const binding: BindingDocument = {
    version: BINDING_VERSION,
    transport: 'tcp-control-plane',
    host: '0.0.0.0',
    port: options.port,
    bridgeDataDirectory: canonicalBridgeDataDirectory,
  }
  const bindingPath = path.join(canonicalUserDataDir, BINDING_FILE_NAME)
  await persistBinding(bindingPath, binding)

  const ownershipEpoch = randomBytes(32).toString('base64url')
  return Object.freeze({
    ownershipEpoch,
    assertExclusiveProcessOwnership: async () => {
      if (!options.assertControlPlaneOwnership()) return false
      try {
        const currentBridgeDirectory = await fs.realpath(bridgeDataDirectory)
        if (currentBridgeDirectory !== canonicalBridgeDataDirectory)
          return false
        const current = await readExactBinding(bindingPath)
        return (
          current.port === binding.port &&
          current.host === binding.host &&
          current.transport === binding.transport &&
          current.bridgeDataDirectory === binding.bridgeDataDirectory
        )
      } catch {
        return false
      }
    },
  })
}
