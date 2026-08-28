import type {
  ProxyConfig,
  SourceFetchStatus,
  SyncResult,
  TrackerSource,
} from '@shared/types/tracker'
import { trackerLogger } from './logger'
import { createTrackerHttpClient } from './tracker-http-client'

const log = trackerLogger('syncer')

const ALLOWED_TRACKER_PROTOCOLS = [
  'udp://',
  'http://',
  'https://',
  'ws://',
  'wss://',
] as const

function isValidTrackerLine(line: string): boolean {
  if (line.length === 0) return false
  if (line.startsWith('#')) return false
  return ALLOWED_TRACKER_PROTOCOLS.some((scheme) => line.startsWith(scheme))
}

export class TrackerSyncer {
  async fetch(
    sources: TrackerSource[],
    proxy?: ProxyConfig
  ): Promise<SyncResult> {
    const enabled = sources.filter((s) => s.enabled)
    if (enabled.length === 0) {
      log.warn(
        { totalSources: sources.length },
        'fetch skipped: no enabled sources'
      )
      return { trackers: [], sourceStatus: {} }
    }

    log.info(
      { enabledSources: enabled.length, proxy: Boolean(proxy) },
      'fetch start'
    )
    const httpClient = await createTrackerHttpClient(proxy)
    const now = Date.now()

    let entries: PromiseSettledResult<{
      id: string
      urls: string[]
      elapsedMs: number
    }>[]
    try {
      entries = await Promise.allSettled(
        enabled.map(async (src) => {
          const start = Date.now()
          const res = await httpClient.fetch(`${src.url}?t=${now}`, {
            signal: AbortSignal.timeout(30_000),
          })
          const text = await res.text()
          const urls = [
            ...new Set(
              text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(isValidTrackerLine)
            ),
          ]
          return {
            id: src.id,
            urls,
            elapsedMs: Date.now() - start,
          }
        })
      )
    } finally {
      await httpClient.close()
    }

    const seen = new Set<string>()
    const sourceStatus: Record<string, SourceFetchStatus> = {}

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const src = enabled[i]
      if (entry.status === 'fulfilled') {
        for (const url of entry.value.urls) {
          seen.add(url)
        }
        sourceStatus[src.id] = {
          ok: true,
          count: entry.value.urls.length,
          elapsedMs: entry.value.elapsedMs,
          urls: entry.value.urls,
        }
        log.debug(
          {
            id: src.id,
            count: entry.value.urls.length,
            elapsedMs: entry.value.elapsedMs,
          },
          'source fetched'
        )
      } else {
        const error = entry.reason?.message ?? 'Unknown error'
        sourceStatus[src.id] = {
          ok: false,
          count: 0,
          elapsedMs: 0,
          error,
        }
        log.warn(
          { id: src.id, url: src.url, error, err: entry.reason },
          'source fetch failed'
        )
      }
    }

    const okCount = Object.values(sourceStatus).filter((s) => s.ok).length
    const failCount = Object.values(sourceStatus).length - okCount
    log.info(
      {
        uniqueTrackers: seen.size,
        okSources: okCount,
        failedSources: failCount,
      },
      'fetch done'
    )

    return { trackers: [...seen], sourceStatus }
  }
}
