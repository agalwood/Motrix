import { spawn as nodeSpawn } from 'node:child_process'
import {
  type MediaFormatCookie,
  type MediaFormatEntry,
  type MediaFormatsResult,
  MediaFormatsResultSchema,
} from '@motrix/mdxp'
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
import { looksUnsupported, parseYtdlpStdout } from './ytdlp-resolver'

const FORMAT_TIMEOUT_MS = 60_000
const MAX_VIDEO_ROWS = 12
const MAX_HEIGHT = 4320

export interface YtdlpFormatListRequest {
  url: string
  /** This public-only adapter declines credentials before probing or spawning. */
  cookies?: MediaFormatCookie[]
  audioExtractAvailable: boolean
  muxAvailable?: boolean
}

export interface YtdlpFormatListerDeps {
  resolveBinaryPath: (signal?: AbortSignal) => Promise<string | null>
  readOptions?: () => {
    enabled: boolean
    proxy?: string
    proxyUnsupportedReason?: 'proxy-bypass-unsupported'
    allUrls?: boolean
  }
  isMediaSite: (url: string) => boolean
  spawnImpl?: SpawnLike
}

export type YtdlpFormatLister = (
  req: YtdlpFormatListRequest,
  signal?: AbortSignal
) => Promise<MediaFormatsResult>

interface RawListFormat {
  url?: unknown
  ext?: unknown
  protocol?: unknown
  vcodec?: unknown
  acodec?: unknown
  has_drm?: unknown
  height?: unknown
  fps?: unknown
  tbr?: unknown
  filesize?: unknown
  filesize_approx?: unknown
}

interface RawFormatsInfo {
  title?: unknown
  duration?: unknown
  formats?: unknown
}

const MP3_ENTRY: MediaFormatEntry = {
  key: 'mp3',
  kind: 'audio',
  label: 'MP3',
}

const unavailable = (reason: string): MediaFormatsResult => ({
  available: false,
  reason,
  entries: [],
})

/** A global Cookie header or ambient credentials must never reach yt-dlp. */
export function buildYtdlpFormatsArgs(
  url: string,
  options: { proxy?: string } = {}
): string[] {
  const args = safeYtdlpArgs(options.proxy)
  if (!args || !isPublicMediaUrl(url)) {
    throw new Error('Unsupported public media request')
  }
  return args
}

function directFormats(info: RawFormatsInfo): RawListFormat[] {
  if (!Array.isArray(info?.formats)) return []
  return info.formats.filter((value): value is RawListFormat => {
    if (!value || typeof value !== 'object') return false
    const format = value as RawListFormat
    return (
      typeof format.url === 'string' &&
      isPublicMediaUrl(format.url) &&
      (format.protocol === undefined ||
        format.protocol === 'http' ||
        format.protocol === 'https') &&
      format.has_drm !== true
    )
  })
}

function hasCodec(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value !== 'none'
}

function safeSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/** Offer only HTTP(S) choices the current direct/mux resolver can execute. */
export function parseFormatEntries(
  info: RawFormatsInfo,
  muxAvailable = true
): MediaFormatEntry[] {
  const formats = directFormats(info)
  const hasAudioOnly = formats.some(
    (format) => hasCodec(format.acodec) && !hasCodec(format.vcodec)
  )
  const byHeight = new Map<
    number,
    { entry: MediaFormatEntry; mp4: boolean; tbr: number }
  >()
  for (const format of formats) {
    const height = format.height
    if (
      typeof height !== 'number' ||
      !Number.isInteger(height) ||
      height < 100 ||
      height > MAX_HEIGHT ||
      !hasCodec(format.vcodec)
    )
      continue
    const progressive = hasCodec(format.acodec)
    if (!progressive && (!muxAvailable || !hasAudioOnly)) continue
    const ext =
      typeof format.ext === 'string' && /^[a-zA-Z0-9]{1,16}$/.test(format.ext)
        ? format.ext.toLowerCase()
        : undefined
    const fps =
      typeof format.fps === 'number' &&
      Number.isFinite(format.fps) &&
      format.fps > 0 &&
      format.fps <= 1000
        ? format.fps
        : undefined
    // A video-only source does not describe the total bytes of a mux choice.
    const sizeBytes = progressive
      ? (safeSize(format.filesize) ?? safeSize(format.filesize_approx))
      : undefined
    const entry: MediaFormatEntry = {
      key: `${height}p`,
      kind: 'video',
      label: `${height}p`,
      height,
      ...(fps !== undefined ? { fps } : {}),
      ...(ext ? { ext } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    }
    const pick = {
      entry,
      mp4: ext === 'mp4' || ext === 'm4v',
      tbr:
        typeof format.tbr === 'number' && Number.isFinite(format.tbr)
          ? format.tbr
          : 0,
    }
    const current = byHeight.get(height)
    if (
      !current ||
      (pick.mp4 && !current.mp4) ||
      (pick.mp4 === current.mp4 && pick.tbr > current.tbr)
    )
      byHeight.set(height, pick)
  }
  return [...byHeight.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, MAX_VIDEO_ROWS)
    .map(([, pick]) => pick.entry)
}

/** No result cache or shared in-flight request can outlive an authorization. */
export function createYtdlpFormatLister(
  deps: YtdlpFormatListerDeps
): YtdlpFormatLister {
  return async (req, signal) => {
    throwIfYtdlpAborted(signal)
    if (req.cookies?.length) return unavailable('credentials-unsupported')
    const url = canonicalPublicMediaUrl(req.url)
    if (!url) return unavailable('not-allowed')
    const policy = (): { failure: MediaFormatsResult } | { args: string[] } => {
      const options = deps.readOptions?.() ?? { enabled: false }
      if (!options.enabled) return { failure: unavailable('disabled') }
      if (options.proxyUnsupportedReason)
        return { failure: unavailable(options.proxyUnsupportedReason) }
      if (!options.allUrls && !deps.isMediaSite(url))
        return { failure: unavailable('not-allowed') }
      const args = safeYtdlpArgs(options.proxy)
      return args
        ? { args }
        : { failure: unavailable('proxy-credentials-unsupported') }
    }
    const initial = policy()
    if ('failure' in initial) return initial.failure
    try {
      const binaryPath = await deps.resolveBinaryPath(signal)
      throwIfYtdlpAborted(signal)
      const current = policy()
      if ('failure' in current) return current.failure
      if (!binaryPath) return unavailable('binary-missing')
      const result = await spawnResolve(
        binaryPath,
        current.args,
        FORMAT_TIMEOUT_MS,
        deps.spawnImpl ?? (nodeSpawn as unknown as SpawnLike),
        { ...(signal ? { signal } : {}), input: `${url}\n` }
      )
      throwIfYtdlpAborted(signal)
      const after = policy()
      if ('failure' in after) return after.failure
      if (result.code !== 0)
        return unavailable(
          looksUnsupported(result.stderr) ? 'unsupported' : 'failed'
        )
      const info = parseYtdlpStdout<RawFormatsInfo>(result.stdout)
      const entries = parseFormatEntries(
        info,
        req.muxAvailable ?? req.audioExtractAvailable
      )
      if (
        req.audioExtractAvailable &&
        directFormats(info).some((format) => hasCodec(format.acodec))
      )
        entries.push(MP3_ENTRY)
      if (entries.length === 0) return unavailable('unsupported')
      const parsed = MediaFormatsResultSchema.safeParse({
        available: true,
        entries,
        ...(typeof info.title === 'string'
          ? { title: info.title.slice(0, 500) }
          : {}),
        ...(typeof info.duration === 'number' &&
        Number.isFinite(info.duration) &&
        info.duration >= 0
          ? { durationSec: info.duration }
          : {}),
      })
      return parsed.success ? parsed.data : unavailable('failed')
    } catch (error) {
      if (isYtdlpAbort(error)) throw error
      return unavailable(
        error instanceof YtdlpExecutionError ? error.reason : 'failed'
      )
    }
  }
}
