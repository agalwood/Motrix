import { z } from 'zod'
import { analyzeDownloadSource } from '../lib/download-source'
import { MAX_DOWNLOAD_URL_BYTES, MAX_MIRROR_URIS } from './download-source'

export const sourceUrisSchema = z
  .array(z.string().max(MAX_DOWNLOAD_URL_BYTES))
  .max(10_000)
export const taskSourcesRequestSchema = z.object({
  taskId: z.string().min(1),
  engineTaskId: z.string().min(1),
})
export const taskSourcesUpdateSchema = taskSourcesRequestSchema.extend({
  previous: sourceUrisSchema,
  uris: z.array(z.string()).max(MAX_MIRROR_URIS),
})
export const taskSourceKindSchema = z.enum(['http', 'ftp', 'webseed'])
export type TaskSourceKind = z.infer<typeof taskSourceKindSchema>
export const taskSourcesSnapshotSchema = taskSourcesRequestSchema.extend({
  kind: taskSourceKindSchema,
  uris: sourceUrisSchema,
  editable: z.boolean(),
})
export type TaskSourcesSnapshot = z.infer<typeof taskSourcesSnapshotSchema>

export function taskSourceUrlsSchema(kind: TaskSourceKind) {
  return z
    .array(z.string().trim())
    .max(MAX_MIRROR_URIS)
    .superRefine((uris, ctx) => {
      if (!uris.length && kind !== 'webseed')
        ctx.addIssue({ code: 'custom', message: 'task.sources.invalid' })
      for (const [index, uri] of uris.entries()) {
        const result = analyzeDownloadSource(
          uri,
          kind === 'ftp' ? ['ftp'] : ['http', 'https']
        )
        if (result.status !== 'accepted')
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: 'task.sources.invalid',
          })
      }
    })
    .transform((uris) =>
      uris.map((uri) => {
        const result = analyzeDownloadSource(
          uri,
          kind === 'ftp' ? ['ftp'] : ['http', 'https']
        )
        return result.status === 'accepted' ? result.requestUrl : uri
      })
    )
}
