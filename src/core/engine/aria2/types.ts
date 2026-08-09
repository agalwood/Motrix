// ─── aria2 RPC raw response types ──────────────────────────────
// All numeric values are strings (aria2 JSON-RPC convention).
// These types are internal to engine/aria2/ — never import from
// outside this directory.

export interface Aria2RawStatus {
  gid: string
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
  totalLength: string
  completedLength: string
  uploadLength: string
  downloadSpeed: string
  uploadSpeed: string
  connections: string
  numSeeders: string
  seeder: string
  pieceLength: string
  numPieces: string
  dir: string
  files: Aria2RawFile[]
  bittorrent?: Aria2RawBtInfo
  infoHash?: string
  errorCode?: string
  errorMessage?: string
  followedBy?: string[]
  following?: string
  belongsTo?: string
}

export interface Aria2RawFile {
  index: string
  path: string
  length: string
  completedLength: string
  selected: string
  uris: Aria2RawUri[]
}

export interface Aria2RawUri {
  uri: string
  status: 'used' | 'waiting'
}

export interface Aria2RawBtInfo {
  announceList: string[][]
  comment?: string
  creationDate?: string
  mode: 'single' | 'multi'
  info: { name: string }
}

export interface Aria2RawPeer {
  /** Peer endpoint IP (v4 or v6 string). */
  ip: string
  /** TCP port as a stringified integer (aria2 RPC convention). */
  port: string
  /**
   * Peer ID, percent-encoded by aria2 because the wire bytes are not
   * guaranteed to be UTF-8 safe. Decoders must walk %XX pairs to
   * reconstruct the 20-byte buffer.
   */
  peerId: string
  /** Hex-encoded bitfield reflecting the peer's piece progress. */
  bitfield: string
  /** Stringified bool: are WE choking this peer? */
  amChoking: 'true' | 'false'
  /** Stringified bool: is this peer choking us? */
  peerChoking: 'true' | 'false'
  /** Stringified bool: does this peer have the full torrent? */
  seeder: 'true' | 'false'
  /** Bytes/sec we receive from this peer. */
  downloadSpeed: string
  /** Bytes/sec we send to this peer. */
  uploadSpeed: string
}

export interface Aria2RawGlobalStat {
  downloadSpeed: string
  uploadSpeed: string
  numActive: string
  numWaiting: string
  numStopped: string
  numStoppedTotal: string
}

export interface Aria2Version {
  version: string
  enabledFeatures: string[]
}

export interface Aria2MethodCall {
  method: string
  params: unknown[]
}

// ─── aria2_motrix fork: SQLite3-Persistence RPC types ──────────

export interface Aria2HistoryFilter {
  status?: 'complete' | 'error' | 'removed'
  /** unix ms */
  since?: number
  /** unix ms */
  until?: number
}

export interface Aria2HistoryCount {
  /**
   * String-encoded count. The fork uses string to avoid the JSON 53-bit
   * integer limit on very large history tables.
   */
  count: string
}

export interface Aria2SearchQuery {
  status?: ('complete' | 'error' | 'removed')[]
  since?: number
  until?: number
  infoHash?: string
  pathLike?: string
  gidPrefix?: string
  minSize?: number
  maxSize?: number
}

export type Aria2RequeueStrategy =
  | 'bt-save-metadata-file'
  | 'local-metadata-file'
  | 'source-uri'
  | 'serialized-text'
  | 'synthesized-magnet'

export interface Aria2RequeueResult {
  gid: string
  strategy: Aria2RequeueStrategy
}
