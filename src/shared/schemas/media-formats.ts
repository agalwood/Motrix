import { z } from 'zod'

/**
 * Fork-local `media/formats` MDXP method: the in-page grab overlay asks the
 * desktop which yt-dlp formats a page offers before the user picks a quality.
 *
 * The method rides the extension WebSocket control plane but is NOT part of
 * the published `@motrix/mdxp` method surface — the params/result schemas
 * live here until the method can be published upstream with the protocol.
 * The unary `POST /mdxp` transport never reaches it (the agent-facing Tools
 * map has no entry), so it stays extension-only.
 */
export const MEDIA_FORMATS_METHOD = 'media/formats'

const mediaFormatCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .passthrough()

export const MediaFormatsParamsSchema = z.object({
  /** Page (watch-page or direct media) URL whose formats should be listed. */
  url: z.string().min(1),
  /** Browser session cookies for member-only media; serialized to a Cookie
   *  header desktop-side, exactly like download/submit. */
  cookies: z.array(mediaFormatCookieSchema).optional(),
})

/**
 * One downloadable option. `key` is the quality token the overlay echoes
 * back as `meta.qualityLabel` on submit — never a raw yt-dlp selector, so a
 * client cannot smuggle arbitrary format syntax through the schema.
 */
export const MediaFormatEntrySchema = z.object({
  key: z.string().regex(/^(\d{3,4}p|mp3)$/),
  kind: z.enum(['video', 'audio']),
  /** Display label, e.g. "1080p" or "MP3". */
  label: z.string().min(1),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  ext: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
})

export const MediaFormatsResultSchema = z.object({
  available: z.boolean(),
  /** Machine-readable reason when `available` is false. */
  reason: z.string().optional(),
  title: z.string().optional(),
  durationSec: z.number().optional(),
  entries: z.array(MediaFormatEntrySchema),
})

export type MediaFormatsParams = z.infer<typeof MediaFormatsParamsSchema>
export type MediaFormatEntry = z.infer<typeof MediaFormatEntrySchema>
export type MediaFormatsResult = z.infer<typeof MediaFormatsResultSchema>
