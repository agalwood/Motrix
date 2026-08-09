// fs.task capability — scoped, read-only-mostly access to the single file a
// download task is producing. Constructed with (saveDir, filePath); `filePath`
// is mutable across the task lifetime via `rename()`.
//
// Reader lifecycle: each openReader() call returns a FsTaskReader that streams
// the file starting at `offset`. Readers are tracked in a Set; a concurrent-
// reader cap prevents runaway accumulation. Each reader self-closes after
// `readerIdleMs` of inactivity — every read() call resets the idle timer.
// `disposeAllReaders()` is called by Plan C on hook exit and can also be used
// in tests to verify cleanup.
//
// Hash streaming: computeHash() uses a ReadStream + crypto.Hash update loop
// so file bytes never cross to the worker process.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertBasename } from './fs-sandbox'

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FsTaskError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FsTaskError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Spec §4 L1215: `stat(): Promise<{ size: number; mtime: number }>`.
// `isFile`/`isDirectory` are intentionally absent — fs.task is scoped to a
// single task file (`task.filePath`), and exposing isDirectory invites
// plugins to call stat on directories which isn't a supported operation in
// Phase 1A. `mtime` is the ms-epoch contract; the host field name was
// `mtimeMs` historically but plugin-API types already declared `mtime`.
export interface FsTaskStat {
  size: number
  mtime: number
}

export interface FsTaskReader {
  read(maxChunkSize: number): Promise<Uint8Array | null>
  close(): void
}

export interface FsTaskCapabilityHostOptions {
  saveDir: string
  filePath: string
  maxReaderChunkBytes?: number
  maxConcurrentReaders?: number
  readerIdleMs?: number
}

// ---------------------------------------------------------------------------
// Internal reader implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHUNK = 16 << 20 // 16 MB
const DEFAULT_MAX_READERS = 3
const DEFAULT_IDLE_MS = 60_000

interface ReaderState {
  handle: Awaited<ReturnType<typeof fs.open>>
  position: number
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

// ---------------------------------------------------------------------------
// FsTaskCapabilityHost
// ---------------------------------------------------------------------------

export class FsTaskCapabilityHost {
  private readonly saveDir: string
  private _filePath: string
  private readonly maxReaderChunkBytes: number
  private readonly maxConcurrentReaders: number
  private readonly readerIdleMs: number
  private readonly activeReaders = new Set<ReaderState>()

  constructor(opts: FsTaskCapabilityHostOptions) {
    this.saveDir = opts.saveDir
    this._filePath = opts.filePath
    this.maxReaderChunkBytes = opts.maxReaderChunkBytes ?? DEFAULT_MAX_CHUNK
    this.maxConcurrentReaders = opts.maxConcurrentReaders ?? DEFAULT_MAX_READERS
    this.readerIdleMs = opts.readerIdleMs ?? DEFAULT_IDLE_MS
  }

  get filePath(): string {
    return this._filePath
  }

  // -------------------------------------------------------------------------
  // stat
  // -------------------------------------------------------------------------

  async stat(): Promise<FsTaskStat> {
    const s = await fs.stat(this._filePath)
    return { size: s.size, mtime: s.mtimeMs }
  }

  // -------------------------------------------------------------------------
  // exists
  // -------------------------------------------------------------------------

