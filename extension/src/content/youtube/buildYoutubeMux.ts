import type { ItagInfo } from '@/content/youtube/extractStreams'
import type { DetectedMedia } from '@/shared/media'

/**
 * Build a mux DetectedMedia from a selected video+audio stream pair.
 */
export function buildYoutubeMux(
  streams: { video: string; audio: string },
  ctx: { pageUrl: string; pageTitle: string; now: number }
): DetectedMedia {
  return {
    kind: 'mux',
    url: streams.video,
    audioUrl: streams.audio,
    pageUrl: ctx.pageUrl,
    pageTitle: ctx.pageTitle,
    detectedAt: ctx.now,
  }
}

/**
 * Convert an array of adaptive-format entries from ytInitialPlayerResponse
 * into a Record<itag, ItagInfo> for use with selectMuxStreams.
 *
 * Expected shape of each entry (all fields optional — we guard everything):
 * {
 *   itag: number
 *   mimeType?: string         // e.g. "video/mp4; codecs=..."
 *   width?: number
 *   height?: number
 *   bitrate?: number
 *   audioQuality?: string     // present on audio-only formats
 * }
 */
export function playerResponseToItagInfo(
  adaptiveFormats: unknown[]
): Record<number, ItagInfo> {
  const result: Record<number, ItagInfo> = {}
  for (const fmt of adaptiveFormats) {
    if (typeof fmt !== 'object' || fmt === null) continue
    const f = fmt as Record<string, unknown>
    const itag = typeof f.itag === 'number' ? f.itag : null
    if (itag === null) continue

    const mimeType = typeof f.mimeType === 'string' ? f.mimeType : ''
    const height = typeof f.height === 'number' ? f.height : undefined
    const bitrate = typeof f.bitrate === 'number' ? f.bitrate : undefined

    // Determine stream kind from mimeType prefix:
    //   "video/" → video-only (no audioQuality field)
    //   "audio/" → audio-only
    //   combined / unknown → 'av'
    let kind: ItagInfo['kind']
    if (mimeType.startsWith('audio/')) {
      kind = 'audio'
    } else if (mimeType.startsWith('video/')) {
      // A video-only adaptive stream has no audioQuality field;
      // a progressive (muxed) stream has it.
      kind =
        typeof f.audioQuality === 'string' && f.audioQuality !== ''
          ? 'av'
          : 'video'
    } else {
      kind = 'av'
    }

    const info: ItagInfo = { kind }
    if (height !== undefined) info.height = height
    if (bitrate !== undefined) info.bitrate = bitrate
    result[itag] = info
  }
  return result
}
