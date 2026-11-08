import { Events } from '@shared/protocol/events'
import { z } from 'zod'
import { rendererGenerationSchema } from './renderer-health'

export const rendererIntentChannelSchema = z.enum([
  Events.NavigateTo,
  Events.SetAddTaskMode,
  Events.ProtocolTorrentFile,
  Events.MagnetFileSelection,
  Events.TorrentQueueSizeChanged,
])
export const rendererIntentSchema = z.object({
  id: z.uuid(),
  generation: rendererGenerationSchema,
  channel: rendererIntentChannelSchema,
  payload: z.unknown(),
})
export const rendererIntentAckSchema = rendererIntentSchema.pick({
  id: true,
  generation: true,
})
export type RendererIntentChannel = z.infer<typeof rendererIntentChannelSchema>
