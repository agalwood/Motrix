import { z } from 'zod'

/**
 * IDM-style confirmation prompt for downloads handed over by the browser
 * bridge (`download/add`). Main derives the payload from the already-mapped
 * `TaskCreateRequest`, so the dialog shows exactly what would be created and
 * amends only the two user-editable fields (save dir, filename).
 */
export const downloadConfirmKindSchema = z.enum(['url', 'magnet', 'torrent'])

export const downloadConfirmRequestSchema = z.object({
  /** Opaque correlation id echoed back by ResolveDownloadConfirm. */
  requestId: z.string().min(1),
  kind: downloadConfirmKindSchema,
  /** First URI for url kind, the magnet uri for magnet kind; absent for a
   *  torrent file (there is no source URL to show). */
  uri: z.string().optional(),
  /** Suggested engine filename (url kind); user-editable in the dialog. */
  filename: z.string().optional(),
  /** Torrent root name or magnet `dn=` hint — display only. */
  displayName: z.string().optional(),
  saveDir: z.string().min(1),
  /** Engine connection split suggestion (url kind, 1..128). */
  connections: z.number().int().min(1).max(128).optional(),
  /** Per-task download limit suggestion in bytes per second; 0 = none. */
  dlLimit: z.number().int().nonnegative().optional(),
})

export type DownloadConfirmRequest = z.infer<
  typeof downloadConfirmRequestSchema
>

export const resolveDownloadConfirmParamsSchema = z.discriminatedUnion(
  'action',
  [
    z.object({
      requestId: z.string().min(1),
      action: z.literal('accept'),
      saveDir: z.string().min(1),
      filename: z.string().optional(),
      connections: z.number().int().min(1).max(128).optional(),
      dlLimit: z.number().int().nonnegative().optional(),
    }),
    z.object({
      requestId: z.string().min(1),
      action: z.literal('cancel'),
    }),
  ]
)

export type ResolveDownloadConfirmParams = z.infer<
  typeof resolveDownloadConfirmParamsSchema
>
