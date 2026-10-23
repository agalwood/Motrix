import { spawn as nodeSpawn } from 'node:child_process'
import type {
  DirectResolution,
  MediaQualityHint,
  MediaResolution,
  MediaResolveOptions,
  MuxResolution,
} from './media-resolver'
import {
  canonicalPublicMediaUrl,
  isPublicMediaUrl,
  isYtdlpAbort,
  safeYtdlpArgs,
  spawnResolve,
  throwIfYtdlpAborted,
  YtdlpExecutionError,
} from './ytdlp-execution'
import type { SpawnLike } from './ytdlp-locator'

/**
 * yt-dlp backed media resolver.
 *
 * Runs `yt-dlp --dump-single-json` to ask a site extractor for the real
 * stream URLs, then maps the answer onto Motrix's media contracts: separate
 * video + audio streams become a `mux` resolution (downloaded by the segment
 * downloader and muxed by FFmpeg), a single self-contained stream becomes a
 * `direct` resolution whose URL replaces the page URL in the normal HTTP
 * path.
 *
 * The resolver never throws for a URL it cannot handle — `unsupported` means
 * the site has no extractor or the media is DRM-protected, and the caller
 * keeps its unchanged direct-download path.
 */

const DIRECT_FORMAT_FILTER = "[protocol~='^https?$']"
export const DEFAULT_YTDLP_FORMAT = `bv*${DIRECT_FORMAT_FILTER}+ba${DIRECT_FORMAT_FILTER}/b${DIRECT_FORMAT_FILTER}`
const RESOLVE_TIMEOUT_MS = 60_000

export type YtdlpResolveOutcome =
  | { status: 'resolved'; resolution: MediaResolution }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string }

export interface YtdlpResolveOptions {
  binaryPath: string
  /** yt-dlp `-f` selector. Defaults to best video + best audio. */
  format?: string
  proxy?: string
  signal?: AbortSignal
  timeoutMs?: number
  spawnImpl?: SpawnLike
}

interface RawFormat {
  url?: string
  ext?: string
  protocol?: string
  vcodec?: string
  acodec?: string
  height?: number
  http_headers?: Record<string, string>
}

interface RawInfo {
  title?: string
  ext?: string
  duration?: number
  url?: string
  vcodec?: string
  acodec?: string
  protocol?: string
  http_headers?: Record<string, string>
  requested_formats?: RawFormat[]
  format_id?: string
}

const DIRECT_PROTOCOLS = new Set(['https', 'http'])

function isDirectProtocol(protocol: string | undefined): boolean {
  // `m3u8_native` / `http_dash_segments` are manifests or segment lists, not
  // fetchable single files; the HLS/DASH pipelines own those.
  return protocol === undefined || DIRECT_PROTOCOLS.has(protocol)
}

/** mp4 can only hold the usual AAC/H.264 pair; anything else goes to mkv. */
export function containerForFormats(
  videoExt: string | undefined,
  audioExt: string | undefined
): 'mp4' | 'mkv' {
  const mp4Family = new Set(['mp4', 'm4v', 'm4a'])
  const videoOk = !videoExt || mp4Family.has(videoExt.toLowerCase())
  const audioOk = !audioExt || mp4Family.has(audioExt.toLowerCase())
  return videoOk && audioOk ? 'mp4' : 'mkv'
}

function headerSet(
  ...sources: readonly (Record<string, string> | undefined)[]
) {
  const headers: Record<string, string> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === 'string' && value.length > 0) headers[name] = value
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function buildYtdlpArgs(
  url: string,
  options: Omit<YtdlpResolveOptions, 'binaryPath' | 'spawnImpl' | 'timeoutMs'>
): string[] {
  const args = safeYtdlpArgs(options.proxy)
  if (!args || !isPublicMediaUrl(url)) {
    throw new Error('Unsupported public media request')
  }
  args.push('--format', options.format?.trim() || DEFAULT_YTDLP_FORMAT)
  return args
}

