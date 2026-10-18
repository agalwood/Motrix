import type { MediaSettings } from '@shared/types/settings'
import { z } from 'zod'
import { settingsInputObject } from './settings-input'

export const mediaSettingsSchema = z.object({
  ffmpegBinaryPath: z.string().catch(''),
  ffmpegStagingMB: z.number().int().min(256).max(65536).catch(4096),
  ffmpegOpTimeoutSec: z.number().int().min(60).max(3600).catch(1800),
  // yt-dlp turns media-site URLs (YouTube, Vimeo, bilibili, …) into real
  // stream URLs. Empty path means auto-detect from PATH / MOTRIX_YT_DLP_PATH.
  // Opt-in: disabled when the field is missing or invalid, so settings that
  // predate it never enable external extraction without an explicit choice.
  ytdlpEnabled: z.boolean().catch(false),
  ytdlpBinaryPath: z.string().catch(''),
  // yt-dlp `-f` selector. Empty means "best video + best audio", degrading to
  // a single progressive stream when no mux pipeline is available.
  ytdlpFormat: z.string().catch(''),
  // Resolve every HTTP URL with yt-dlp, not just known media sites. Costs
  // seconds of extractor probing on ordinary file downloads, so off by default.
  ytdlpAllUrls: z.boolean().catch(false),
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
  ytdlpBinaryPath: mediaSettingsSchema.shape.ytdlpBinaryPath
    .removeCatch()
    .refine((value) => !value.includes('\0')),
  ytdlpFormat: mediaSettingsSchema.shape.ytdlpFormat
    .removeCatch()
    .refine((value) => !value.includes('\0')),
})
