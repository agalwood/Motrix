import {
  type HashTable,
  normalizeBtih,
  parseMagnet,
  parseTorrent,
  type TorrentIdentity,
} from '@motrix/torrent'
import { AppError, ErrorCode } from '@shared/errors'
import { MAX_TORRENT_FILE_SIZE } from './torrent-meta'

export class UnsupportedTorrentError extends AppError {
  constructor(message: string) {
    super(ErrorCode.EngineFeatureUnavailable, message)
    this.name = 'UnsupportedTorrentError'
  }
}
export interface EngineTorrent {
  /** The current download engine uses the v1 swarm, including for hybrid torrents. */
  infoHash: string
  identity: TorrentIdentity
  name?: string
  announce: string[]
  private?: boolean
  comment?: string
  multiFile?: boolean
  files?: Array<{
    name: string
    path: string
    pathComponents: string[]
    length: number
    offset: number
    padding: boolean
  }>
  length?: number
  pieceLength?: number
  pieces?: HashTable
}
const pathDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new UnsupportedTorrentError(
      'Torrent length exceeds the engine safe integer range'
    )
  return Number(value)
}
/** Pure metadata-to-current-engine projection. It never changes the submitted bytes. */
export async function parseEngineTorrent(
  input: string | Uint8Array
): Promise<EngineTorrent> {
  if (typeof input === 'string') {
    const bare = normalizeBtih(input)
    const magnet = parseMagnet(bare ? `magnet:?xt=urn:btih:${bare}` : input)
    if (magnet.identity.kind === 'v2')
      throw new UnsupportedTorrentError(
        'The current engine does not support v2-only torrents'
      )
    return {
      identity: magnet.identity,
      infoHash: magnet.identity.sha1,
      name: magnet.name,
      announce: magnet.trackers,
    }
  }
  // Admit unsorted outer v1 metadata, but not an unsorted info dictionary:
  // the current aria2 engine re-encodes info before hashing it.
  const parsed = parseTorrent(input, {
    maxBytes: MAX_TORRENT_FILE_SIZE,
    allowUnsortedKeys: true,
  })
  if (parsed.identity.kind === 'v2' || !parsed.v1)
    throw new UnsupportedTorrentError(
      'The current engine does not support v2-only torrents'
    )
  if (!parsed.infoCanonical)
    throw new UnsupportedTorrentError(
      'The current engine cannot preserve noncanonical torrent info identity'
    )
  if (parsed.pieceLength > 0x7fffffff)
    throw new UnsupportedTorrentError(
      'Piece length exceeds the current engine limit'
    )
  const name = pathDecoder.decode(parsed.nameUtf8Bytes ?? parsed.nameBytes)
  const files = parsed.v1.files.map((file) => {
    if (file.symlinkPath)
      throw new UnsupportedTorrentError(
        'The current storage model does not support torrent symlinks'
      )
    // Keep component boundaries: a slash embedded in a component must not turn
    // into a seemingly safe directory when storage paths are validated.
    const pathComponents = [
      name,
      ...(file.pathUtf8 ?? file.path).map((part) => pathDecoder.decode(part)),
    ]
    if (parsed.v1?.multiFile && !file.path.length)
      throw new UnsupportedTorrentError(
        'The current engine requires padding file paths'
      )
    return {
      name: pathComponents.at(-1) ?? name,
      path: pathComponents.join('/'),
      pathComponents,
      length: safeNumber(file.length),
      offset: safeNumber(file.offset),
      padding: file.padding,
    }
  })
  return {
    identity: parsed.identity,
    infoHash: parsed.identity.sha1,
    name,
    announce: [...new Set(parsed.announceTiers.flat())],
    private: parsed.private,
    comment: parsed.comment,
    multiFile: parsed.v1.multiFile,
    files,
    length: safeNumber(parsed.v1.length),
    pieceLength: parsed.pieceLength,
    pieces: parsed.v1.pieces,
  }
}

export function torrentFileErrorKey(
  error: unknown
): 'task.add.unsupportedTorrent' | 'task.add.parseFailed' {
  return error instanceof UnsupportedTorrentError
    ? 'task.add.unsupportedTorrent'
    : 'task.add.parseFailed'
}
