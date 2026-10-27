import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { BtVerificationResult } from '@shared/schemas/bt-storage'
import parseTorrent from 'parse-torrent'
import { parseBtFileLayout, UnsafeTorrentPathError } from './bt-storage-layout'

const READ_BYTES = 1024 * 1024
const MAX_EXAMPLES = 10

export interface VerifyBtFilesInput {
  metadata: Uint8Array
  /** Exact payload file or torrent root directory, not its parent. */
  payloadPath: string
  selectedFiles?: readonly number[]
  signal?: AbortSignal
  onProgress?: (checkedPieces: number, totalPieces: number) => void
}

/** Hashes local v1 torrent pieces without opening a writer or a network session. */
export async function verifyBtFiles(
  input: VerifyBtFilesInput
): Promise<BtVerificationResult> {
  input.signal?.throwIfAborted()
  const [layout, parsed] = await Promise.all([
    parseBtFileLayout(input.metadata),
    parseTorrent(input.metadata),
  ])
  const files = parsed.files ?? []
  const pieces = parsed.pieces ?? []
  const pieceLength = parsed.pieceLength ?? 0
  const totalLength = parsed.length ?? -1
  if (
    !Number.isSafeInteger(pieceLength) ||
    pieceLength <= 0 ||
    !Number.isSafeInteger(totalLength) ||
    totalLength < 0 ||
    pieces.length !== Math.ceil(totalLength / pieceLength) ||
    pieces.some((hash) => !/^[a-f0-9]{40}$/i.test(hash))
  )
    throw new UnsafeTorrentPathError('Invalid torrent piece table')

  const selected = new Set(
    input.selectedFiles?.length
      ? input.selectedFiles
      : files.map((_, index) => index)
  )
  if ([...selected].some((index) => !Number.isInteger(index) || !files[index]))
    throw new UnsafeTorrentPathError('Invalid torrent file selection')
  if (!path.isAbsolute(input.payloadPath) || input.payloadPath.includes('\0'))
    throw new UnsafeTorrentPathError('The payload path must be absolute')

  const root = path.resolve(input.payloadPath)
  const parent = await realpath(path.dirname(root))
  const payload = path.join(parent, path.basename(root))
  const names = new Set<string>()
  let offset = 0
  const ranges: Array<[number, number]> = []
  const entries = files.map((file, index) => {
    if (
      !Number.isSafeInteger(file.length) ||
      file.length < 0 ||
      file.offset !== offset
    )
      throw new UnsafeTorrentPathError('Invalid torrent file lengths')
    offset += file.length
    if (!Number.isSafeInteger(offset))
      throw new UnsafeTorrentPathError('Torrent length exceeds the safe range')
    const relative = layout.files[index].pathInsideRoot
    const key = (relative ?? path.basename(payload))
      .normalize('NFC')
      .toLowerCase()
    if (names.has(key))
      throw new UnsafeTorrentPathError('Overlapping torrent paths')
    names.add(key)
    if (selected.has(index) && file.length) {
      const start = Math.floor(file.offset / pieceLength)
      const end = Math.floor((offset - 1) / pieceLength)
      const last = ranges.at(-1)
      if (last && start <= last[1] + 1) last[1] = end
      else ranges.push([start, end])
    }
    return {
      ...file,
      relative,
      absolute: relative === null ? payload : path.join(payload, relative),
    }
  })
  if (offset !== totalLength)
    throw new UnsafeTorrentPathError('Invalid total torrent length')
  for (const name of names) {
    const parts = name.split(path.sep)
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join(path.sep)))
        throw new UnsafeTorrentPathError('Overlapping torrent paths')
  }

  const result: BtVerificationResult = {
    complete: false,
    checkedPieces: 0,
    totalPieces: ranges.reduce(
      (count, [start, end]) => count + end - start + 1,
      0
    ),
    validPieces: 0,
    missingFiles: [],
    invalidFiles: [],
  }
  const addExample = (list: string[], name: string) => {
    if (list.length < MAX_EXAMPLES && !list.includes(name)) list.push(name)
  }
  const stamps = new Map<string, string>()
  const stamp = (s: Awaited<ReturnType<typeof statFile>>) =>
    `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  const missing = (error: unknown) =>
    ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
  const inspect = async (entry: (typeof entries)[number]) => {
    // Resolve user-selected parent aliases once; refuse links inside the payload.
    const components =
      entry.relative === null ? [] : entry.relative.split(path.sep).slice(0, -1)
    let directory = payload
    if (layout.multiFile) {
      for (const component of ['', ...components]) {
        if (component) directory = path.join(directory, component)
        const s = await lstat(directory)
        if (!s.isDirectory() || s.isSymbolicLink())
          throw new UnsafeTorrentPathError(
            'Torrent payload contains an unsafe directory'
          )
      }
    }
    const named = await statFile(entry.absolute)
    if (!named.isFile() || named.isSymbolicLink())
      throw new UnsafeTorrentPathError('Torrent payload is not a regular file')
    if ((await realpath(entry.absolute)) !== entry.absolute)
      throw new UnsafeTorrentPathError('Torrent payload path changed')
    return named
  }

  // aria2 opens existing unselected files too and can truncate oversized ones.
  // Check the whole declared layout, while only hashing selected pieces.
  const inspectLayout = async (initial: boolean) => {
    for (const [index, entry] of entries.entries()) {
      input.signal?.throwIfAborted()
      const previous = stamps.get(entry.absolute)
      try {
        const current = await inspect(entry)
        if (current.size !== BigInt(entry.length))
          addExample(result.invalidFiles, entry.path)
        if (initial) stamps.set(entry.absolute, stamp(current))
        else if (previous !== stamp(current))
          addExample(result.invalidFiles, entry.path)
      } catch (error) {
        if (!missing(error)) throw error
        if (selected.has(index)) addExample(result.missingFiles, entry.path)
        else if (previous !== undefined)
          addExample(result.invalidFiles, entry.path)
      }
    }
  }
  await inspectLayout(true)
  if (result.missingFiles.length || result.invalidFiles.length) return result

  const buffer = Buffer.allocUnsafe(READ_BYTES)
  let current:
    | { index: number; handle: Awaited<ReturnType<typeof open>> }
    | undefined
  const close = async () => {
    const opened = current
    current = undefined
    await opened?.handle.close()
  }
  const read = async (
    index: number,
    position: number,
    length: number,
    hash: ReturnType<typeof createHash>
  ) => {
    const entry = entries[index]
    try {
      if (current?.index !== index) {
        await close()
        const named = await inspect(entry)
        if (named.size !== BigInt(entry.length)) {
          addExample(result.invalidFiles, entry.path)
          return false
        }
        const handle = await open(
          entry.absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        current = { index, handle }
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || stamp(named) !== stamp(opened))
          throw new Error('Torrent file changed while opening')
        const previous = stamps.get(entry.absolute)
        if (previous && previous !== stamp(opened))
          throw new Error('Torrent file changed while checking')
        stamps.set(entry.absolute, stamp(opened))
      }
      let remaining = length
      while (remaining > 0) {
        input.signal?.throwIfAborted()
        const { bytesRead } = await current.handle.read(
          buffer,
          0,
          Math.min(buffer.length, remaining),
          position
        )
        if (bytesRead === 0) {
          addExample(result.invalidFiles, entry.path)
          return false
        }
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
        remaining -= bytesRead
      }
      return true
    } catch (error) {
      if (!missing(error)) throw error
      addExample(result.missingFiles, entry.path)
      return false
    }
  }

  let lastProgress = 0
  try {
    for (const [start, end] of ranges) {
      let fileIndex = entries.findIndex(
        (entry) => entry.offset + entry.length > start * pieceLength
      )
      for (let piece = start; piece <= end; piece++) {
        input.signal?.throwIfAborted()
        const hash = createHash('sha1')
        let position = piece * pieceLength
        const endOffset = Math.min(position + pieceLength, totalLength)
        let valid = true
        while (position < endOffset) {
          const entry = entries[fileIndex]
          if (entry.offset + entry.length <= position) {
            fileIndex++
            continue
          }
          const length =
            Math.min(endOffset, entry.offset + entry.length) - position
          if (!(await read(fileIndex, position - entry.offset, length, hash)))
            valid = false
          position += length
        }
        result.checkedPieces++
        if (valid && hash.digest('hex') === pieces[piece].toLowerCase())
          result.validPieces++
        if (Date.now() - lastProgress >= 200) {
          input.onProgress?.(result.checkedPieces, result.totalPieces)
          lastProgress = Date.now()
        }
      }
    }
    await close()
    await inspectLayout(false)
    input.signal?.throwIfAborted()
    result.complete =
      result.validPieces === result.totalPieces &&
      !result.missingFiles.length &&
      !result.invalidFiles.length
    input.onProgress?.(result.checkedPieces, result.totalPieces)
    return result
  } finally {
    await close()
  }
}

function statFile(filePath: string) {
  return lstat(filePath, { bigint: true })
}
