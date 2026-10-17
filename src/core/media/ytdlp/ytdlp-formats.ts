import { spawn as nodeSpawn } from 'node:child_process'
import { getLogger } from '@core/logger'
import type {
  MediaFormatEntry,
  MediaFormatsResult,
} from '@shared/schemas/media-formats'
import type { SpawnLike } from './ytdlp-locator'
import {
  looksUnsupported,
  parseYtdlpStdout,
  spawnResolve,
} from './ytdlp-resolver'

/**
 * yt-dlp backed format listing — the source of truth behind the grab
 * overlay's quality picker.
 *
 * Runs `yt-dlp --dump-single-json` WITHOUT a `-f` selector so the info blob
 * keeps every format the extractor offers, then collapses them into one row
 * per available height (prefer direct protocol, then mp4, then bandwidth)
 * plus the synthesized MP3 extraction row. Results are cached per URL +
 * cookie header so a playing video never pays a second yt-dlp spawn inside
 * the TTL, and concurrent asks for the same key share one spawn.
 *
 * Every failure degrades to `{ available: false, reason }` — the overlay
 * falls back to its sniffed rows, never an error state.
 */

const FORMAT_TIMEOUT_MS = 60_000
/** One row per height is plenty; extreme multi-version lists stay scrollable. */
const MAX_VIDEO_ROWS = 12
const MAX_HEIGHT = 4320
const DEFAULT_CACHE_TTL_MS = 60_000

export interface YtdlpFormatListRequest {
  url: string
  /** Cookie header captured from the caller's browser session. */
  cookieHeader?: string
  /** FFmpeg present → append the synthesized MP3 extraction row. */
  audioExtractAvailable: boolean
}

export interface YtdlpFormatListerDeps {
  /** Resolves the yt-dlp binary path; returns null when yt-dlp is absent. */
  resolveBinaryPath: () => Promise<string | null>
  readOptions?: () => {
    enabled: boolean
    proxy?: string
    allUrls?: boolean
  }
  isMediaSite: (url: string) => boolean
  spawnImpl?: SpawnLike
  /** Injectable clock for the cache (tests drive it). */
  now?: () => number
  cacheTtlMs?: number
}

export interface YtdlpFormatLister {
  (req: YtdlpFormatListRequest): Promise<MediaFormatsResult>
  /** Drop cached listings — call when Settings change. */
  clearCache(): void
}

interface RawListFormat {
  ext?: string
  protocol?: string
  vcodec?: string
  height?: number
  fps?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

interface RawFormatsInfo {
  title?: string
  duration?: number
  formats?: RawListFormat[]
}

const MP3_ENTRY: MediaFormatEntry = {
  key: 'mp3',
  kind: 'audio',
  label: 'MP3',
}

function isDirectProtocol(protocol: string | undefined): boolean {
  return protocol === undefined || protocol === 'https' || protocol === 'http'
}

/**
 * Build yt-dlp args for a format listing. Identical to the resolve args
 * minus `--format`: with a selector applied, a page whose best format is
 * unavailable errors out instead of LISTING what it does offer.
 */
export function buildYtdlpFormatsArgs(
  url: string,
  options: {
    proxy?: string
    cookieHeader?: string
  } = {}
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
  ]
  if (options.proxy?.trim()) args.push('--proxy', options.proxy.trim())
  if (options.cookieHeader?.trim()) {
    args.push('--add-header', `Cookie:${options.cookieHeader.trim()}`)
  }
  // `--` stops option parsing, so a URL beginning with `-` cannot inject flags.
  args.push('--', url)
  return args
}

/**
 * Collapse an info blob's `formats[]` into picker rows: one entry per
 * distinct height, preferring a direct-protocol mp4 at the highest bitrate,
 * sorted tallest first. Image/storyboard and audio-only entries are dropped;
 * the MP3 row is synthesized by the caller (it depends on FFmpeg, not on the
 * page).
 */
