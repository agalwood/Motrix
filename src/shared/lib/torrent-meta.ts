import type { TorrentMeta } from '@shared/types/torrent'

// Product limits, not BitTorrent protocol limits. BEP 3/52 do not impose a
// universal metainfo file size cap. Base64 expands each 3 bytes to 4 characters.
export const MAX_TORRENT_BASE64_SIZE = 50 * 1024 * 1024
export const MAX_TORRENT_FILE_SIZE = (MAX_TORRENT_BASE64_SIZE / 4) * 3
// Leave room for the JSON envelope, selected files and per-task options.
export const DEFAULT_TORRENT_RPC_BODY_LIMIT_BYTES = 8 * 1024 * 1024
export const MAX_TORRENT_RPC_BODY_LIMIT_BYTES = 64 * 1024 * 1024

export interface ParsedTorrentMetaInput {
  name?: string
  infoHash?: string
  files?: Array<{ path: string; length: number }>
  comment?: string
  private?: boolean
}

function fileExtension(path: string): string {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot)
}

export function projectTorrentMeta(
  parsed: ParsedTorrentMetaInput
): TorrentMeta {
  const files = (parsed.files ?? []).map((file, index) => ({
    index,
    path: file.path,
    size: file.length,
    extension: fileExtension(file.path),
  }))

  return {
    name: parsed.name ?? 'Unknown',
    infoHash: parsed.infoHash ?? '',
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    files,
    comment: parsed.comment ?? null,
    isPrivate: parsed.private ?? false,
  }
}
