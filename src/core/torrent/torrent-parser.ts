import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import {
  MAX_TORRENT_BASE64_SIZE,
  projectTorrentMeta,
} from '@shared/lib/torrent-meta'
import type { TorrentMeta } from '@shared/types/torrent'
import parseTorrent from 'parse-torrent'

const log = getLogger('torrent-parser')

export class TorrentParser {
  async parse(base64: string): Promise<TorrentMeta> {
    if (base64.length > MAX_TORRENT_BASE64_SIZE) {
      throw new AppError(
        ErrorCode.TorrentParseFailed,
        'Torrent file is too large'
      )
    }

    let parsed: Awaited<ReturnType<typeof parseTorrent>>
    try {
      const bytes = Buffer.from(base64, 'base64')
      parsed = await parseTorrent(new Uint8Array(bytes))
    } catch (err) {
      log.warn({ err }, 'failed to parse torrent')
      throw new AppError(
        ErrorCode.TorrentParseFailed,
        'Invalid torrent file',
        err
      )
    }

    const meta = projectTorrentMeta(parsed)

    if (meta.files.length === 0) {
      throw new AppError(
        ErrorCode.TorrentParseFailed,
        'Torrent contains no files'
      )
    }

    return meta
  }
}
