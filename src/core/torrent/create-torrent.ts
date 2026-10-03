import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { type BencodeValue, bencodeEncode } from './bencode'

// BitTorrent v1 file creation (#459): walk the source, hash pieces with a
// streaming SHA-1, and assemble the metainfo dict. Pure node:fs + node:crypto
// — no new dependencies, and the event loop stays responsive because each
// read chunk yields via setImmediate.

export const PIECE_LENGTH_MIN = 16 * 1024
export const PIECE_LENGTH_MAX = 16 * 1024 * 1024

export interface CreateTorrentOptions {
  /** Absolute path to the source file or directory. */
  sourcePath: string
  /** Tracker announce URLs, one tier per entry (BEP-12). Empty → DHT-only. */
  trackers?: string[]
  /** Web seed (BEP-19) URLs. */
  webSeeds?: string[]
  comment?: string
  private?: boolean
  /** Power of two between PIECE_LENGTH_MIN and PIECE_LENGTH_MAX. */
  pieceLength?: number
}

export interface CreateTorrentResult {
  bytes: Uint8Array
  infoHash: string
  name: string
  totalSize: number
  fileCount: number
  pieceCount: number
  pieceLength: number
}

export interface CreateTorrentHooks {
  onProgress?: (processed: number, total: number) => void
}

interface SourceFile {
  /** Absolute path on disk. */
  absolute: string
  /** Path inside the torrent, split into segments (BEP-3 multi-file form). */
  segments: string[]
  size: number
}

export function suggestPieceLength(totalSize: number): number {
  if (totalSize <= 64 * 1024 * 1024) return 32 * 1024
  if (totalSize <= 512 * 1024 * 1024) return 128 * 1024
  if (totalSize <= 2 * 1024 * 1024 * 1024) return 512 * 1024
  if (totalSize <= 8 * 1024 * 1024 * 1024) return 2 * 1024 * 1024
  return 8 * 1024 * 1024
}

export function isValidPieceLength(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= PIECE_LENGTH_MIN &&
    value <= PIECE_LENGTH_MAX &&
    (value & (value - 1)) === 0
  )
}

export async function collectSourceFiles(
  sourcePath: string
): Promise<{ name: string; files: SourceFile[]; totalSize: number }> {
  const base = await stat(sourcePath)
  const name = path.basename(sourcePath)
  const files: SourceFile[] = []
  if (base.isFile()) {
    files.push({ absolute: sourcePath, segments: [name], size: base.size })
    return { name, files, totalSize: base.size }
  }
  if (!base.isDirectory()) {
    throw new TypeError(`unsupported source type: ${sourcePath}`)
  }
  const walk = async (absolute: string, segments: string[]) => {
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(absolute, entry.name)
      const childSegments = [...segments, entry.name]
      if (entry.isDirectory()) {
        await walk(child, childSegments)
      } else if (entry.isFile()) {
        const info = await stat(child)
        files.push({
          absolute: child,
          segments: childSegments,
          size: info.size,
        })
      }
    }
  }
  await walk(sourcePath, [])
  // BEP-3 multi-file info dicts are expected sorted by path. The canonical
  // order compares the path arrays element-wise, each segment by UTF-8 byte
  // order — joining with '/' would order 'a.txt' and 'a/b' differently.
  files.sort((a, b) => compareSegments(a.segments, b.segments))
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  return { name, files, totalSize }
}

export async function createTorrent(
  options: CreateTorrentOptions,
  hooks: CreateTorrentHooks = {}
): Promise<CreateTorrentResult> {
  if (
    options.pieceLength !== undefined &&
    !isValidPieceLength(options.pieceLength)
  ) {
    throw new TypeError(
      `pieceLength must be a power of two between ${PIECE_LENGTH_MIN} and ${PIECE_LENGTH_MAX}`
    )
  }
  const { name, files, totalSize } = await collectSourceFiles(
    options.sourcePath
  )
  if (files.length === 0) {
    throw new TypeError('source contains no files')
  }
  const pieceLength = options.pieceLength ?? suggestPieceLength(totalSize)

  const hash = createHash('sha1')
  let pieceCount = 0
  let pieceFill = 0
  let processed = 0
  let lastProgressYield = 0
  const READ_CHUNK = 1024 * 1024
  const pieceBuffer = Buffer.alloc(pieceLength)

  for (const file of files) {
    await hashFile(file.absolute, async (chunk) => {
      let offset = 0
      while (offset < chunk.length) {
        const take = Math.min(pieceLength - pieceFill, chunk.length - offset)
        chunk.copy(pieceBuffer, pieceFill, offset, offset + take)
        pieceFill += take
        offset += take
        processed += take
        if (pieceFill === pieceLength) {
          hash.update(pieceBuffer)
          pieceCount += 1
          pieceFill = 0
        }
      }
      if (processed - lastProgressYield >= READ_CHUNK) {
        lastProgressYield = processed
        hooks.onProgress?.(processed, totalSize)
        // Yield so the shared main-process event loop can breathe.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    })
  }
  if (pieceFill > 0) {
    hash.update(pieceBuffer.subarray(0, pieceFill))
    pieceCount += 1
  }
  hooks.onProgress?.(totalSize, totalSize)

  // A zero-byte source yields zero pieces; BEP-3 metainfo then carries a
  // zero-length 'pieces' string — hashing nothing would emit sha1('')
  // (da39…), 20 bytes of data no other client produces.
  const pieces =
    pieceCount === 0 ? new Uint8Array(0) : new Uint8Array(hash.digest())

  const info: Record<string, BencodeValue> = {
    name,
    'piece length': pieceLength,
    pieces,
  }
  if (files.length === 1) {
    info.length = files[0].size
  } else {
    // Walk seeds children with segments relative to the root, which is
    // exactly the BEP-3 multi-file `path` list (info.name holds the root).
    info.files = files.map((file) => ({
      length: file.size,
      path: file.segments,
    }))
  }

  const infoBytes = bencodeEncode(info)
  const infoHash = createHash('sha1').update(infoBytes).digest('hex')
  const meta: Record<string, BencodeValue> = {
    info,
    'creation date': Math.floor(Date.now() / 1000),
  }
  if (options.trackers && options.trackers.length > 0) {
    // BEP-3 requires a single announce; mirror the first tier there.
    meta.announce = options.trackers[0]
    meta['announce-list'] = options.trackers.map((url) => [url])
  }
  if (options.webSeeds && options.webSeeds.length > 0) {
    meta['url-list'] = [...options.webSeeds]
  }
  if (options.comment) meta.comment = options.comment
  if (options.private) meta.private = 1

  return {
    bytes: bencodeEncode(meta),
    infoHash,
    name,
    totalSize,
    fileCount: files.length,
    pieceCount,
    pieceLength,
  }
}

async function hashFile(
  absolute: string,
  onChunk: (chunk: Buffer) => Promise<void>
): Promise<void> {
  const stream = createReadStream(absolute, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    await onChunk(chunk as Buffer)
  }
}

function compareSegments(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const cmp = Buffer.compare(
      Buffer.from(a[i], 'utf8'),
      Buffer.from(b[i], 'utf8')
    )
    if (cmp !== 0) return cmp
  }
  return a.length - b.length
}
