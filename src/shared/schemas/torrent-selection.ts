import { z } from 'zod'

/** Durable user intent; file positions use the complete zero-based metadata list. */
export const torrentSelectionSchema = z.object({
  saveDir: z.string().min(1),
  selectedFiles: z.array(z.number().int().nonnegative()).min(1),
  outputFilePaths: z.array(
    z.object({
      fileIndex: z.number().int().nonnegative(),
      relativePath: z.string().min(1),
    })
  ),
})
export type TorrentSelection = z.infer<typeof torrentSelectionSchema>
