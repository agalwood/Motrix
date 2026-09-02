import type { TorrentMeta } from '@shared/types/torrent'

export const MAX_TORRENT_BASE64_SIZE = 50 * 1024 * 1024

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
