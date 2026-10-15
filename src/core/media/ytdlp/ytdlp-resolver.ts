import { spawn as nodeSpawn } from 'node:child_process'
import { getLogger } from '@core/logger'
import type {
  DirectResolution,
  MediaQualityHint,
  MediaResolution,
  MediaResolveOptions,
  MuxResolution,
} from './media-resolver'
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

export const DEFAULT_YTDLP_FORMAT = 'bv*+ba/b'
const RESOLVE_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export type YtdlpResolveOutcome =
  | { status: 'resolved'; resolution: MediaResolution }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string }

export interface YtdlpResolveOptions {
  binaryPath: string
  /** yt-dlp `-f` selector. Defaults to best video + best audio. */
  format?: string
  proxy?: string
  /** Cookie header captured from the caller's browser session. */
  cookieHeader?: string
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
  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '--format',
    options.format?.trim() || DEFAULT_YTDLP_FORMAT,
  ]
  if (options.proxy?.trim()) args.push('--proxy', options.proxy.trim())
  if (options.cookieHeader?.trim()) {
    args.push('--add-header', `Cookie:${options.cookieHeader.trim()}`)
  }
  // `--` stops option parsing, so a URL beginning with `-` cannot inject flags.
  args.push('--', url)
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
  }

  const single = requested[0]
  const url = single?.url ?? info.url
  if (!url || !isDirectProtocol(single?.protocol)) return null
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

export function spawnResolve(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
  spawnImpl: SpawnLike
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      fn()
    }
    let child: ReturnType<SpawnLike>
    try {
      child = spawnImpl(binaryPath, args, { shell: false })
    } catch (cause) {
      settle(() => reject(cause))
      return
    }
    killTimer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += String(chunk)
    })
    child.on('error', (error) => settle(() => reject(error)))
    child.on('close', (code) =>
      settle(() =>
        timedOut
          ? reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`))
          : resolve({ code, stdout, stderr })
      )
    )
  })
}

function killChild(child: ReturnType<SpawnLike>): void {
  try {
    child.kill('SIGKILL')
  } catch {
    // Process already exited; nothing to reap.
  }
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
  const log = getLogger('ytdlp-resolver')
  const args = buildYtdlpArgs(url, options)
  const started = Date.now()
  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await spawnResolve(
      options.binaryPath,
      args,
      options.timeoutMs ?? RESOLVE_TIMEOUT_MS,
      options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike)
    )
  } catch (cause) {
    return { status: 'failed', reason: `spawn failed: ${String(cause)}` }
  }
  const elapsedMs = Date.now() - started
  if (result.code !== 0) {
    const reason =
      result.stderr.trim().split('\n').slice(-1)[0] || 'unknown error'
    const status = looksUnsupported(result.stderr) ? 'unsupported' : 'failed'
    log.info(
      { url, code: result.code, status, elapsedMs, reason },
      'yt-dlp could not resolve url'
    )
    return { status, reason }
  }
  let info: RawInfo
  try {
    info = parseYtdlpStdout<RawInfo>(result.stdout)
  } catch (cause) {
    log.warn({ url, elapsedMs, err: cause }, 'yt-dlp output was not JSON')
    return { status: 'failed', reason: `unparseable output: ${String(cause)}` }
  }
  const resolution = mapYtdlpInfo(info)
  if (!resolution) {
    return {
      status: 'unsupported',
      reason: 'extractor returned no directly downloadable stream',
    }
  }
  log.info(
    {
      url,
      kind: resolution.kind,
      container: resolution.kind === 'mux' ? resolution.container : undefined,
      elapsedMs,
    },
    'yt-dlp resolved media'
  )
  return { status: 'resolved', resolution }
}

export interface YtdlpResolverDeps {
  /** Resolves the yt-dlp binary path; returns null when yt-dlp is absent. */
  resolveBinaryPath: () => Promise<string | null>
  readOptions?: () => {
    enabled: boolean
    format?: string
    proxy?: string
    allUrls?: boolean
  }
  /**
   * Whether the FFmpeg mux pipeline can accept a two-stream resolution.
   * When false (FFmpeg absent, or the shell has no media pipeline) the
   * resolver asks yt-dlp for a single progressive stream instead, so the
   * caller still gets a file rather than a mux task it cannot run.
   */
  isMuxAvailable?: () => boolean
  spawnImpl?: SpawnLike
}

const PROGRESSIVE_FORMAT = 'b[ext=mp4]/b'

/**
 * Map a submitter's quality hint onto a yt-dlp `-f` selector.
 *
 * - audioOnly → best audio stream, single format (never a mux pair), which
 *   the receiver routes to MP3 extraction after the download.
 * - height    → best stream at or below the cap. mp4/m4a is preferred while
 *   it exists so the mux lands in an mp4 container without a transcode; the
 *   trailing `/b` keeps a below-cap pick from failing outright when every
 *   available format is taller than the request.
 * - no hint   → the settings default (or the progressive fallback when no
 *   mux pipeline can run).
 */
export function buildQualityFormat(
  hint: MediaQualityHint,
  muxAvailable: boolean
): string {
  if (hint.audioOnly) return 'bestaudio/best'
  const height = hint.height
  if (!height) {
    return muxAvailable ? DEFAULT_YTDLP_FORMAT : PROGRESSIVE_FORMAT
  }
  if (muxAvailable) {
    return [
      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
      `bv*[height<=${height}]+ba`,
      `b[height<=${height}][ext=mp4]`,
      `b[height<=${height}]`,
      'b',
    ].join('/')
  }
  return [`b[height<=${height}][ext=mp4]`, `b[height<=${height}]`, 'b'].join(
    '/'
  )
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
    const options = deps.readOptions?.() ?? { enabled: true }
    if (!options.enabled) return null
    if (!options.allUrls && !isMediaSite(url)) return null
    const binaryPath = await deps.resolveBinaryPath()
    if (!binaryPath) return null
    const muxAvailable = deps.isMuxAvailable?.() ?? true
    const hint = resolverOptions?.qualityHint
    const format = hint
      ? buildQualityFormat(hint, muxAvailable)
      : options.format?.trim() ||
        (muxAvailable ? DEFAULT_YTDLP_FORMAT : PROGRESSIVE_FORMAT)
    const outcome = await resolveWithYtdlp(url, {
      binaryPath,
      format,
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(cookieHeader ? { cookieHeader } : {}),
      ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
    })
    return outcome.status === 'resolved' ? outcome.resolution : null
  }
}