/** Map parsed yt-dlp output onto a Motrix media resolution. */
export function mapYtdlpInfo(info: RawInfo): MediaResolution | null {
  const requested = (info.requested_formats ?? []).filter((f) => f.url)
  const headers = headerSet(info.http_headers)

  if (requested.length >= 2) {
    const video = requested.find((f) => f.vcodec && f.vcodec !== 'none')
    const audio = requested.find((f) => f.acodec && f.acodec !== 'none')
    if (
      video?.url &&
      audio?.url &&
      isDirectProtocol(video.protocol) &&
      isDirectProtocol(audio.protocol)
    ) {
      const mux: MuxResolution = {
        kind: 'mux',
        videoUrl: video.url,
        audioUrl: audio.url,
        container: containerForFormats(video.ext, audio.ext),
        headers: headerSet(video.http_headers, audio.http_headers, headers),
        ...(info.title ? { title: info.title } : {}),
        ...(typeof info.duration === 'number'
          ? { durationSec: info.duration }
          : {}),
      }
      return mux
    }
    // When multiple streams were selected, an unsupported pair must be declined;
    // requested[0] is typically video-only and would silently discard audio.
    return null
  }

  const single = requested.length === 1 ? requested[0] : undefined
  const protocol = single?.protocol ?? info.protocol
  const url = single?.url ?? info.url
  if (!url || !isDirectProtocol(protocol)) return null
  const ext = single?.ext ?? info.ext
  const direct: DirectResolution = {
    kind: 'direct',
    url,
    headers: headerSet(single?.http_headers, headers),
    ...(info.title && ext
      ? { filename: `${info.title}.${ext}` }
      : info.title
        ? { title: info.title }
        : {}),
    ...(info.title ? { title: info.title } : {}),
    ...(typeof info.duration === 'number'
      ? { durationSec: info.duration }
      : {}),
  }
  return direct
}

const UNSUPPORTED_MARKERS = [
  'unsupported url',
  'no suitable extractor',
  'requested format is not available',
  'this video is unavailable',
  'sign in to confirm',
  'confirm your age',
  'video unavailable',
  'drm',
]

/** True when yt-dlp's stderr says the URL can never be resolved. */
export function looksUnsupported(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return UNSUPPORTED_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Extract the JSON blob from yt-dlp stdout. yt-dlp may emit a warning line
 * before the payload; the blob starts at the first `{`.
 */
export function parseYtdlpStdout<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('no JSON object on stdout')
  return JSON.parse(stdout.slice(start)) as T
}

/** Ask yt-dlp for the stream URLs behind `url`.
 *
 * Returns an outcome rather than throwing so both desktop and bridge callers
 * can log the reason and fall through to their unchanged download path.
 */
export async function resolveWithYtdlp(
  url: string,
  options: YtdlpResolveOptions
): Promise<YtdlpResolveOutcome> {
  throwIfYtdlpAborted(options.signal)
  const targetUrl = canonicalPublicMediaUrl(url)
  if (!targetUrl) return { status: 'unsupported', reason: 'not-allowed' }
  if (!safeYtdlpArgs(options.proxy))
    return { status: 'unsupported', reason: 'proxy-credentials-unsupported' }
  try {
    const result = await spawnResolve(
      options.binaryPath,
      buildYtdlpArgs(targetUrl, options),
      options.timeoutMs ?? RESOLVE_TIMEOUT_MS,
      options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike),
      {
        ...(options.signal ? { signal: options.signal } : {}),
        input: `${targetUrl}\n`,
      }
    )
    throwIfYtdlpAborted(options.signal)
    if (result.code !== 0) {
      return {
        status: looksUnsupported(result.stderr) ? 'unsupported' : 'failed',
        reason: 'extraction-failed',
      }
    }
    const info = parseYtdlpStdout<RawInfo>(result.stdout)
    const resolution = mapYtdlpInfo(info)
    return resolution
      ? { status: 'resolved', resolution }
      : { status: 'unsupported', reason: 'no-direct-stream' }
  } catch (error) {
    if (isYtdlpAbort(error)) throw error
    return {
      status: 'failed',
      reason:
        error instanceof YtdlpExecutionError
          ? error.reason
          : 'extraction-failed',
    }
  }
}

export interface YtdlpResolverDeps {
  /** Resolves the yt-dlp binary path; returns null when yt-dlp is absent. */
  resolveBinaryPath: (signal?: AbortSignal) => Promise<string | null>
  readOptions?: () => {
    enabled: boolean
    configuredBinaryPath?: string
    format?: string
    proxy?: string
    proxyUnsupportedReason?: 'proxy-bypass-unsupported'
    allUrls?: boolean
  }
  /**
   * Whether the FFmpeg mux pipeline can accept a two-stream resolution.
   * When false (FFmpeg absent, or the shell has no media pipeline) the
   * resolver asks yt-dlp for a single progressive stream instead, so the
   * caller still gets a file rather than a mux task it cannot run.
   */
  isMuxAvailable?: () => boolean | Promise<boolean>
  spawnImpl?: SpawnLike
}

