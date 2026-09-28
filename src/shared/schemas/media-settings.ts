import type { MediaSettings } from '@shared/types/settings'
import { z } from 'zod'
import { settingsInputObject } from './settings-input'

export const mediaSettingsSchema = z.object({
  ffmpegBinaryPath: z.string().catch(''),
  ffmpegStagingMB: z.number().int().min(256).max(65536).catch(4096),
  ffmpegOpTimeoutSec: z.number().int().min(60).max(3600).catch(1800),
})

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = mediaSettingsSchema.parse(
  {}
)

export const mediaSettingsInputSchema = settingsInputObject(
  mediaSettingsSchema
).extend({
  ffmpegBinaryPath: mediaSettingsSchema.shape.ffmpegBinaryPath
    .removeCatch()
    .refine((value) => !value.includes('\0')),
})
