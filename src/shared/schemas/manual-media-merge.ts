import { z } from 'zod'

/** Opt-in public command convention; no new manifest keywords are required. */
export const MEDIA_MERGE_COMMAND = 'mergeStreams'
export const mediaMergePathSchema = z.string().min(1).max(4096)
export const mediaMergeArgsSchema = z
  .object({
    videoInput: mediaMergePathSchema,
    audioInput: mediaMergePathSchema,
    output: mediaMergePathSchema,
  })
  .strict()
export const mediaMergeStartSchema = mediaMergeArgsSchema
  .extend({
    pluginId: z.string().min(1).max(140),
  })
  .strict()
export const mediaMergeSelectionSchema = z.array(z.string().min(1)).length(2)
export const mediaMergeJobIdSchema = z.string().uuid()

export interface MediaMergeProvider {
  pluginId: string
  title: string
}
export type MediaMergeArgs = z.infer<typeof mediaMergeArgsSchema>
export type MediaMergeStart = z.infer<typeof mediaMergeStartSchema>
export interface MediaMergeJob {
  id: string
  pluginId: string
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  percent: number | null
  output: string
  error?: string
}
