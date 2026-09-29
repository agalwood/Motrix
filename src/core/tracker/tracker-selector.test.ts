import { DEFAULT_TRACKER_SETTINGS } from '@shared/schemas/tracker-settings'
import {
  TRACKER_SOURCE_MAX_AGE_MS,
  type TrackerSourceSnapshot,
} from '@shared/schemas/tracker-state'
import type { TrackerHealth, TrackerSource } from '@shared/types/tracker'
import { describe, expect, it } from 'vitest'
import { normalizeTrackerUrl, selectTrackers } from './tracker-selector'
import { mergeSourceSnapshots } from './tracker-snapshots'
import { TrackerStore } from './tracker-store'

const now = 1_790_000_000_000
const source = (id: string): TrackerSource => ({
  id,
  label: id,
  url: `https://${id}.example/list`,
  enabled: true,
  builtin: false,
  cdn: false,
})
const snapshot = (
  id: string,
  urls: string[],
  kind: 'tracker' | 'blacklist' = 'tracker'
): TrackerSourceSnapshot => ({
  id,
  url: source(id).url,
  kind,
  urls,
  lastAttemptAt: now,
  lastSuccessAt: now,
  contentChangedAt: now,
  error: null,
  failures: 0,
  nextRetryAt: null,
})
const healthy = (url: string): TrackerHealth => ({
  url,
  protocol: 'udp',
  status: 'healthy',
  lastProbeMs: 20,
  lastProbeAt: now,
  successCount: 1,
  failCount: 0,
  successRate: 1,
  routeKey: 'direct',
  samples: [{ at: now, ok: true }],
})
const base = () => ({
  settings: {
    ...DEFAULT_TRACKER_SETTINGS,
    sources: [source('s1')],
    blacklistSources: [source('b1')],
    blacklistEnabled: true,
    maxTrackerCount: 5,
  },
  snapshots: {} as Record<string, TrackerSourceSnapshot>,
  health: {} as Record<string, TrackerHealth>,
  previous: [] as string[],
  firstSeen: {},
  now,
  routeKey: 'direct',
})

