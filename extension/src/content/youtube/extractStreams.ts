export interface ObservedStream {
  url: string
  itag: number
}

export type StreamKind = 'video' | 'audio' | 'av'

export interface ItagInfo {
  kind: StreamKind
  height?: number
  bitrate?: number
}

/**
 * Built-in fallback itag→kind classification for common adaptive itags.
 * When the player response is unavailable, this maps known itags to their stream type.
 */
export const YT_ITAG_KIND: Record<number, StreamKind> = {
  // video-only adaptive
  137: 'video',
  160: 'video',
  133: 'video',
  134: 'video',
  135: 'video',
  136: 'video',
  138: 'video',
  248: 'video',
  298: 'video',
  299: 'video',
  302: 'video',
  303: 'video',
  271: 'video',
  313: 'video',
  394: 'video',
  395: 'video',
  396: 'video',
  397: 'video',
  398: 'video',
  399: 'video',
  // audio-only adaptive
  139: 'audio',
  140: 'audio',
  141: 'audio',
  171: 'audio',
  249: 'audio',
  250: 'audio',
  251: 'audio',
  // progressive (av, not mux candidates)
  18: 'av',
  22: 'av',
}

/**
 * Parse the `&itag=` (or `?itag=`) query parameter from a URL.
 * Returns the numeric itag if found and valid, null otherwise.
 */
export function parseItag(url: string): number | null {
  try {
    const parsed = new URL(url)
    const itag = parsed.searchParams.get('itag')
    if (!itag || !/^\d+$/.test(itag)) return null
    const num = Number(itag)
    return Number.isSafeInteger(num) && num > 0 ? num : null
  } catch {
    return null
  }
}

/**
 * Select the best video-only and best audio-only streams from a set of observed streams.
 * Streams are classified by itag using itagInfo (preferred) or the YT_ITAG_KIND fallback.
 * Unknown itags are skipped.
 *
 * Selection strategy:
 * - Best video-only: highest height, then highest bitrate, then first observed
 * - Best audio-only: highest bitrate, then first observed
 *
 * Returns { video, audio } URLs if a valid pair is found, null if either is missing.
 */
export function selectMuxStreams(
  observed: ObservedStream[],
  itagInfo?: Record<number, ItagInfo>
): { video: string; audio: string } | null {
  const videos: Array<{ url: string; height?: number; bitrate?: number }> = []
  const audios: Array<{ url: string; bitrate?: number }> = []

  for (const stream of observed) {
    // Determine kind: prefer itagInfo, fall back to built-in table
    const info = itagInfo?.[stream.itag]
    const kind = info?.kind ?? YT_ITAG_KIND[stream.itag]

    if (!kind || kind === 'av') {
      continue // Skip unknown or progressive itags
    }

    if (kind === 'video') {
      videos.push({
        url: stream.url,
        ...(info?.height === undefined ? {} : { height: info.height }),
        ...(info?.bitrate === undefined ? {} : { bitrate: info.bitrate }),
      })
    } else if (kind === 'audio') {
      audios.push({
        url: stream.url,
        ...(info?.bitrate === undefined ? {} : { bitrate: info.bitrate }),
      })
    }
  }

  // Require both video and audio to form a mux
  if (videos.length === 0 || audios.length === 0) {
    return null
  }

  // Select best video: highest height, then highest bitrate, then first
  const firstVideo = videos[0]
  const firstAudio = audios[0]
  if (firstVideo === undefined || firstAudio === undefined) return null

  let bestVideo = firstVideo
  for (const v of videos) {
    if (v.height !== undefined && bestVideo.height !== undefined) {
      if (v.height > bestVideo.height) {
        bestVideo = v
      } else if (
        v.height === bestVideo.height &&
        v.bitrate !== undefined &&
        bestVideo.bitrate !== undefined
      ) {
        if (v.bitrate > bestVideo.bitrate) {
          bestVideo = v
        }
      }
    } else if (v.height !== undefined && bestVideo.height === undefined) {
      bestVideo = v
    }
  }

  // Select best audio: highest bitrate, then first
  let bestAudio = firstAudio
  for (const a of audios) {
    if (a.bitrate !== undefined && bestAudio.bitrate !== undefined) {
      if (a.bitrate > bestAudio.bitrate) {
        bestAudio = a
      }
    } else if (a.bitrate !== undefined && bestAudio.bitrate === undefined) {
      bestAudio = a
    }
  }

  return {
    video: bestVideo.url,
    audio: bestAudio.url,
  }
}
