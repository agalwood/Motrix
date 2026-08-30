import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BridgeDataDirLockRecoveryAuthority } from '@core/bridge/bridge-data-dir-lock'

const BINDING_VERSION = 1
const BINDING_FILE_NAME = '.motrix-server-bridge-owner.json'
const MAX_BINDING_BYTES = 1024
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

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

function fail(): Error {
  return new Error('server bridge process ownership unavailable')
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
    const before = await fs.lstat(filePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw fail()
    }
    if (process.platform !== 'win32' && (before.mode & 0o777n) !== 0o600n) {
      throw fail()
    }
    const flags = constants.O_RDONLY | NO_FOLLOW
    handle = await fs.open(filePath, flags)
    const during = await handle.stat({ bigint: true })
    if (!sameFile(before, during) || during.size > BigInt(MAX_BINDING_BYTES)) {
      throw fail()
    }
    const bytes = await handle.readFile()
    if (bytes.length === 0 || bytes.length > MAX_BINDING_BYTES) throw fail()
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isExactBinding(parsed) || !bytes.equals(serialize(parsed)))
      throw fail()
    const after = await fs.lstat(filePath, { bigint: true })
    if (!sameFile(during, after)) throw fail()
    return parsed
  } catch {
    throw fail()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function persistBinding(
  filePath: string,
  expected: BindingDocument
): Promise<void> {
  try {
    const handle = await fs.open(filePath, 'wx', 0o600)
    try {
      await handle.writeFile(serialize(expected))
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fail()
  }

  const actual = await readExactBinding(filePath)
  if (
    actual.port !== expected.port ||
    actual.host !== expected.host ||
    actual.transport !== expected.transport ||
    actual.bridgeDataDirectory !== expected.bridgeDataDirectory
  ) {
    throw fail()
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
    throw fail()
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
