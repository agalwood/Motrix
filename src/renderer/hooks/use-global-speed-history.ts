// src/renderer/hooks/use-global-speed-history.ts
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { GlobalStats, SpeedPoint } from '@shared/types/stats'
import { useSyncExternalStore } from 'react'

const MAX_POINTS = 200
const MOCK_STEP_MS = 1000

const MOCK_DOWNLOAD_MBPS = [
  0, 0, 0, 0, 5, 52, 0, 0, 0, 0, 0, 26, 0, 0, 0, 0, 3, 8, 15, 38, 63,
]

const MOCK_UPLOAD_BPS = [
  120, 120, 130, 160, 180, 220, 260, 250, 240, 230, 220, 210, 200, 210, 220,
  210, 190, 180, 170, 160, 696,
]

let store: readonly SpeedPoint[] = []
const listeners = new Set<() => void>()
let initialized = false
let initializing = false
let pendingTail: SpeedPoint[] = []

function notify() {
  for (const cb of listeners) cb()
}

function appendPoint(point: SpeedPoint) {
  const next = [...store, point]
  store = next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next
  notify()
}

function shouldUseWebMock(): boolean {
  return typeof __MOTRIX_TARGET__ !== 'undefined' && __MOTRIX_TARGET__ === 'web'
}

function createMockSpeedHistory(): SpeedPoint[] {
  const now = Date.now()
  return MOCK_DOWNLOAD_MBPS.map((downMbps, i) => ({
    t: now - (MOCK_DOWNLOAD_MBPS.length - i - 1) * MOCK_STEP_MS,
    down: downMbps * 1024 * 1024,
    up: MOCK_UPLOAD_BPS[i],
  }))
}

function onStatsEvent(...args: unknown[]) {
  const stats = args[0] as GlobalStats
  const point: SpeedPoint = {
    t: Date.now(),
    down: stats.totalDownloadSpeed,
    up: stats.totalUploadSpeed,
  }
  if (initializing) {
    pendingTail.push(point)
  } else {
    appendPoint(point)
  }
}

function initialize() {
  if (initialized || initializing) return
  initializing = true
  transport.on(Events.StatsUpdated, onStatsEvent)
  void transport
    .invoke(Queries.GetSpeedHistory, { limit: MAX_POINTS })
    .then((data) => {
      const seed = data as readonly SpeedPoint[]
      const base =
        seed.length === 0 && pendingTail.length === 0 && shouldUseWebMock()
          ? createMockSpeedHistory()
          : seed
      const merged = [...base, ...pendingTail]
      store = merged.length > MAX_POINTS ? merged.slice(-MAX_POINTS) : merged
      pendingTail = []
      initialized = true
      initializing = false
      notify()
    })
    .catch(() => {
      if (shouldUseWebMock()) {
        store = createMockSpeedHistory()
        initialized = true
        initializing = false
        pendingTail = []
        notify()
        return
      }
      // reset so a later subscriber can retry without leaking the listener
      transport.off(Events.StatsUpdated, onStatsEvent)
      initializing = false
      pendingTail = []
    })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!initialized && !initializing) initialize()
  return () => listeners.delete(cb)
}

export function useGlobalSpeedHistory(): readonly SpeedPoint[] {
  return useSyncExternalStore(
    subscribe,
    () => store,
    () => store
  )
}

/** Internal: tests only. Resets the module-level singleton. */
export function __resetGlobalSpeedHistoryStoreForTests(): void {
  transport.off(Events.StatsUpdated, onStatsEvent)
  store = []
  listeners.clear()
  initialized = false
  initializing = false
  pendingTail = []
}
