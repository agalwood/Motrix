import {
  TRACKER_MAX_CANDIDATES,
  TRACKER_PROBE_FRESH_MS,
  TRACKER_SOURCE_MAX_AGE_MS,
  type TrackerCandidate,
  type TrackerSourceSnapshot,
} from '@shared/schemas/tracker-state'
import type { TrackerSettings } from '@shared/types/settings'
import type { TrackerHealth, TrackerSource } from '@shared/types/tracker'

export function sourceKey(kind: 'tracker' | 'blacklist', id: string): string {
  return `${kind}:${id}`
}

export function normalizeTrackerUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(url.protocol))
      return null
    if (!url.hostname || (url.protocol === 'udp:' && !url.port)) return null
    // Query/path spelling and authentication parameters are preserved.
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

export function collectSourceUrls(
  sources: TrackerSource[],
  snapshots: Record<string, TrackerSourceSnapshot>,
  kind: 'tracker' | 'blacklist',
  now: number
): Record<string, string[]> {
  const urls: Record<string, string[]> = {}
  for (const source of sources) {
    if (!source.enabled) continue
    const snapshot = snapshots[sourceKey(kind, source.id)]
    if (
      !snapshot ||
      snapshot.url !== source.url ||
      snapshot.lastSuccessAt === null ||
      now - snapshot.lastSuccessAt > TRACKER_SOURCE_MAX_AGE_MS
    )
      continue
    for (const raw of snapshot.urls) {
      const url = normalizeTrackerUrl(raw)
      if (!url) continue
      if (!urls[url]) urls[url] = []
      if (!urls[url].includes(source.id)) urls[url].push(source.id)
    }
  }
  return urls
}

export function selectTrackers(input: {
  settings: TrackerSettings
  snapshots: Record<string, TrackerSourceSnapshot>
  health: Record<string, TrackerHealth>
  previous: string[]
  firstSeen: Record<string, number>
  now: number
  routeKey?: string
}): {
  effective: string[]
  blacklist: string[]
  sourceMap: Record<string, string[]>
  candidates: TrackerCandidate[]
  firstSeen: Record<string, number>
} {
  const { settings, snapshots, health, now } = input
  const sourceMap = settings.sourcesEnabled
    ? collectSourceUrls(settings.sources, snapshots, 'tracker', now)
    : {}
  const blockedMap = settings.blacklistEnabled
    ? collectSourceUrls(settings.blacklistSources, snapshots, 'blacklist', now)
    : {}
  const blocked = new Set(Object.keys(blockedMap))
  const previous = new Set(input.previous)
  const firstSeen = { ...input.firstSeen }
  const candidates = Object.entries(sourceMap)
    .slice(0, TRACKER_MAX_CANDIDATES)
    .map(([url, sourceIds]): TrackerCandidate => {
      firstSeen[url] ??= now
      const sample = health[url]
      const matchingRoute = sample?.routeKey === input.routeKey
      const recent =
        matchingRoute &&
        sample?.lastProbeAt != null &&
        now >= sample.lastProbeAt &&
        now - sample.lastProbeAt < TRACKER_PROBE_FRESH_MS
      const consecutiveFailures =
        sample?.samples?.slice(-3).filter((s) => !s.ok).length ??
        (sample?.status === 'unreachable' ? 1 : 0)
      return {
        url,
        sourceIds,
        firstSeenAt: firstSeen[url],
        reason: blocked.has(url)
          ? 'blacklisted'
          : /^wss?:/.test(url)
            ? 'unsupported'
            : settings.probeEnabled &&
                recent &&
                consecutiveFailures >= 3 &&
                sample.successRate < settings.minSuccessRate
              ? 'cooldown'
              : 'capacity',
      }
    })
  const eligible = candidates.filter((c) => c.reason === 'capacity')
  const known = (url: string) => {
    const h = health[url]
    return (
      h &&
      h.status !== 'unknown' &&
      h.routeKey === input.routeKey &&
      h.lastProbeAt != null &&
      now >= h.lastProbeAt &&
      now - h.lastProbeAt < TRACKER_PROBE_FRESH_MS
    )
  }
  const score = (url: string) => {
    const h = health[url]
    if (!settings.probeEnabled || !known(url))
      return previous.has(url) ? 0.05 : 0
    // Coarse latency buckets avoid replacing trackers for millisecond jitter.
    return (
      h.successRate * 10 +
      (h.status === 'unreachable' ? -4 : 1) +
      (previous.has(url) ? 0.25 : 0) -
      Math.min(5, Math.floor((h.lastProbeMs ?? 5000) / 1000)) * 0.1
    )
  }
  eligible.sort(
    (a, b) => score(b.url) - score(a.url) || a.url.localeCompare(b.url)
  )
  const effective: string[] = []
  const hosts = new Set<string>()
  const add = (candidate: TrackerCandidate) => {
    effective.push(candidate.url)
    hosts.add(new URL(candidate.url).hostname)
    candidate.reason = 'selected'
  }
  // A small bounded exploration allocation gives unmeasured endpoints a way in.
  const explorers = settings.probeEnabled
    ? eligible
        .filter((c) => !known(c.url))
        .slice(0, Math.max(1, Math.floor(settings.maxTrackerCount / 10)))
    : []
  const target = Math.min(settings.maxTrackerCount, eligible.length)
  const ranked = eligible.filter((c) => !explorers.includes(c))
  for (const c of ranked) {
    if (effective.length >= target - explorers.length) break
    if (!hosts.has(new URL(c.url).hostname)) add(c)
  }
  for (const c of explorers) {
    if (effective.length < target) add(c)
  }
  for (const c of eligible) {
    if (effective.length >= target) break
    if (c.reason !== 'selected') add(c)
  }
  return {
    effective,
    blacklist: [...blocked],
    sourceMap: Object.fromEntries(
      [...new Set([...Object.keys(blockedMap), ...Object.keys(sourceMap)])].map(
        (url) => [
          url,
          [...new Set([...(sourceMap[url] ?? []), ...(blockedMap[url] ?? [])])],
        ]
      )
    ),
    candidates,
    firstSeen,
  }
}
