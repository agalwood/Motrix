import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { type BInput, encode } from '@motrix/torrent'
import { MAX_TORRENT_FILE_SIZE } from '@shared/lib/torrent-meta'
import {
  type CreateTorrentRequest,
  createTorrentRequestSchema,
} from '@shared/schemas/create-torrent'

export { isValidPieceLength } from '@shared/schemas/create-torrent'
export interface CreateTorrentOptions extends Partial<CreateTorrentRequest> {
  sourcePath: string
}
export interface CreateTorrentHooks {
  onProgress?: (processed: number, total: number) => void
  signal?: AbortSignal
  picked?: { path: string; dev: number; ino: number }
  /** Hosts with per-user filesystem access must authorize descendants before listing or hashing. */
  authorizeEntry?: (path: string, kind: 'file' | 'directory') => Promise<void>
}
// Bound the path/stat snapshot even when a directory contains mostly empty files.
const MAX_SOURCE_ENTRIES = 100_000

interface SourceFile {
  absolute: string
  segments: string[]
  stat: Stats
}
export function suggestPieceLength(totalSize: number): number {
  if (totalSize <= 64 * 1024 ** 2) return 32 * 1024
  if (totalSize <= 512 * 1024 ** 2) return 128 * 1024
  if (totalSize <= 2 * 1024 ** 3) return 512 * 1024
  if (totalSize <= 8 * 1024 ** 3) return 2 * 1024 ** 2
  return 8 * 1024 ** 2
}
function compareSegments(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]))
    if (diff !== 0) return diff
  }
  return a.length - b.length
}
export async function collectSourceFiles(
  source: string,
  hooks: CreateTorrentHooks = {}
) {
  const { signal, picked } = hooks
  const sourcePath = await realpath(source)
  const base = await lstat(sourcePath)
  if (
    picked &&
    (sourcePath !== picked.path ||
      base.dev !== picked.dev ||
      base.ino !== picked.ino)
  )
    throw new Error('Selected source has been replaced')
  const name = path.basename(sourcePath)
  if (!name) throw new Error('A filesystem root cannot be a torrent source')
  const files: SourceFile[] = []
  const directories: SourceFile[] = []
  let totalSize = 0
  let visited = 0
  const visit = async (absolute: string, segments: string[], stat: Stats) => {
    signal?.throwIfAborted()
    if (++visited > MAX_SOURCE_ENTRIES)
      throw new Error('Too many source entries')
    if (stat.isSymbolicLink()) return
    if (path.basename(absolute).includes('\\'))
      throw new Error('Unrepresentable torrent path')
    if (stat.isDirectory()) {
      await hooks.authorizeEntry?.(absolute, 'directory')
      directories.push({ absolute, segments, stat })
      for await (const entry of await opendir(absolute)) {
        const child = path.join(absolute, entry.name)
        await visit(child, [...segments, entry.name], await lstat(child))
      }
    } else if (stat.isFile()) {
      await hooks.authorizeEntry?.(absolute, 'file')
      totalSize += stat.size
      if (!Number.isSafeInteger(totalSize))
        throw new Error('Source exceeds torrent creation limits')
      files.push({ absolute, segments, stat })
    }
  }
  await visit(sourcePath, base.isDirectory() ? [] : [name], base)
  files.sort((a, b) => compareSegments(a.segments, b.segments))
  return { name, files, directories, totalSize, directory: base.isDirectory() }
}
function unchanged(expected: Stats, actual: Stats) {
  return (
    actual.isFile() === expected.isFile() &&
    actual.isDirectory() === expected.isDirectory() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs
  )
}
export async function createTorrent(
  options: CreateTorrentOptions,
  hooks: CreateTorrentHooks = {}
) {
  const { sourcePath, ...raw } = options
  const settings = createTorrentRequestSchema.parse(raw)
  const { name, files, directories, totalSize, directory } =
    await collectSourceFiles(sourcePath, hooks)
  if (!files.length) throw new Error('Source contains no regular files')
  const pieceLength = settings.pieceLength ?? suggestPieceLength(totalSize)
  const pieceCount = Math.ceil(totalSize / pieceLength)
  if (pieceCount * 20 > MAX_TORRENT_FILE_SIZE)
    throw new Error('Piece table exceeds the metainfo size limit')
  const pieces = Buffer.alloc(pieceCount * 20)
  let hash = createHash('sha1')
  let filled = 0
  let index = 0
  let processed = 0
  const finishPiece = () => {
    pieces.set(hash.digest(), index++ * 20)
    hash = createHash('sha1')
    filled = 0
  }
  const scratch = Buffer.allocUnsafe(1024 ** 2)
  const changed = () => new Error('Torrent source changed while hashing')
  for (const file of files) {
    hooks.signal?.throwIfAborted()
    await hooks.authorizeEntry?.(file.absolute, 'file')
    if ((await realpath(file.absolute)) !== file.absolute) throw changed()
    const fd = await open(
      file.absolute,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    )
    try {
      if (!unchanged(file.stat, await fd.stat())) throw changed()
      let remaining = file.stat.size
      while (remaining > 0) {
        hooks.signal?.throwIfAborted()
        const { bytesRead } = await fd.read(
          scratch,
          0,
          Math.min(scratch.length, remaining),
          null
        )
        if (!bytesRead) throw changed()
        remaining -= bytesRead
        for (let offset = 0; offset < bytesRead; ) {
          const length = Math.min(pieceLength - filled, bytesRead - offset)
          hash.update(scratch.subarray(offset, offset + length))
          filled += length
          offset += length
          if (filled === pieceLength) finishPiece()
        }
        processed += bytesRead
        hooks.onProgress?.(processed, totalSize)
      }
      if (!unchanged(file.stat, await fd.stat())) throw changed()
    } finally {
      await fd.close()
    }
  }
  for (const file of [...files, ...directories]) {
    hooks.signal?.throwIfAborted()
    if (
      !unchanged(file.stat, await lstat(file.absolute)) ||
      (await realpath(file.absolute)) !== file.absolute
    )
      throw changed()
  }
  if (filled) finishPiece()
  const info: Record<string, BInput> = {
    name,
    'piece length': pieceLength,
    pieces,
  }
  if (directory)
    info.files = files.map((file) => ({
      length: file.stat.size,
      path: file.segments,
    }))
  else info.length = totalSize
  if (settings.private) info.private = 1
  const limits = { maxBytes: MAX_TORRENT_FILE_SIZE }
  const infoHash = createHash('sha1').update(encode(info, limits)).digest('hex')
  const meta: Record<string, BInput> = {
    info,
    'creation date': Math.floor(Date.now() / 1000),
  }
  if (settings.trackers.length) {
    meta.announce = settings.trackers[0]
    meta['announce-list'] = settings.trackers.map((url) => [url])
  }
  if (settings.webSeeds.length) meta['url-list'] = settings.webSeeds
  if (settings.comment) meta.comment = settings.comment
  const bytes = encode(meta, limits)
  hooks.onProgress?.(totalSize, totalSize)
  return {
    bytes,
    infoHash,
    name,
    totalSize,
    directory,
    fileCount: files.length,
    pieceCount,
    pieceLength,
  }
}
