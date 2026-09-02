import {
  MAX_TORRENT_BASE64_SIZE,
  projectTorrentMeta,
} from '@shared/lib/torrent-meta'
import type { TorrentMeta } from '@shared/types/torrent'
import parseTorrent from 'parse-torrent'

export interface ParsedTorrentFile {
  name: string
  base64: string
  meta: TorrentMeta
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
  }
  return btoa(chunks.join(''))
}

export async function parseTorrentFile(
  bytes: Uint8Array
): Promise<TorrentMeta> {
  const encodedSize = Math.ceil(bytes.byteLength / 3) * 4
  if (encodedSize > MAX_TORRENT_BASE64_SIZE) {
    throw new Error('Torrent file is too large')
  }

  const meta = projectTorrentMeta(await parseTorrent(bytes))
  if (meta.files.length === 0) {
    throw new Error('Torrent contains no files')
  }
  return meta
}

export async function readTorrentFile(file: File): Promise<ParsedTorrentFile> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    name: file.name,
    base64: bytesToBase64(bytes),
    meta: await parseTorrentFile(bytes),
  }
}