  async exists(): Promise<boolean> {
    try {
      await fs.access(this._filePath)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // openReader
  // -------------------------------------------------------------------------

  openReader(opts: { offset?: number; length?: number }): FsTaskReader {
    if (this.activeReaders.size >= this.maxConcurrentReaders) {
      throw new FsTaskError(
        'plugin.fs.too_many_readers',
        `plugin.fs.too_many_readers: max ${this.maxConcurrentReaders} concurrent readers`
      )
    }

    const offset = opts.offset ?? 0
    const maxLength = opts.length ?? Infinity

    const state: ReaderState = {
      handle: null as unknown as Awaited<ReturnType<typeof fs.open>>,
      position: offset,
      closed: false,
      idleTimer: null,
    }

    // Lazily opened — we open on first read to keep openReader() sync
    let openPromise: Promise<void> | null = null
    let bytesDelivered = 0

    const maxChunk = this.maxReaderChunkBytes
    const idleMs = this.readerIdleMs
    const active = this.activeReaders
    const filePath = () => this._filePath

    this.activeReaders.add(state)

    const resetIdle = () => {
      if (state.idleTimer !== null) clearTimeout(state.idleTimer)
      state.idleTimer = setTimeout(() => {
        closeReader()
      }, idleMs)
    }

    const closeReader = () => {
      if (state.closed) return
      state.closed = true
      if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer)
        state.idleTimer = null
      }
      active.delete(state)
      // Close handle asynchronously — best effort
      if (state.handle) {
        state.handle.close().catch(() => {})
      }
    }

    const ensureOpen = (): Promise<void> => {
      if (openPromise !== null) return openPromise
      openPromise = fs.open(filePath(), 'r').then((h) => {
        state.handle = h
      })
      return openPromise
    }

    // Start idle timer immediately
    resetIdle()

    const reader: FsTaskReader = {
      async read(maxChunkSize: number): Promise<Uint8Array | null> {
        if (maxChunkSize > maxChunk) {
          throw new FsTaskError(
            'plugin.fs.chunk_too_large',
            `plugin.fs.chunk_too_large: maxChunkSize ${maxChunkSize} > limit ${maxChunk}`
          )
        }

        // Auto-closed by idle timer
        if (state.closed) return null

        // Length cap: refuse to read past the requested length
        if (maxLength !== Infinity && bytesDelivered >= maxLength) return null

        await ensureOpen()
        if (state.closed) return null

        const remaining =
          maxLength === Infinity
            ? maxChunkSize
            : Math.min(maxChunkSize, maxLength - bytesDelivered)
        // remaining is already capped by both maxChunkSize and the length cap above
        const toRead = remaining

        const buf = Buffer.allocUnsafe(toRead)
        const { bytesRead } = await state.handle.read(
          buf,
          0,
          toRead,
          state.position
        )

        resetIdle()

        if (bytesRead === 0) return null

        state.position += bytesRead
        bytesDelivered += bytesRead
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
      },

      close(): void {
        closeReader()
      },
    }

    return reader
  }

  // -------------------------------------------------------------------------
  // computeHash
  // -------------------------------------------------------------------------

  computeHash(alg: 'sha1' | 'sha256' | 'sha512'): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash(alg)
      const stream = createReadStream(this._filePath)
      stream.on('error', reject)
      stream.on('data', (chunk) => {
        hash.update(chunk as Buffer)
      })
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  async rename(newFilename: string): Promise<void> {
    // Throws FsSandboxError with code 'plugin.fs.invalid_basename' if not valid
    assertBasename(newFilename)

    const newPath = path.join(this.saveDir, newFilename)

    // Check target doesn't already exist
    try {
      await fs.access(newPath)
      // If we get here, file exists
      throw new FsTaskError(
        'plugin.fs.rename_target_exists',
        `plugin.fs.rename_target_exists: ${newFilename} already exists in saveDir`
      )
    } catch (e: unknown) {
      if (e instanceof FsTaskError) throw e
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') throw e
      // ENOENT = target doesn't exist, proceed
    }

    await fs.rename(this._filePath, newPath)
    this._filePath = newPath
  }

  // -------------------------------------------------------------------------
  // disposeAllReaders
  // -------------------------------------------------------------------------

  disposeAllReaders(): void {
    // Copy to array before iterating since close() mutates the Set
    for (const state of [...this.activeReaders]) {
      if (state.closed) continue
      state.closed = true
      if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer)
        state.idleTimer = null
      }
      this.activeReaders.delete(state)
      if (state.handle) {
        state.handle.close().catch(() => {})
      }
    }
  }
}
