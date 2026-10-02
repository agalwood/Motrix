import { z } from 'zod'

// Create-torrent (#459): build a BitTorrent v1 metainfo file from a local
// file or folder. The heavy work (piece hashing) runs in the main process;
// progress is reported via the CreateTorrentProgress event so the UI can
// show a determinate bar.

export const CREATE_TORRENT_TRACKER_LIMIT = 64
export const CREATE_TORRENT_WEB_SEED_LIMIT = 64
export const CREATE_TORRENT_COMMENT_MAX = 2048

// Shared with the renderer's per-line textarea validation.
export const createTorrentUrlSchema = z.string().url().max(2048)

// C0 control range in source paths.
// biome-ignore lint/complexity/useRegexLiterals: RegExp constructor avoids noControlCharactersInRegex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]')

export const createTorrentRequestSchema = z
  .object({
    // Absolute on-disk path to the source file or folder (already picked
    // through a native dialog, so no control-character games are expected;
    // the guard keeps hostile payloads out of fs calls regardless).
    sourcePath: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !CONTROL_CHARS.test(value)),
    trackers: z
      .array(createTorrentUrlSchema)
      .max(CREATE_TORRENT_TRACKER_LIMIT)
      .catch([]),
    webSeeds: z
      .array(createTorrentUrlSchema)
      .max(CREATE_TORRENT_WEB_SEED_LIMIT)
      .catch([]),
    comment: z.string().max(CREATE_TORRENT_COMMENT_MAX).optional(),
    private: z.boolean().catch(false),
    // Absent → suggestPieceLength picks by total size.
    pieceLength: z.number().int().optional(),
  })
  .strict()

export const createTorrentResultSchema = z
  .object({
    torrentBase64: z.string().min(1),
    infoHash: z.string().length(40),
    name: z.string().min(1),
    totalSize: z.number().nonnegative(),
    fileCount: z.number().int().positive(),
    pieceCount: z.number().int().positive(),
    pieceLength: z.number().int().positive(),
    // Suggested .torrent file name for the save dialog.
    suggestedSaveName: z.string().min(1),
  })
  .strict()

export const pickTorrentSourceResultSchema = z
  .object({ path: z.string().min(1) })
  .strict()

export const saveTorrentFileRequestSchema = z
  .object({
    torrentBase64: z.string().min(1),
    suggestedSaveName: z.string().min(1).max(255),
  })
  .strict()

export const saveTorrentFileResultSchema = z
  .object({ path: z.string().min(1) })
  .strict()

export interface CreateTorrentProgressPayload {
  /** Fixed per operation; one create runs at a time. */
  operationId: 'create-torrent'
  processedBytes: number
  totalBytes: number
  /** 0..1, clamped; equals 1 on completion. */
  fraction: number
}

export type CreateTorrentRequest = z.infer<typeof createTorrentRequestSchema>
export type CreateTorrentResultPayload = z.infer<
  typeof createTorrentResultSchema
>
export type SaveTorrentFileRequest = z.infer<
  typeof saveTorrentFileRequestSchema
>