describe('source-qualified tracker selection', () => {
  it('removes deleted source URLs even though real health merging retains them (#2249)', () => {
    const input = base()
    input.snapshots['tracker:s1'] = snapshot('s1', ['udp://old.test:80'])
    input.health = new TrackerStore('/unused').mergeHealth({}, [
      healthy('udp://old.test:80'),
    ])
    const first = selectTrackers(input)
    input.snapshots = mergeSourceSnapshots(
      input.snapshots,
      input.settings.sources,
      { s1: { ok: true, urls: ['udp://new.test:80'], count: 1, elapsedMs: 0 } },
      'tracker',
      now + 1
    )
    input.health = new TrackerStore('/unused').mergeHealth(input.health, [
      healthy('udp://new.test:80'),
    ])
    expect(input.health['udp://old.test:80']).toBeDefined()
    const second = selectTrackers({ ...input, previous: first.effective })
    expect(second.effective).toEqual(['udp://new.test:80'])
    expect(second.sourceMap['udp://old.test:80']).toBeUndefined()
  })

  it('keeps an address until all contributing sources remove it', () => {
    const input = base()
    input.settings.sources.push(source('s2'))
    input.snapshots = {
      'tracker:s1': snapshot('s1', []),
      'tracker:s2': snapshot('s2', ['udp://shared.test:80']),
    }
    const result = selectTrackers(input)
    expect(result.effective).toEqual(['udp://shared.test:80'])
    expect(result.sourceMap['udp://shared.test:80']).toEqual(['s2'])
    input.settings.sources[1].enabled = false
    expect(selectTrackers(input).effective).toEqual([])
  })

  it('rejects caches from a changed source URL and expired fallback caches', () => {
    const input = base()
    input.snapshots['tracker:s1'] = {
      ...snapshot('s1', ['udp://a:80']),
      lastSuccessAt: now - TRACKER_SOURCE_MAX_AGE_MS - 1,
    }
    expect(selectTrackers(input).effective).toEqual([])
    input.snapshots['tracker:s1'] = snapshot('s1', ['udp://a:80'])
    input.settings.sources[0].url += '?new'
    expect(selectTrackers(input).effective).toEqual([])
  })

  it('filters blacklist and unsupported protocols before allocating capacity', () => {
    const input = base()
    input.snapshots = {
      'tracker:s1': snapshot('s1', [
        'udp://a:80',
        'udp://b:80',
        'wss://ws.test/',
      ]),
      'blacklist:b1': snapshot('b1', ['udp://a:80'], 'blacklist'),
    }
    const result = selectTrackers(input)
    expect(result.effective).toEqual(['udp://b:80'])
    expect(result.candidates.map((c) => c.reason)).toEqual([
      'blacklisted',
      'selected',
      'unsupported',
    ])
    expect(result.sourceMap['udp://a:80']).toEqual(['s1', 'b1'])
  })

  it('uses recent repeated failures for cooldown, not lifetime failure counts', () => {
    const input = base()
    const url = 'udp://a:80'
    input.snapshots['tracker:s1'] = snapshot('s1', [url])
    input.health[url] = {
      ...healthy(url),
      status: 'unreachable',
      successCount: 0,
      failCount: 999,
      successRate: 0,
      samples: [{ at: now, ok: false }],
    }
    expect(selectTrackers(input).effective).toEqual([url])
    input.health[url].samples = Array.from({ length: 3 }, () => ({
      at: now,
      ok: false,
    }))
    expect(selectTrackers(input).candidates[0].reason).toBe('cooldown')
    expect(
      selectTrackers({ ...input, routeKey: 'new-network' }).effective
    ).toEqual([url])
    expect(
      selectTrackers({ ...input, now: now + 13 * 3600_000 }).effective
    ).toEqual([url])
  })

  it('reserves bounded space for new addresses and prefers distinct hosts', () => {
    const input = base()
    const known = Array.from(
      { length: 8 },
      (_, i) => `udp://known${i % 4}.test:${8000 + i}`
    )
    input.snapshots['tracker:s1'] = snapshot('s1', [
      ...known,
      'udp://new.test:80',
    ])
    input.health = Object.fromEntries(known.map((url) => [url, healthy(url)]))
    const result = selectTrackers(input)
    expect(result.effective).toHaveLength(5)
    expect(result.effective).toContain('udp://new.test:80')
    expect(
      new Set(result.effective.map((url) => new URL(url).hostname)).size
    ).toBe(5)
    expect(
      selectTrackers({ ...input, previous: result.effective }).effective
    ).toEqual(result.effective)
  })

  it('preserves firstSeen and the query/path spelling used for authentication', () => {
    expect(
      normalizeTrackerUrl(
        'HTTP://EXAMPLE.COM:80/Announce?passkey=A%2FB&x=1#fragment'
      )
    ).toBe('http://example.com/Announce?passkey=A%2FB&x=1')
    const input = base()
    input.snapshots['tracker:s1'] = snapshot('s1', ['udp://a:80'])
    const first = selectTrackers(input)
    expect(
      selectTrackers({ ...input, firstSeen: first.firstSeen, now: now + 1000 })
        .candidates[0].firstSeenAt
    ).toBe(now)
  })
})

describe('per-source snapshot commits', () => {
  it('retains failed source cache, accepts an empty successful list, and records backoff independently', () => {
    const old = {
      'tracker:s1': snapshot('s1', ['udp://a:80']),
      'tracker:s2': snapshot('s2', ['udp://b:80']),
    }
    const result = mergeSourceSnapshots(
      old,
      [source('s1'), source('s2')],
      {
        s1: { ok: false, count: 0, elapsedMs: 0, failure: 'network' },
        s2: { ok: true, count: 0, elapsedMs: 0, urls: [] },
      },
      'tracker',
      now + 100
    )
    expect(result['tracker:s1']).toMatchObject({
      urls: ['udp://a:80'],
      lastSuccessAt: now,
      failures: 1,
      nextRetryAt: now + 100 + 300_000,
    })
    expect(result['tracker:s2']).toMatchObject({
      urls: [],
      lastSuccessAt: now + 100,
      contentChangedAt: now + 100,
    })
  })

  it('304 renews freshness without pretending the content changed', () => {
    const old = { 'tracker:s1': snapshot('s1', ['udp://a:80']) }
    const result = mergeSourceSnapshots(
      old,
      [source('s1')],
      {
        s1: {
          ok: true,
          count: 1,
          elapsedMs: 0,
          urls: ['udp://a:80'],
          notModified: true,
        },
      },
      'tracker',
      now + 100
    )
    expect(result['tracker:s1']).toMatchObject({
      lastSuccessAt: now + 100,
      contentChangedAt: now,
    })
  })
})
