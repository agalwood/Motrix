import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FinalizeFilesystemAdapter } from '@core/plugin/finalize/filesystem-adapter'
import { z } from 'zod'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import type { NasFiles } from './files'
import { nasPairingFile } from './pairing-file'

const identity = (info: { dev: bigint; ino: bigint }) =>
  `${info.dev}:${info.ino}`
const intentSchema = z
  .object({
    version: z.literal(1),
    requested: z.string(),
    original: z.string(),
    quarantine: z.string().regex(/^\.motrix-remove-[0-9a-f-]{36}$/),
    rootIdentity: z.string().regex(/^\d+:\d+$/),
    artifactIdentity: z.string().regex(/^\d+:\d+$/),
  })
  .strict()

async function inspect(file: string) {
  return lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

/** Cleanup retries use a durable intent, including after isolation or restart.
 * Recovery requires another authorized deletion request; it never runs silently. */
export class NasFileRemover {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly files: NasFiles,
    private readonly policy: ServerDownloadPathPolicy,
    private readonly adapter: FinalizeFilesystemAdapter,
    private readonly intentsDirectory: string
  ) {}

  remove(
    candidate: string,
    expectedIdentity?: (selectedPath: string) => Promise<string | undefined>
  ): Promise<void> {
    if (!path.isAbsolute(candidate) || candidate.includes('\0'))
      return Promise.reject(new Error('Invalid NAS cleanup path'))
    const requested = path.resolve(candidate)
    const previous = this.pending.get(requested) ?? Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(() => this.perform(requested, expectedIdentity))
    this.pending.set(requested, current)
    void current
      .finally(() => {
        if (this.pending.get(requested) === current)
          this.pending.delete(requested)
      })
      .catch(() => {})
    return current
  }

  private async perform(
    requested: string,
    expectedIdentity?: (selectedPath: string) => Promise<string | undefined>
  ): Promise<void> {
    if (!this.adapter.openRemoval)
      throw new Error('Held NAS cleanup is unavailable')
    const journal = path.join(
      this.intentsDirectory,
      `${createHash('sha256').update(requested).digest('hex')}.json`
    )
    const storage = nasPairingFile(journal)
    const existing = await storage.read()
    let intent =
      existing === null ? null : intentSchema.parse(JSON.parse(existing))
    if (!intent) {
      const selected = await inspect(requested)
      if (!selected) return
      if (!selected.isFile() && !selected.isDirectory())
        throw new Error('Unsafe NAS cleanup target')
      const original = await realpath(requested)
      const parent = await lstat(path.dirname(original), { bigint: true })
      intent = {
        version: 1,
        requested,
        original,
        quarantine: `.motrix-remove-${randomUUID()}`,
        rootIdentity: identity(parent),
        artifactIdentity: identity(selected),
      }
    }
    if (
      intent.requested !== requested ||
      !path.isAbsolute(intent.original) ||
      path.resolve(intent.original) !== intent.original
    )
      throw new Error('Invalid NAS cleanup intent')
    const checkOwnership = async (selectedPath: string) => {
      const expected = await expectedIdentity?.(selectedPath)
      if (expected && expected !== intent.artifactIdentity)
        throw new Error('Task output changed')
    }
    const parentPath = path.dirname(intent.original)
    const quarantine = path.join(parentPath, intent.quarantine)
    const originalInfo = await inspect(intent.original)
    const quarantineInfo = await inspect(quarantine)
    if (originalInfo && quarantineInfo)
      throw new Error('Ambiguous NAS cleanup recovery')
    const selectedPath = quarantineInfo ? quarantine : intent.original
    const selected = quarantineInfo ?? originalInfo
    if (
      selected &&
      ((!selected.isFile() && !selected.isDirectory()) ||
        identity(selected) !== intent.artifactIdentity)
    )
      throw new Error('NAS cleanup target changed')
    const root = await this.adapter.openRoot(parentPath, intent.rootIdentity)
    try {
      if (!selected) {
        if (existing !== null) {
          await this.adapter.syncRoot(root)
          await unlink(journal)
        }
        return
      }
      await this.files.authorizeRemoval(selectedPath, this.policy)
      await checkOwnership(selectedPath)
      const artifact = await this.adapter.openRemoval(
        root,
        path.basename(selectedPath),
        intent.artifactIdentity
      )
      try {
        // Bind the path-based ACL result to the same parent and selected inode.
        await this.files.authorizeRemoval(selectedPath, this.policy)
        const currentParent = await lstat(parentPath, { bigint: true })
        const currentFile = await lstat(selectedPath, { bigint: true })
        if (
          identity(currentParent) !== intent.rootIdentity ||
          identity(currentFile) !== intent.artifactIdentity ||
          currentFile.isSymbolicLink()
        )
          throw new Error('NAS cleanup path changed during authorization')
        await checkOwnership(selectedPath)
        await storage.write(`${JSON.stringify(intent)}\n`)
        await this.adapter.removeOpened(
          artifact,
          intent.quarantine,
          quarantineInfo !== null
        )
        await unlink(journal)
      } finally {
        await this.adapter.close(artifact)
      }
    } finally {
      await this.adapter.close(root)
    }
  }
}
