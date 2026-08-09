export interface TorrentFileInfo {
  /** 0-based index. Engine adapters handle their own conventions (aria2 adds +1 for select-file). */
  index: number
  /** Relative file path within the torrent */
  path: string
  /** File size in bytes */
  size: number
  /** File extension with dot, e.g. ".mp4" */
  extension: string
}

export interface TorrentMeta {
  name: string
  infoHash: string
  totalSize: number
  files: TorrentFileInfo[]
  comment: string | null
  isPrivate: boolean
}
