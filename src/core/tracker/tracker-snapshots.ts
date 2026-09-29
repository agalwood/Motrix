import {
  TRACKER_MAX_CANDIDATES,
  type TrackerSourceSnapshot,
} from '@shared/schemas/tracker-state'
import type { SourceFetchStatus, TrackerSource } from '@shared/types/tracker'
import { sourceKey } from './tracker-selector'

export function mergeSourceSnapshots(
  snapshots: Record<string, TrackerSourceSnapshot>,
  sources: TrackerSource[],
  statuses: Record<string, SourceFetchStatus>,
  kind: 'tracker' | 'blacklist',
  now: number,
  eligibleSources: TrackerSource[] = sources
): Record<string, TrackerSourceSnapshot> {
  const result = { ...snapshots }
  for (const source of sources) {
    const status = statuses[source.id]
    if (!status) continue
    const key = sourceKey(kind, source.id)
    const old = result[key]?.url === source.url ? result[key] : undefined
    const urls = status.urls ?? []
    const otherUrls = new Set(
      Object.entries(result)
        .filter(
          ([id, s]) =>
            id !== key &&
            s.kind === kind &&
            eligibleSources.some(
              (source) =>
                source.enabled && source.id === s.id && source.url === s.url
            )
        )
        .flatMap(([, s]) => s.urls)
    )
    for (const url of urls) otherUrls.add(url)
    const ok = status.ok && otherUrls.size <= TRACKER_MAX_CANDIDATES
    const failures = ok ? 0 : (old?.failures ?? 0) + 1
    const delays = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000]
    result[key] = {
      id: source.id,
      url: source.url,
      kind,
      urls: ok ? urls : (old?.urls ?? []),
      lastAttemptAt: now,
      lastSuccessAt: ok ? now : (old?.lastSuccessAt ?? null),
      contentChangedAt:
        ok && (!old || old.urls.join('\n') !== urls.join('\n'))
          ? now
          : (old?.contentChangedAt ?? null),
      etag: ok ? status.etag : old?.etag,
      lastModified: ok ? status.lastModified : old?.lastModified,
      error: ok ? null : status.ok ? 'limit' : (status.failure ?? 'network'),
      failures,
      nextRetryAt: ok
        ? null
        : now +
          Math.max(
            delays[Math.min(failures - 1, delays.length - 1)],
            status.retryAfterMs ?? 0
          ),
    }
  }
  return result
}
