import { extname } from 'node:path'
import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import type { TorrentFileInfo, TorrentMeta } from '@shared/types/torrent'
import parseTorrent from 'parse-torrent'

const log = getLogger('torrent-parser')

const MAX_BASE64_SIZE = 50 * 1024 * 1024

export class TorrentParser {
  async parse(base64: string): Promise<TorrentMeta> {
    if (base64.length > MAX_BASE64_SIZE) {
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

    const files: TorrentFileInfo[] = (parsed.files ?? []).map((f, i) => ({
      index: i,
      path: f.path,
      size: f.length,
      extension: extname(f.path) || '',
    }))

    if (files.length === 0) {
      throw new AppError(
        ErrorCode.TorrentParseFailed,
        'Torrent contains no files'
      )
    }

    return {
      name: parsed.name ?? 'Unknown',
      infoHash: parsed.infoHash ?? '',
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      files,
      comment: parsed.comment ?? null,
      isPrivate: parsed.private ?? false,
    }
  }
}
