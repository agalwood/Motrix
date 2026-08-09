import type {
  ProxyConfig,
  SourceFetchStatus,
  SyncResult,
  TrackerSource,
} from '@shared/types/tracker'
import { trackerLogger } from './logger'

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
    const dispatcher = proxy ? await this.buildProxyAgent(proxy) : undefined
    const now = Date.now()

    const entries = await Promise.allSettled(
      enabled.map(async (src) => {
        const start = Date.now()
        const res = await fetch(`${src.url}?t=${now}`, {
          signal: AbortSignal.timeout(30_000),
          ...(dispatcher ? { dispatcher } : {}),
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
        log.warn({ id: src.id, url: src.url, error }, 'source fetch failed')
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

  private async buildProxyAgent(
    proxy: ProxyConfig
  ): Promise<import('undici').ProxyAgent | undefined> {
    try {
      const { ProxyAgent } = await import('undici')
      let uri = proxy.server
      if (proxy.username) {
        const url = new URL(uri)
        url.username = proxy.username
        url.password = proxy.password ?? ''
        uri = url.toString()
      }
      return new ProxyAgent(uri)
    } catch {
      return undefined
    }
  }
}
