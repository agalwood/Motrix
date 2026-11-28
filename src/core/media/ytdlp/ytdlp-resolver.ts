import { spawn as nodeSpawn } from 'node:child_process'
import type {
  DirectResolution,
  MediaQualityHint,
  MediaResolution,
  MediaResolveOptions,
  MuxResolution,
} from './media-resolver'
import { isYouTubeVideoPage } from './media-site-allowlist'
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
 * Unsupported results distinguish URLs no extractor claims from media pages
 * whose streams Motrix cannot download.
 */

const DIRECT_FORMAT_FILTER = "[protocol~='^https?$']"
export const DEFAULT_YTDLP_FORMAT = `bv*${DIRECT_FORMAT_FILTER}+ba${DIRECT_FORMAT_FILTER}/b${DIRECT_FORMAT_FILTER}`
const RESOLVE_TIMEOUT_MS = 60_000

export type YtdlpResolveOutcome =
  | { status: 'resolved'; resolution: MediaResolution }
  | { status: 'unsupported' | 'failed'; reason: string; mediaIdentified?: true }

export interface YtdlpResolveOptions {
  binaryPath: string
  /** yt-dlp `-f` selector. Defaults to best video + best audio. */
  format?: string
  sortByHeight?: boolean
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
  if (options.sortByHeight) {
    // Extractor preferences can outrank user sort fields unless force is set.
    args.push(
      '--format-sort-force',
      '--format-sort',
      'height,vext:mp4,aext:m4a'
    )
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
  ['unsupported url', 'unsupported-url'],
  ['no suitable extractor', 'unsupported-url'],
  ['requested format is not available', 'format-unavailable'],
  ['this video is unavailable', 'video-unavailable'],
  ['sign in to confirm', 'sign-in-required'],
  ['confirm your age', 'sign-in-required'],
  ['video unavailable', 'video-unavailable'],
  ['drm', 'drm-protected'],
] as const

/** Only stable reason codes may reach the caller; stderr can contain signed URLs. */
function unsupportedReason(stderr: string): string | undefined {
  const lower = stderr.toLowerCase()
  return UNSUPPORTED_MARKERS.find(([marker]) => lower.includes(marker))?.[1]
}

export function looksUnsupported(stderr: string): boolean {
  return unsupportedReason(stderr) !== undefined
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

/** Ask yt-dlp for the stream URLs or a sanitized extraction failure. */
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
      // A named site extractor claimed this input. An unsupported URL from
      // the generic extractor still belongs to Motrix’s normal HTTP path.
      const extractor = /^ERROR: \[([\w.:-]+)\]/im.exec(result.stderr)?.[1]
      const reason = unsupportedReason(result.stderr)
      return {
        ...(extractor && extractor.toLowerCase() !== 'generic'
          ? { mediaIdentified: true }
          : {}),
        status: reason ? 'unsupported' : 'failed',
        reason: reason ?? 'extraction-failed',
      }
    }
    const info = parseYtdlpStdout<RawInfo>(result.stdout)
    const resolution = mapYtdlpInfo(info)
    return resolution
      ? { status: 'resolved', resolution }
      : {
          status: 'unsupported',
          reason: 'no-direct-stream',
          mediaIdentified: true,
        }
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
 * - height    → direct streams at or below the cap. The height-first sort
 *   resolves ties in favor of MP4/M4A without lowering the selected height.
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
  const video = `[height<=${height}]${DIRECT_FORMAT_FILTER}`
  return muxAvailable
    ? `bv*${video}+ba${DIRECT_FORMAT_FILTER}/b${video}`
    : `b${video}`
}

/**
 * Build a `MediaResolver` backed by yt-dlp.
 *
 * Disabled and unmatched links fall through to ordinary HTTP. For an
 * identified media page, return a safe failure reason instead of its HTML.
 */
export function createYtdlpMediaResolver(
  deps: YtdlpResolverDeps,
  isMediaSite: (url: string) => boolean
) {
  return async (
    url: string,
    cookieHeader?: string,
    resolverOptions?: MediaResolveOptions
  ): Promise<
    MediaResolution | { kind: 'unavailable'; reason: string } | null
  > => {
    const signal = resolverOptions?.signal
    throwIfYtdlpAborted(signal)
    // Site-specific plugins may use credentials before this fallback is reached.
    // The generic extractor cannot preserve browser Cookie scope, so decline.
    const targetUrl = canonicalPublicMediaUrl(url)
    if (!targetUrl) return null
    const siteMatch = isMediaSite(targetUrl)
    const optionsForSite = () => {
      const options = deps.readOptions?.()
      return options?.enabled && (options.allUrls || siteMatch) ? options : null
    }
    const initialOptions = optionsForSite()
    if (!initialOptions) return null

    const knownPage = isYouTubeVideoPage(targetUrl)
    const unavailable = (reason: string, identified = knownPage) =>
      identified ? { kind: 'unavailable' as const, reason } : null
    if (cookieHeader) return unavailable('credentials-unsupported')
    const proxyFailure = (options: typeof initialOptions) =>
      options.proxyUnsupportedReason ??
      (safeYtdlpArgs(options.proxy) ? null : 'proxy-credentials-unsupported')
    const initialFailure = proxyFailure(initialOptions)
    if (initialFailure) return unavailable(initialFailure)

    const permittedOptions = () => {
      const options = optionsForSite()
      return options &&
        options.configuredBinaryPath === initialOptions.configuredBinaryPath &&
        !proxyFailure(options)
        ? options
        : null
    }
    const binaryPath = await deps.resolveBinaryPath(signal)
    throwIfYtdlpAborted(signal)
    if (!permittedOptions()) return unavailable('settings-changed')
    if (!binaryPath) return unavailable('binary-missing')
    const muxAvailable = (await deps.isMuxAvailable?.()) ?? false
    throwIfYtdlpAborted(signal)
    const options = permittedOptions()
    if (!options) return unavailable('settings-changed')
    const hint = resolverOptions?.qualityHint
    const format = hint
      ? buildQualityFormat(hint, muxAvailable)
      : options.format?.trim() ||
        (muxAvailable ? DEFAULT_YTDLP_FORMAT : PROGRESSIVE_FORMAT)
    const outcome = await resolveWithYtdlp(targetUrl, {
      binaryPath,
      format,
      sortByHeight: Boolean(hint?.height && !hint.audioOnly),
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
      ...(signal ? { signal } : {}),
    })
    throwIfYtdlpAborted(signal)
    if (!permittedOptions()) return unavailable('settings-changed')
    if (outcome.status === 'resolved') return outcome.resolution
    return unavailable(outcome.reason, knownPage || outcome.mediaIdentified)
  }
}
