import {
  DEFAULT_TORRENT_RPC_BODY_LIMIT_BYTES,
  MAX_TORRENT_RPC_BODY_LIMIT_BYTES,
} from '@shared/lib/torrent-meta'
import { z } from 'zod'

export const torrentRpcBodyLimitSchema = z
  .number()
  .int()
  .min(2 * 1024 * 1024)
  .max(MAX_TORRENT_RPC_BODY_LIMIT_BYTES)
  .multipleOf(1024 * 1024)
  .default(DEFAULT_TORRENT_RPC_BODY_LIMIT_BYTES)
