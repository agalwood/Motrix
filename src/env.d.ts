declare module '*.css' {
  const content: string
  export default content
}

declare module 'parse-torrent' {
  interface TorrentFile {
    path: string
    name: string
    length: number
    offset: number
  }

  interface ParsedTorrent {
    name?: string
    infoHash?: string
    infoHashBuffer?: Uint8Array
    announce?: string[]
    urlList?: string[]
    files?: TorrentFile[]
    length?: number
    pieceLength?: number
    lastPieceLength?: number
    pieces?: string[]
    private?: boolean
    comment?: string
    created?: Date
    createdBy?: string
    info?: Record<string, unknown>
    infoBuffer?: Uint8Array
  }

  function parseTorrent(
    torrentId: string | Uint8Array | ParsedTorrent
  ): Promise<ParsedTorrent>

  export default parseTorrent
}

declare module 'bittorrent-peerid' {
  interface ParsedClient {
    client: string
    version?: string
  }
  function peerid(input: Buffer | string): ParsedClient
  export default peerid
}

interface Window {
  motrix: import('./preload/api').MotrixAPI
}
