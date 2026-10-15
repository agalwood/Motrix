/**
 * Media resolver contracts.
 *
 * A media resolver turns a page URL (a watch page, a post, an article with an
 * embedded player) into something the download engine can actually transfer.
 * Two outcomes are possible:
 *
 *   - `mux`   — the media is delivered as separate video and audio streams
 *               (the normal case for adaptive streaming sites such as
 *               YouTube). Motrix downloads both and muxes them with FFmpeg
 *               through MuxPipeline.
 *   - `direct`— a single self-contained stream. The URL is swapped for the
 *               resolved stream URL and the normal HTTP download path runs.
 *
 * Resolvers never throw for an unresolvable URL: they return `null` so the
 * caller keeps the unchanged direct-download path. A resolver only reports a
 * hard failure through `YtdlpResolveOutcome` for logging.
 */

export interface MuxResolution {
  kind: 'mux'
  videoUrl: string
  audioUrl: string
  container: 'mp4' | 'mkv'
  headers?: Record<string, string>
  title?: string
  durationSec?: number
}

export interface DirectResolution {
  kind: 'direct'
  url: string
  /** Desired file name including extension. Callers sanitize before use. */
  filename?: string
  headers?: Record<string, string>
  title?: string
  durationSec?: number
}

export type MediaResolution = MuxResolution | DirectResolution

export type MediaResolver = (
  url: string,
  cookieHeader?: string
) => Promise<MediaResolution | null>

/**
 * Run resolvers in order and return the first positive result.
 *
 * Ordering is policy: plugin site-resolvers run before the yt-dlp fallback so
 * an installed, site-specific resolver always wins over the generic one.
 * A resolver that returns null yields to the next candidate.
 */
export function composeMediaResolvers(
  ...resolvers: readonly (MediaResolver | undefined)[]
): MediaResolver {
  const active = resolvers.filter(
    (resolver): resolver is MediaResolver => typeof resolver === 'function'
  )
  return async (url, cookieHeader) => {
    for (const resolver of active) {
      const resolution = await resolver(url, cookieHeader)
      if (resolution) return resolution
    }
    return null
  }
}

/**
 * Adapt the plugin mux seam (which returns a bare mux pair or null) to the
 * media resolver contract.
 */
export function fromMuxPairResolver(
  resolve: (
    url: string,
    cookieHeader?: string
  ) => Promise<{
    videoUrl: string
    audioUrl: string
    container: 'mp4' | 'mkv'
    headers?: Record<string, string>
    title?: string
    durationSec?: number
  } | null>
): MediaResolver {
  return async (url, cookieHeader) => {
    const pair = await resolve(url, cookieHeader)
    if (!pair) return null
    return { kind: 'mux', ...pair }
  }
}
