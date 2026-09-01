import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type BridgeDataDirLockHandle,
  withBridgeDataDirLock,
} from './bridge-data-dir-lock'
import type {
  ExtensionPairingProjection,
  ExtensionPairingProjectionStore,
  ExtensionPairingProjectionStoreSnapshot,
} from './extension-pairing-projection'

const PROJECTION_DOCUMENT_VERSION = 1
const MAX_PROJECTION_DOCUMENT_BYTES = 2 * 1024 * 1024
const MISSING_FINGERPRINT = 'missing'

export const FileExtensionPairingProjectionStoreError = Object.freeze({
  Rejected: 'extension-pairing-projection file rejected',
  Conflict: 'extension-pairing-projection file conflict',
} as const)

type StoreFailureKind = 'rejected' | 'conflict'

class StoreFailure extends Error {
  constructor(readonly kind: StoreFailureKind) {
    super(
      kind === 'conflict'
        ? FileExtensionPairingProjectionStoreError.Conflict
        : FileExtensionPairingProjectionStoreError.Rejected
    )
  }
}

interface ProjectionDocument {
  readonly version: typeof PROJECTION_DOCUMENT_VERSION
  readonly revision: number
  readonly records: unknown[]
}

interface ReadResult {
  readonly fingerprint: string
  readonly document: ProjectionDocument | null
}

interface LoadedClaim {
  readonly fingerprint: string
  readonly revision: number
  readonly valid: boolean
}

/**
 * Remove a crash-residual projection writer lock while the caller owns the
 * entire bridge data root. Unknown file types, links, permissions, or path
 * replacement are preserved and rejected; no age/PID heuristic is used.
 */
export async function recoverExtensionPairingProjectionWriterLock(
  filePath: string,
  dataDirLock: BridgeDataDirLockHandle
): Promise<void> {
  const directory = path.dirname(filePath)
  return withBridgeDataDirLock(dataDirLock, directory, async () => {
    const lockPath = `${filePath}.lock`
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await fs.lstat(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(FileExtensionPairingProjectionStoreError.Rejected)
    }
    if (
      process.platform === 'win32' ||
      constants.O_NOFOLLOW === undefined ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600
    ) {
      throw new Error(FileExtensionPairingProjectionStoreError.Rejected)
    }

    let handle: fs.FileHandle | null = null
    try {
      handle = await fs.open(
        lockPath,
        constants.O_RDONLY | constants.O_NOFOLLOW
      )
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.nlink !== 1
      ) {
        throw new Error(FileExtensionPairingProjectionStoreError.Rejected)
      }
      await handle.close()
      handle = null

      const current = await fs.lstat(lockPath)
      if (current.dev !== before.dev || current.ino !== before.ino) {
        throw new Error(FileExtensionPairingProjectionStoreError.Rejected)
      }
      await fs.unlink(lockPath)
      await syncParentDirectory(directory)
    } catch {
      throw new Error(FileExtensionPairingProjectionStoreError.Rejected)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  })
}

/**
 * A bounded, fail-closed projection store.
 *
 * Every save holds a sibling exclusive lock, re-reads the target without
 * following a final symlink, and compares both the durable revision and the
 * exact bytes seen by this instance's last successful load/save. The content
 * fingerprint prevents a same-revision external edit from being overwritten.
 * A crash may leave the lock file behind; that intentionally blocks future
 * writers until the bridge data directory is recovered rather than guessing
 * whether an unknown writer is still active.
 */
