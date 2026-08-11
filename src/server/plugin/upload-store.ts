import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'

export const MAX_PLUGIN_UPLOAD_BYTES = 5 * 1024 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/
const UPLOAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface PluginUploadReference {
  uploadId: string
  fileHash: string
}

export class PluginUploadStore {
  constructor(private readonly uploadsDir: string) {}

  async put(
    bytes: Buffer,
    claimedHash: string,
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
    if (!SHA256_RE.test(claimedHash) || claimedHash !== fileHash) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.local_file_hash_mismatch'
      )
    }
    await mkdir(this.uploadsDir, { recursive: true })
    const uploadId = randomUUID()
    await writeFile(this.pathFor(uploadId), bytes, {
      flag: 'wx',
      mode: 0o600,
    })
    return { uploadId, fileHash }
  }

  async resolve(uploadId: string, expectedHash: string): Promise<string> {
    if (!UPLOAD_ID_RE.test(uploadId) || !SHA256_RE.test(expectedHash)) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.upload_reference_invalid'
      )
    }
    let bytes: Buffer
    try {
      bytes = await readFile(this.pathFor(uploadId))
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
    return this.pathFor(uploadId)
  }

  async remove(uploadId: string): Promise<void> {
    if (!UPLOAD_ID_RE.test(uploadId)) return
    await rm(this.pathFor(uploadId), { force: true })
  }

  private pathFor(uploadId: string): string {
    return path.join(this.uploadsDir, `${uploadId}.moext`)
  }
}
