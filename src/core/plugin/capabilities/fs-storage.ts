// Plugin-owned storage area on disk, sandboxed to a per-plugin root directory.
// Path: <userDataDir>/plugins/<pluginId>/storage/
//
// Every user-supplied path goes through `resolveInsideSandbox` (Task 3) before
// any FS operation. Symlink escapes, parent traversal, and oversized paths are
// rejected at that layer.
//
// `write` is atomic: data is written to a sibling `.tmp-<uuid>` file inside the
// sandbox, then renamed onto the target. The tmp file is unlinked on rename
// failure so no partial files are left behind.
//
// Used by Task 18 factory via `fsStorageFor(pluginId)`, which sets
// `pluginStorageRoot = path.join(userDataDir, 'plugins', pluginId, 'storage')`.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  FsSandboxError,
  resolveDeepInsideSandbox,
  resolveInsideSandbox,
} from './fs-sandbox'

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FsStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FsStorageError'
  }
}

// ---------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------

export interface FsStorageStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
}

// ---------------------------------------------------------------------------
// FsStorageCapabilityHost
// ---------------------------------------------------------------------------

export class FsStorageCapabilityHost {
  private readonly root: string

  constructor(opts: { pluginStorageRoot: string }) {
    this.root = opts.pluginStorageRoot
  }

  // -------------------------------------------------------------------------
  // exists
  // -------------------------------------------------------------------------

  async exists(relPath: string): Promise<boolean> {
    try {
      const abs = await resolveInsideSandbox(this.root, relPath)
      await fs.access(abs)
      return true
    } catch (e: unknown) {
      if (e instanceof FsSandboxError) throw e
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return false
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // stat
  // -------------------------------------------------------------------------

  async stat(relPath: string): Promise<FsStorageStat> {
    const abs = await resolveInsideSandbox(this.root, relPath)
    let s: Awaited<ReturnType<typeof fs.stat>>
    try {
      s = await fs.stat(abs)
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        throw new FsStorageError(
          'plugin.fs.not_found',
          `plugin.fs.not_found: ${relPath}`
        )
      }
      throw e
    }
    return {
      size: s.size,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      mtimeMs: s.mtimeMs,
    }
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async read(
    relPath: string,
    opts?: { encoding?: 'utf8' | 'binary' }
  ): Promise<string | Uint8Array> {
    const encoding = opts?.encoding ?? 'utf8'
    const abs = await resolveInsideSandbox(this.root, relPath)
    try {
      if (encoding === 'utf8') {
        return await fs.readFile(abs, 'utf8')
      }
      const buf = await fs.readFile(abs)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        throw new FsStorageError(
          'plugin.fs.not_found',
          `plugin.fs.not_found: ${relPath}`
        )
      }
      if (err.code === 'EISDIR') {
        throw new FsStorageError(
          'plugin.fs.not_a_file',
          `plugin.fs.not_a_file: ${relPath} is a directory`
        )
      }
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // write (atomic)
  // -------------------------------------------------------------------------

  async write(
    relPath: string,
    data: string | Uint8Array,
    opts?: { overwrite?: boolean; encoding?: 'utf8' | 'binary' }
  ): Promise<void> {
    const overwrite = opts?.overwrite ?? true
    const target = await resolveInsideSandbox(this.root, relPath)

    // Overwrite guard — check before touching disk
    if (!overwrite) {
      try {
        await fs.access(target)
        // File exists: reject
        throw new FsStorageError(
          'plugin.fs.overwrite_required',
          `plugin.fs.overwrite_required: ${relPath} already exists`
        )
      } catch (e: unknown) {
        if (e instanceof FsStorageError) throw e
        const err = e as NodeJS.ErrnoException
        if (err.code !== 'ENOENT') throw e
        // ENOENT = target missing, proceed with write
      }
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(target), { recursive: true })

    // Atomic write: tmp file inside sandbox, then rename
    const tmpPath = await resolveInsideSandbox(
      this.root,
      `${relPath}.tmp-${randomUUID()}`
    )
    try {
      if (typeof data === 'string') {
        await fs.writeFile(tmpPath, data, 'utf8')
      } else {
        await fs.writeFile(tmpPath, data)
      }
      await fs.rename(tmpPath, target)
    } catch (e: unknown) {
      // best-effort: tmp may never have existed (resolveInsideSandbox failed early)
      // or may have been moved by rename
      try {
        await fs.unlink(tmpPath)
      } catch {
        // ignore
      }
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(relPath: string): Promise<{ deleted: boolean }> {
    const abs = await resolveInsideSandbox(this.root, relPath)
    try {
      await fs.unlink(abs)
      return { deleted: true }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return { deleted: false }
      if (err.code === 'EISDIR') {
        throw new FsStorageError(
          'plugin.fs.not_a_file',
          `plugin.fs.not_a_file: ${relPath} is a directory`
        )
      }
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  async rename(srcRel: string, dstRel: string): Promise<void> {
    const src = await resolveInsideSandbox(this.root, srcRel)
    // Destination may be inside a directory chain that doesn't exist yet,
    // so use the deep resolver (same as mkdir).
    const dst = await resolveDeepInsideSandbox(this.root, dstRel)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.rename(src, dst)
  }

  // -------------------------------------------------------------------------
  // mkdir
  // -------------------------------------------------------------------------

  async mkdir(relPath: string, opts?: { recursive?: boolean }): Promise<void> {
    const recursive = opts?.recursive ?? true
    // Use deep resolver: mkdir may create multiple non-existent path components
    const abs = await resolveDeepInsideSandbox(this.root, relPath)
    await fs.mkdir(abs, { recursive })
  }
}