const PROGRESSIVE_FORMAT = `b[ext=mp4]${DIRECT_FORMAT_FILTER}/b${DIRECT_FORMAT_FILTER}`

/**
 * Map a submitter's quality hint onto a yt-dlp `-f` selector.
 *
 * - audioOnly → best audio stream, single format (never a mux pair), which
 *   the receiver routes to MP3 extraction after the download.
 * - height    → best stream at or below the cap. mp4/m4a is preferred while
 *   it exists so the mux lands in an mp4 container without a transcode. Every
 *   fallback retains the cap and direct-HTTP(S) constraint.
 * - no hint   → the settings default (or the progressive fallback when no
 *   mux pipeline can run).
 */
export function buildQualityFormat(
  hint: MediaQualityHint,
  muxAvailable: boolean
): string {
  if (hint.audioOnly)
    return `bestaudio${DIRECT_FORMAT_FILTER}/best[acodec!=none]${DIRECT_FORMAT_FILTER}`
  const height = hint.height
  if (!height) {
    return muxAvailable ? DEFAULT_YTDLP_FORMAT : PROGRESSIVE_FORMAT
  }
  if (muxAvailable) {
    return [
      `bv*[height<=${height}][ext=mp4]${DIRECT_FORMAT_FILTER}+ba[ext=m4a]${DIRECT_FORMAT_FILTER}`,
      `bv*[height<=${height}]${DIRECT_FORMAT_FILTER}+ba${DIRECT_FORMAT_FILTER}`,
      `b[height<=${height}][ext=mp4]${DIRECT_FORMAT_FILTER}`,
      `b[height<=${height}]${DIRECT_FORMAT_FILTER}`,
    ].join('/')
  }
  return [
    `b[height<=${height}][ext=mp4]${DIRECT_FORMAT_FILTER}`,
    `b[height<=${height}]${DIRECT_FORMAT_FILTER}`,
  ].join('/')
}

/**
 * Build a `MediaResolver` backed by yt-dlp.
 *
 * Returns null (no resolution) whenever yt-dlp is unavailable, disabled in
 * Settings, or the URL is not a media site under the current policy — so
 * composing this last in the resolver chain leaves every other download
 * untouched. A submitter quality hint overrides the Settings format so the
 * picker's choice wins over the default.
 */
export function createYtdlpMediaResolver(
  deps: YtdlpResolverDeps,
  isMediaSite: (url: string) => boolean
) {
  return async (
    url: string,
    cookieHeader?: string,
    resolverOptions?: MediaResolveOptions
  ): Promise<MediaResolution | null> => {
    const signal = resolverOptions?.signal
    throwIfYtdlpAborted(signal)
    // Site-specific plugins may use credentials before this fallback is reached.
    // The generic extractor cannot preserve browser Cookie scope, so decline.
    const targetUrl = canonicalPublicMediaUrl(url)
    if (cookieHeader || !targetUrl) return null
    const permittedOptions = () => {
      const options = deps.readOptions?.() ?? { enabled: false }
      return options.enabled &&
        !options.proxyUnsupportedReason &&
        (options.allUrls || isMediaSite(targetUrl)) &&
        safeYtdlpArgs(options.proxy)
        ? options
        : null
    }
    const initialOptions = permittedOptions()
    if (!initialOptions) return null
    const binaryPath = await deps.resolveBinaryPath(signal)
    throwIfYtdlpAborted(signal)
    if (!permittedOptions() || !binaryPath) return null
    const muxAvailable = (await deps.isMuxAvailable?.()) ?? false
    throwIfYtdlpAborted(signal)
    const options = permittedOptions()
    if (
      !options ||
      options.configuredBinaryPath !== initialOptions.configuredBinaryPath
    )
      return null
    const hint = resolverOptions?.qualityHint
    const format = hint
      ? buildQualityFormat(hint, muxAvailable)
      : options.format?.trim() ||
        (muxAvailable ? DEFAULT_YTDLP_FORMAT : PROGRESSIVE_FORMAT)
    const outcome = await resolveWithYtdlp(targetUrl, {
      binaryPath,
      format,
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
      ...(signal ? { signal } : {}),
    })
    throwIfYtdlpAborted(signal)
    if (!permittedOptions()) return null
    return outcome.status === 'resolved' ? outcome.resolution : null
  }
}
