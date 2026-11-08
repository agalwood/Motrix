import { Commands } from '@shared/protocol/commands'
import { z } from 'zod'
import { rendererGenerationSchema } from './renderer-health'
export const rendererSubmissionChannelSchema = z.enum([
  Commands.CreateTask,
  Commands.NextTorrent,
  Commands.DownloadAllTorrents,
])
export const rendererSubmissionSchema = z.object({
  id: z.uuid(),
  generation: rendererGenerationSchema,
  channel: rendererSubmissionChannelSchema,
  args: z.array(z.unknown()).max(1),
})
export type RendererSubmission = z.infer<typeof rendererSubmissionSchema>
