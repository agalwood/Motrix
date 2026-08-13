import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'

export const MAX_PLUGIN_UPLOAD_BYTES = 5 * 1024 * 1024
export const DEFAULT_PLUGIN_UPLOAD_MAX_COUNT = 16
export const DEFAULT_PLUGIN_UPLOAD_TOTAL_BYTES = 32 * 1024 * 1024
export const DEFAULT_PLUGIN_UPLOAD_TTL_MS = 60 * 60 * 1000

const SHA256_RE = /^[0-9a-f]{64}$/
const UPLOAD_ID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UPLOAD_ID_RE = new RegExp(`^${UPLOAD_ID_SOURCE}$`)
const UPLOAD_FILE_RE = new RegExp(`^${UPLOAD_ID_SOURCE}\\.moext$`)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    'code' in cause &&
    (cause as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
}

export interface PluginUploadReference {
  uploadId: string
  fileHash: string
}

export interface PluginUploadStoreOptions {
  maxCount?: number
  maxTotalBytes?: number
  ttlMs?: number
  now?: () => number
}

interface UploadInventoryEntry {
  path: string
  size: number
  modifiedAt: number
}

export class PluginUploadStore {
  private readonly maxCount: number
  private readonly maxTotalBytes: number
  private readonly ttlMs: number
  private readonly now: () => number
  private operationQueue: Promise<void> = Promise.resolve()
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly uploadsDir: string,
    options: PluginUploadStoreOptions = {}
  ) {
    this.maxCount = options.maxCount ?? DEFAULT_PLUGIN_UPLOAD_MAX_COUNT
    this.maxTotalBytes =
      options.maxTotalBytes ?? DEFAULT_PLUGIN_UPLOAD_TOTAL_BYTES
    this.ttlMs = options.ttlMs ?? DEFAULT_PLUGIN_UPLOAD_TTL_MS
    this.now = options.now ?? Date.now
    assertPositiveInteger(this.maxCount, 'maxCount')
    assertPositiveInteger(this.maxTotalBytes, 'maxTotalBytes')
    assertPositiveInteger(this.ttlMs, 'ttlMs')
  }

  async put(
    bytes: Buffer,
    claimedHash: string | undefined,
    originalName: string
  ): Promise<PluginUploadReference> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLUGIN_UPLOAD_BYTES) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.upload_size_invalid'
      )
    }
    if (!originalName.toLowerCase().endsWith('.moext')) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.upload_extension_invalid'
      )
    }
    const fileHash = sha256(bytes)
    if (
      claimedHash !== undefined &&
      (!SHA256_RE.test(claimedHash) || claimedHash !== fileHash)
    ) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.local_file_hash_mismatch'
      )
    }

    return this.exclusive(async () => {
      await mkdir(this.uploadsDir, { recursive: true })
      const inventory = await this.cleanupAndInventory()
      const totalBytes = inventory.reduce((sum, entry) => sum + entry.size, 0)
      if (
        inventory.length >= this.maxCount ||
        totalBytes + bytes.byteLength > this.maxTotalBytes
      ) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.upload_quota_exceeded'
        )
      }

      const uploadId = randomUUID()
      await writeFile(this.pathFor(uploadId), bytes, {
        flag: 'wx',
        mode: 0o600,
      })
      await this.cleanupAndInventory()
      return { uploadId, fileHash }
    })
  }

  async resolve(uploadId: string, expectedHash: string): Promise<string> {
    if (!UPLOAD_ID_RE.test(uploadId) || !SHA256_RE.test(expectedHash)) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.upload_reference_invalid'
      )
    }

    return this.exclusive(async () => {
      await this.cleanupAndInventory()
      const uploadPath = this.pathFor(uploadId)
      let bytes: Buffer
      try {
        bytes = await readFile(uploadPath)
      } catch (cause) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.upload_not_found',
          cause
        )
      }
      if (
        bytes.byteLength > MAX_PLUGIN_UPLOAD_BYTES ||
        sha256(bytes) !== expectedHash
      ) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.local_file_hash_mismatch'
        )
      }
      return uploadPath
    })
  }

  async remove(uploadId: string): Promise<void> {
    if (!UPLOAD_ID_RE.test(uploadId)) return
    await this.exclusive(async () => {
      await rm(this.pathFor(uploadId), { force: true })
      await this.cleanupAndInventory()
    })
  }

  /** Remove retained upload packages whose TTL elapsed. */
  async cleanupExpired(): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.inventory()
      const after = await this.cleanupAndInventory(before)
      return before.length - after.length
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.cleanupTimer = undefined
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async cleanupAndInventory(
    current?: readonly UploadInventoryEntry[]
  ): Promise<UploadInventoryEntry[]> {
    const inventory = current ?? (await this.inventory())
    const cutoff = this.now() - this.ttlMs
    const retained: UploadInventoryEntry[] = []
    for (const entry of inventory) {
      if (entry.modifiedAt <= cutoff) {
        await rm(entry.path, { force: true })
      } else {
        retained.push(entry)
      }
    }
    this.scheduleCleanup(retained)
    return retained
  }

  private scheduleCleanup(inventory: readonly UploadInventoryEntry[]): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.cleanupTimer = undefined
    if (this.disposed) return
    const nextExpiry = Math.min(
      ...inventory.map((entry) => entry.modifiedAt + this.ttlMs)
    )
    if (!Number.isFinite(nextExpiry)) return
    const delay = Math.max(1, Math.min(2_147_483_647, nextExpiry - this.now()))
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined
      void this.cleanupExpired().catch(() => undefined)
    }, delay)
    this.cleanupTimer.unref()
  }

  private async inventory(): Promise<UploadInventoryEntry[]> {
    let directoryEntries: Dirent[]
    try {
      directoryEntries = await readdir(this.uploadsDir, {
        withFileTypes: true,
      })
    } catch (cause) {
      if (isMissingFile(cause)) return []
      throw cause
    }

    const inventory: UploadInventoryEntry[] = []
    for (const entry of directoryEntries) {
      if (!entry.isFile() || !UPLOAD_FILE_RE.test(entry.name)) continue
      const uploadPath = path.join(this.uploadsDir, entry.name)
      try {
        const metadata = await stat(uploadPath)
        inventory.push({
          path: uploadPath,
          size: metadata.size,
          modifiedAt: metadata.mtimeMs,
        })
      } catch (cause) {
        if (!isMissingFile(cause)) throw cause
      }
    }
    return inventory
  }

  private pathFor(uploadId: string): string {
    return path.join(this.uploadsDir, `${uploadId}.moext`)
  }
}