export function parseFormatEntries(info: RawFormatsInfo): MediaFormatEntry[] {
  interface VideoPick {
    height: number
    fps?: number
    ext?: string
    sizeBytes?: number
    direct: boolean
    mp4: boolean
    tbr: number
  }
  const byHeight = new Map<number, VideoPick>()
  for (const format of info.formats ?? []) {
    const height = format.height
    if (typeof height !== 'number' || !Number.isFinite(height)) continue
    if (height <= 0 || height > MAX_HEIGHT || !Number.isInteger(height))
      continue
    const vcodec = format.vcodec
    if (!vcodec || vcodec === 'none') continue // storyboard / audio-only
    const ext = format.ext?.toLowerCase()
    const sizeBytes = pickSize(format)
    const pick: VideoPick = {
      height,
      ...(typeof format.fps === 'number' && format.fps > 0
        ? { fps: format.fps }
        : {}),
      ...(ext ? { ext } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      direct: isDirectProtocol(format.protocol),
      mp4: ext === 'mp4' || ext === 'm4v',
      tbr: typeof format.tbr === 'number' && format.tbr > 0 ? format.tbr : 0,
    }
    const current = byHeight.get(height)
    if (!current) {
      byHeight.set(height, pick)
      continue
    }
    const better =
      (pick.direct && !current.direct) ||
      (pick.direct === current.direct && pick.mp4 && !current.mp4) ||
      (pick.direct === current.direct &&
        pick.mp4 === current.mp4 &&
        pick.tbr > current.tbr)
    if (better) byHeight.set(height, pick)
  }
  return [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .slice(0, MAX_VIDEO_ROWS)
    .map((pick) => ({
      key: `${pick.height}p`,
      kind: 'video' as const,
      label: `${pick.height}p`,
      height: pick.height,
      ...(pick.fps !== undefined ? { fps: pick.fps } : {}),
      ...(pick.ext !== undefined ? { ext: pick.ext } : {}),
      ...(pick.sizeBytes !== undefined ? { sizeBytes: pick.sizeBytes } : {}),
    }))
}

function pickSize(format: RawListFormat): number | undefined {
  const size = format.filesize ?? format.filesize_approx
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return undefined
  }
  return Math.round(size)
}

type ListOutcome =
  | {
      status: 'ok'
      entries: MediaFormatEntry[]
      title?: string
      durationSec?: number
    }
  | { status: 'unsupported' | 'failed' }

async function runFormatList(
  binaryPath: string,
  req: YtdlpFormatListRequest,
  proxy: string | undefined,
  spawnImpl: SpawnLike
): Promise<ListOutcome> {
  const log = getLogger('ytdlp-formats')
  const execute = async (cookieHeader?: string) => {
    const args = buildYtdlpFormatsArgs(req.url, {
      ...(proxy ? { proxy } : {}),
      ...(cookieHeader ? { cookieHeader } : {}),
    })
    try {
      return await spawnResolve(binaryPath, args, FORMAT_TIMEOUT_MS, spawnImpl)
    } catch (err) {
      log.warn({ url: req.url, err }, 'yt-dlp format spawn failed')
      return null
    }
  }

  let result = await execute(req.cookieHeader)
  // If listing failed while using browser cookies, retry without cookies:
  // many extractors succeed publicly without session cookies that may trigger bot challenges.
  if (result?.code !== 0 && req.cookieHeader) {
    log.info(
      { url: req.url, code: result?.code, stderr: result?.stderr },
      'yt-dlp format listing failed with cookies; retrying without cookies'
    )
    const fallback = await execute(undefined)
    if (fallback && fallback.code === 0) {
      result = fallback
    }
  }

  if (!result) {
    return { status: 'failed' }
  }
  if (result.code !== 0) {
    log.warn(
      { url: req.url, code: result.code, stderr: result.stderr },
      'yt-dlp format listing failed'
    )
    return {
      status: looksUnsupported(result.stderr) ? 'unsupported' : 'failed',
    }
  }
  try {
    const info = parseYtdlpStdout<RawFormatsInfo>(result.stdout)
    return {
      status: 'ok',
      entries: parseFormatEntries(info),
      ...(info.title ? { title: info.title } : {}),
      ...(typeof info.duration === 'number' && info.duration > 0
        ? { durationSec: info.duration }
        : {}),
    }
  } catch (err) {
    log.warn({ url: req.url, err }, 'yt-dlp format listing stdout was not JSON')
    return { status: 'failed' }
  }
}

/**
 * Build the format lister. Mirrors the resolver's policy gates (enabled,
 * allowlist, binary probe) so a URL the submit path would decline is also a
 * URL this method declines — the picker can never promise a quality the
 * submit would then refuse.
 */
export function createYtdlpFormatLister(
  deps: YtdlpFormatListerDeps
): YtdlpFormatLister {
  const now = deps.now ?? Date.now
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const cache = new Map<string, { at: number; result: MediaFormatsResult }>()
  const inFlight = new Map<string, Promise<MediaFormatsResult>>()

  const lister = (async (
    req: YtdlpFormatListRequest
  ): Promise<MediaFormatsResult> => {
    const options = deps.readOptions?.() ?? { enabled: true }
    const key = `${req.url}\n${req.cookieHeader ?? ''}\n${req.audioExtractAvailable}`
    const cached = cache.get(key)
    if (cached && now() - cached.at < ttlMs) return cached.result
    const pending = inFlight.get(key)
    if (pending) return pending

    const flight = (async (): Promise<MediaFormatsResult> => {
      const unavailable = (reason: string): MediaFormatsResult => ({
        available: false,
        reason,
        entries: [],
      })
      if (!options.enabled) return unavailable('disabled')
      if (!options.allUrls && !deps.isMediaSite(req.url)) {
        return unavailable('not-allowed')
      }
      const binaryPath = await deps.resolveBinaryPath()
      if (!binaryPath) return unavailable('binary-missing')
      const outcome = await runFormatList(
        binaryPath,
        req,
        options.proxy,
        deps.spawnImpl ?? (nodeSpawn as unknown as SpawnLike)
      )
      if (outcome.status !== 'ok') return unavailable(outcome.status)
      const entries = [...outcome.entries]
      if (req.audioExtractAvailable) entries.push(MP3_ENTRY)
      return {
        available: true,
        ...(outcome.title ? { title: outcome.title } : {}),
        ...(outcome.durationSec !== undefined
          ? { durationSec: outcome.durationSec }
          : {}),
        entries,
      }
    })().then(
      (result) => {
        // Cache successful outcomes for the full TTL. Failures are cached for
        // only 2 seconds so subsequent requests or user retries can recover quickly.
        const effectiveAt = result.available ? now() : now() - (ttlMs - 2000)
        cache.set(key, { at: effectiveAt, result })
        inFlight.delete(key)
        return result
      },
      () => {
        inFlight.delete(key)
        return { available: false, reason: 'failed', entries: [] }
      }
    )
    inFlight.set(key, flight)
    return flight
  }) as YtdlpFormatLister

  lister.clearCache = () => cache.clear()
  return lister
}
