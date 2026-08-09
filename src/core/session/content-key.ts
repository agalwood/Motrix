import crypto from 'node:crypto'
import fs from 'node:fs'
import type { DownloadTask } from '@shared/types/task'
import parseTorrent from 'parse-torrent'

const URI_HASH_LENGTH = 16

export function computeUriHash(uris: string[]): string | null {
  if (uris.length === 0) return null
  const sorted = [...uris].sort()
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted))
    .digest('hex')
    .slice(0, URI_HASH_LENGTH)
}

// A .torrent file's infoHash never changes, so cache the path→hash mapping.
// This covers the residual case the task.infoHash fast-path misses: a BT task
// with a torrentMetaPath but no in-memory infoHash yet (the derived value is
// persisted to the DB row, not written back to the live task), which would
// otherwise re-read and re-parse the file on every 15s autosave.
const infoHashByTorrentPath = new Map<string, string>()

export async function deriveInfoHash(
  task: DownloadTask
): Promise<string | null> {
  if (task.infoHash) return task.infoHash
  if (!task.torrentMetaPath) return null
  const cached = infoHashByTorrentPath.get(task.torrentMetaPath)
  if (cached) return cached
  try {
    // Async read so the autosave pass does not block the event loop.
    const bytes = await fs.promises.readFile(task.torrentMetaPath)
    const parsed = await parseTorrent(new Uint8Array(bytes))
    const hash = parsed.infoHash ?? null
    if (hash) infoHashByTorrentPath.set(task.torrentMetaPath, hash)
    return hash
  } catch {
    return null
  }
}
