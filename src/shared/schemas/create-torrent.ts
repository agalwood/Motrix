import { z } from 'zod'

export const CREATE_TORRENT_URL_LIMIT = 64
export const CREATE_TORRENT_COMMENT_MAX = 2048
export const PIECE_LENGTH_MIN = 16 * 1024
export const PIECE_LENGTH_MAX = 16 * 1024 * 1024
export function isValidPieceLength(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= PIECE_LENGTH_MIN &&
    value <= PIECE_LENGTH_MAX &&
    (value & (value - 1)) === 0
  )
}

const url = (protocols: string[]) =>
  z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const parsed = new URL(value)
        return !!parsed.hostname && protocols.includes(parsed.protocol)
      } catch {
        return false
      }
    })
export const trackerUrlSchema = url(['http:', 'https:', 'udp:'])
export const webSeedUrlSchema = url(['http:', 'https:'])
export const pickTorrentSourceSchema = z.enum(['file', 'directory'])
export const createTorrentRequestSchema = z
  .object({
    trackers: z
      .array(trackerUrlSchema)
      .max(CREATE_TORRENT_URL_LIMIT)
      .default([]),
    webSeeds: z
      .array(webSeedUrlSchema)
      .max(CREATE_TORRENT_URL_LIMIT)
      .default([]),
    comment: z.string().max(CREATE_TORRENT_COMMENT_MAX).optional(),
    private: z.boolean().default(false),
    pieceLength: z.number().refine(isValidPieceLength).optional(),
  })
  .strict()
  .refine((value) => !value.private || value.trackers.length > 0, {
    path: ['trackers'],
  })
export const createTorrentResultSchema = z
  .object({
    id: z.string().uuid(),
    infoHash: z.string().regex(/^[a-f0-9]{40}$/),
    name: z.string().min(1),
    totalSize: z.number().int().nonnegative(),
    fileCount: z.number().int().positive(),
    pieceCount: z.number().int().nonnegative(),
    pieceLength: z.number().refine(isValidPieceLength),
  })
  .strict()
export const saveTorrentFileRequestSchema = z
  .object({
    id: z.string().uuid(),
    seed: z.boolean(),
  })
  .strict()
export const saveTorrentFileResultSchema = z
  .object({
    path: z.string().min(1),
    seeding: z.enum(['not-requested', 'submitted', 'failed']),
  })
  .strict()
export const pickedTorrentSourceSchema = z.object({ path: z.string().min(1) })
export const createTorrentProgressSchema = z.number().min(0).max(1)
export type CreateTorrentRequest = z.infer<typeof createTorrentRequestSchema>
export type CreateTorrentResultPayload = z.infer<
  typeof createTorrentResultSchema
>

export const serverTorrentSourceSchema = z
  .object({
    path: z.string().min(1).max(4096),
    kind: pickTorrentSourceSchema,
  })
  .strict()
export const serverCreateTorrentSchema = z
  .object({
    source: serverTorrentSourceSchema,
    options: createTorrentRequestSchema,
  })
  .strict()
export const torrentJobSchema = z.object({ id: z.uuid() }).strict()
export const torrentJobStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('hashing'),
    progress: createTorrentProgressSchema,
  }),
  z.object({ state: z.literal('ready'), result: createTorrentResultSchema }),
  z.object({ state: z.literal('failed') }),
])
export const torrentExportSchema = z.object({ seed: z.boolean() }).strict()
export const TORRENT_CREATOR_API = '/api/torrent-creator'
export const TORRENT_SEED_HEADER = 'x-motrix-seeding'
