import {
  TRACKER_MAX_SOURCE_BYTES,
  TRACKER_MAX_SOURCE_URLS,
  type TrackerSourceSnapshot,
} from '@shared/schemas/tracker-state'
import type {
  ProxyConfig,
  SourceFetchStatus,
  SyncResult,
  TrackerSource,
} from '@shared/types/tracker'
import { trackerLogger } from './logger'
import {
  createTrackerHttpClient,
  type TrackerResponse,
} from './tracker-http-client'
import { normalizeTrackerUrl } from './tracker-selector'

const log = trackerLogger('syncer')
class SourceError extends Error {
  constructor(
    readonly code: NonNullable<SourceFetchStatus['failure']>,
    readonly retryAfterMs?: number
  ) {
    super(code)
  }
}
async function readLimited(response: TrackerResponse): Promise<string> {
  if (
    Number(response.headers?.get('content-length') ?? 0) >
    TRACKER_MAX_SOURCE_BYTES
  ) {
    await response.body
      ?.getReader()
      .cancel()
      .catch(() => undefined)
    throw new SourceError('limit')
  }
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > TRACKER_MAX_SOURCE_BYTES)
      throw new SourceError('limit')
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      length += value.length
      if (length > TRACKER_MAX_SOURCE_BYTES) throw new SourceError('limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}
export function parseTrackerSource(text: string): string[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (lines.some((line) => /[<>]/.test(line))) throw new SourceError('invalid')
  const urls = [
    ...new Set(
      lines
        .map(normalizeTrackerUrl)
        .filter((url): url is string => url !== null)
    ),
  ]
  if (lines.length && !urls.length) throw new SourceError('invalid')
  if (urls.length > TRACKER_MAX_SOURCE_URLS) throw new SourceError('limit')
  return urls
}

export class TrackerSyncer {
  async fetch(
    sources: TrackerSource[],
    proxy?: ProxyConfig,
    cache: Record<string, TrackerSourceSnapshot> = {},
    signal?: AbortSignal
  ): Promise<SyncResult> {
    const enabled = sources.filter((source) => source.enabled)
    if (!enabled.length) return { trackers: [], sourceStatus: {} }
    const client = await createTrackerHttpClient(proxy)
    const sourceStatus: Record<string, SourceFetchStatus> = {}
    let index = 0
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, enabled.length) }, async () => {
          while (index < enabled.length) {
            const src = enabled[index++]
            const start = Date.now()
            const old =
              cache[src.id]?.url === src.url ? cache[src.id] : undefined
            try {
              const headers: Record<string, string> = {}
              if (old?.etag) headers['If-None-Match'] = old.etag
              if (old?.lastModified)
                headers['If-Modified-Since'] = old.lastModified
              const response = await client.fetch(src.url, {
                headers,
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                  : AbortSignal.timeout(30_000),
              })
              const status = response.status ?? 200
              if (status === 304 && old?.lastSuccessAt == null)
                throw new SourceError('missing-cache')
              if (status !== 304 && (status < 200 || status >= 300)) {
                const retry = response.headers?.get('retry-after')
                const delay = retry
                  ? /^\d+$/.test(retry)
                    ? Number(retry) * 1000
                    : Date.parse(retry) - Date.now()
                  : undefined
                await response.body
                  ?.getReader()
                  .cancel()
                  .catch(() => undefined)
                throw new SourceError(
                  'http',
                  delay && Number.isFinite(delay)
                    ? Math.max(0, Math.min(delay, 12 * 3_600_000))
                    : undefined
                )
              }
              const urls =
                status === 304 && old
                  ? old.urls
                  : parseTrackerSource(await readLimited(response))
              sourceStatus[src.id] = {
                ok: true,
                count: urls.length,
                elapsedMs: Date.now() - start,
                urls,
                notModified: status === 304,
                etag:
                  response.headers?.get('etag') ??
                  (status === 304 ? old?.etag : undefined),
                lastModified:
                  response.headers?.get('last-modified') ??
                  (status === 304 ? old?.lastModified : undefined),
              }
            } catch (error) {
              const failure =
                error instanceof SourceError ? error.code : 'network'
              sourceStatus[src.id] = {
                ok: false,
                count: 0,
                elapsedMs: Date.now() - start,
                failure,
                error: failure,
                retryAfterMs:
                  error instanceof SourceError ? error.retryAfterMs : undefined,
              }
              // Do not log source URLs or raw fetch errors containing credentials.
              log.warn({ id: src.id, failure }, 'source fetch failed')
            }
          }
        })
      )
    } finally {
      await client.close()
    }
    return {
      trackers: [
        ...new Set(
          Object.values(sourceStatus).flatMap((status) => status.urls ?? [])
        ),
      ],
      sourceStatus,
    }
  }
}