export class FileExtensionPairingProjectionStore
  implements ExtensionPairingProjectionStore
{
  private loadedClaim: LoadedClaim | null = null

  constructor(private readonly filePath: string) {}

  async load(): Promise<ExtensionPairingProjectionStoreSnapshot> {
    try {
      // A crashed writer may have published the target and died before
      // releasing its sibling lock. Treat that state as unavailable even for
      // reads: consuming the target would let startup present a projection
      // whose transaction outcome is unknown.
      await assertWriterLockMissing(this.filePath)
      const result = await readBoundedDocument(this.filePath)
      if (result.document === null) {
        this.loadedClaim = {
          fingerprint: result.fingerprint,
          revision: -1,
          valid: false,
        }
        return { revision: -1, records: null }
      }
      this.loadedClaim = {
        fingerprint: result.fingerprint,
        revision: result.document.revision,
        valid: true,
      }
      return {
        revision: result.document.revision,
        records: result.document.records,
      }
    } catch (error) {
      this.loadedClaim = {
        fingerprint: 'rejected',
        revision: -1,
        valid: false,
      }
      throw publicFailure(error)
    }
  }

  async save(
    next: readonly ExtensionPairingProjection[],
    expectedRevision: number
  ): Promise<number> {
    try {
      return await this.saveChecked(next, expectedRevision)
    } catch (error) {
      throw publicFailure(error)
    }
  }

  private async saveChecked(
    next: readonly ExtensionPairingProjection[],
    expectedRevision: number
  ): Promise<number> {
    if (
      !validRevision(expectedRevision) ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new StoreFailure('rejected')
    }
    const claim = this.loadedClaim
    if (claim === null || !claim.valid || claim.revision !== expectedRevision) {
      throw new StoreFailure('conflict')
    }

    const nextRevision = expectedRevision + 1
    const document: ProjectionDocument = {
      version: PROJECTION_DOCUMENT_VERSION,
      revision: nextRevision,
      records: [...next],
    }
    let serialized: Buffer
    try {
      serialized = Buffer.from(JSON.stringify(document, null, 2), 'utf-8')
    } catch {
      throw new StoreFailure('rejected')
    }
    if (serialized.byteLength > MAX_PROJECTION_DOCUMENT_BYTES) {
      throw new StoreFailure('rejected')
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const lockPath = `${this.filePath}.lock`
    let lock: fs.FileHandle
    try {
      lock = await fs.open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StoreFailure('conflict')
      }
      throw error
    }

    let result: number | undefined
    let primaryError: unknown
    try {
      const current = await readBoundedDocument(this.filePath)
      if (
        current.document === null ||
        current.document.revision !== expectedRevision ||
        current.fingerprint !== claim.fingerprint
      ) {
        throw new StoreFailure('conflict')
      }

      await replaceDurably(this.filePath, serialized)
      this.loadedClaim = {
        fingerprint: fingerprint(serialized),
        revision: nextRevision,
        valid: true,
      }
      result = nextRevision
    } catch (error) {
      primaryError = error
    }
    try {
      await lock.close()
      await fs.unlink(lockPath)
    } catch (cleanupError) {
      primaryError ??= cleanupError
    }
    if (primaryError !== undefined) throw primaryError
    if (result === undefined) throw new StoreFailure('rejected')
    return result
  }
}

async function assertWriterLockMissing(filePath: string): Promise<void> {
  try {
    await fs.lstat(`${filePath}.lock`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new StoreFailure('conflict')
}

async function readBoundedDocument(filePath: string): Promise<ReadResult> {
  let metadata: Stats
  try {
    metadata = await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        fingerprint: MISSING_FINGERPRINT,
        document: {
          version: PROJECTION_DOCUMENT_VERSION,
          revision: 0,
          records: [],
        },
      }
    }
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new StoreFailure('rejected')
  }
  if (metadata.size > MAX_PROJECTION_DOCUMENT_BYTES) {
    throw new StoreFailure('rejected')
  }

  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollow)
  try {
    const openedMetadata = await handle.stat()
    if (
      !openedMetadata.isFile() ||
      openedMetadata.size > MAX_PROJECTION_DOCUMENT_BYTES
    ) {
      throw new StoreFailure('rejected')
    }
    const buffer = Buffer.allocUnsafe(MAX_PROJECTION_DOCUMENT_BYTES + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_PROJECTION_DOCUMENT_BYTES) {
      throw new StoreFailure('rejected')
    }
    const raw = buffer.subarray(0, offset)
    return {
      fingerprint: fingerprint(raw),
      document: parseDocument(raw),
    }
  } finally {
    await handle.close()
  }
}

function parseDocument(raw: Buffer): ProjectionDocument | null {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf-8'))
  } catch {
    return null
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !hasOnlyKeys(value as Record<string, unknown>, [
      'records',
      'revision',
      'version',
    ])
  ) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== PROJECTION_DOCUMENT_VERSION ||
    !validRevision(candidate.revision) ||
    !Array.isArray(candidate.records)
  ) {
    return null
  }
  return {
    version: PROJECTION_DOCUMENT_VERSION,
    revision: candidate.revision,
    records: candidate.records,
  }
}

async function replaceDurably(
  filePath: string,
  content: Buffer
): Promise<void> {
  await rejectFinalSymlink(filePath)
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  const noFollow = constants.O_NOFOLLOW ?? 0
  let temporary: fs.FileHandle | null = null
  let renamed = false
  try {
    temporary = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    )
    await temporary.writeFile(content)
    await temporary.sync()
    await temporary.close()
    temporary = null
    await rejectFinalSymlink(filePath)
    await fs.rename(temporaryPath, filePath)
    renamed = true
    await syncParentDirectory(directory)
  } finally {
    if (temporary !== null) await temporary.close().catch(() => undefined)
    if (!renamed) await fs.unlink(temporaryPath).catch(() => undefined)
  }
}

async function rejectFinalSymlink(filePath: string): Promise<void> {
  try {
    const metadata = await fs.lstat(filePath)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new StoreFailure('rejected')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function syncParentDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function fingerprint(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('base64url')
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  )
}

function publicFailure(error: unknown): Error {
  if (error instanceof StoreFailure) return new Error(error.message)
  return new Error(FileExtensionPairingProjectionStoreError.Rejected)
}
