import { onOperatorSessionLost } from '@renderer/lib/operator-auth'
// src/renderer/hooks/use-global-speed-history.ts
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { GlobalStats, SpeedPoint } from '@shared/types/stats'
import { useSyncExternalStore } from 'react'

const MAX_POINTS = 200
const MOCK_STEP_MS = 1000
const IDLE_SAMPLE_STEP_MS = 1_000
// Idle engine polls arrive every 10s. Stop holding zero if confirmation is stale.
const IDLE_CONFIRMATION_MAX_AGE_MS = 15_000

const MOCK_DOWNLOAD_MBPS = [
  0, 0, 0, 0, 5, 52, 0, 0, 0, 0, 0, 26, 0, 0, 0, 0, 3, 8, 15, 38, 63,
]

const MOCK_UPLOAD_BPS = [
  120, 120, 130, 160, 180, 220, 260, 250, 240, 230, 220, 210, 200, 210, 220,
  210, 190, 180, 170, 160, 696,
]

let store: readonly SpeedPoint[] = []
const listeners = new Set<() => void>()
let sessionEpoch = 0
let initialized = false
let initializing = false
let pendingTail: SpeedPoint[] = []
let idleConfirmedAt: number | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let stopConnectionListener: (() => void) | undefined

function stopIdleClock() {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleClock() {
  stopIdleClock()
  if (
    idleConfirmedAt === null ||
    Date.now() - idleConfirmedAt >= IDLE_CONFIRMATION_MAX_AGE_MS ||
    listeners.size === 0 ||
    document.hidden ||
    initializing
  ) {
    return
  }

  const nextSampleAt = (store.at(-1)?.t ?? Date.now()) + IDLE_SAMPLE_STEP_MS
  idleTimer = setTimeout(
    () => {
      idleTimer = null
      if (
        idleConfirmedAt === null ||
        Date.now() - idleConfirmedAt >= IDLE_CONFIRMATION_MAX_AGE_MS
      ) {
        return
      }
      // Display-only zero tail between confirmed idle polls; no extra engine RPC.
      appendPoint({ t: Date.now(), down: 0, up: 0 })
      scheduleIdleClock()
    },
    Math.max(0, nextSampleAt - Date.now())
  )
}

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
  // Engines can retain their last measured rate after the final task stops.
  const idle = stats.activeTasks === 0
  const point: SpeedPoint = {
    t: Date.now(),
    down: idle ? 0 : stats.totalDownloadSpeed,
    up: idle ? 0 : stats.totalUploadSpeed,
  }
  idleConfirmedAt = idle ? point.t : null
  stopIdleClock()
  if (initializing) {
    pendingTail.push(point)
  } else {
    const tail = store.at(-1)
    // A real idle poll can land just after the display clock. Confirm it
    // without adding a second zero vertex or restarting an in-flight slide.
    if (
      idleConfirmedAt === null ||
      !tail ||
      tail.down !== 0 ||
      tail.up !== 0 ||
      point.t < tail.t ||
      point.t - tail.t >= IDLE_SAMPLE_STEP_MS
    ) {
      appendPoint(point)
    }
    scheduleIdleClock()
  }
}

function initialize() {
  if (initialized || initializing) return
  initializing = true
  const epoch = sessionEpoch
  transport.on(Events.StatsUpdated, onStatsEvent)
  stopConnectionListener = transport.onConnectionChange?.(({ state }) => {
    if (state === 'connected') return
    idleConfirmedAt = null
    stopIdleClock()
  })
  void transport
    .invoke(Queries.GetSpeedHistory, { limit: MAX_POINTS })
    .then((data) => {
      if (epoch !== sessionEpoch) return
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
      scheduleIdleClock()
    })
    .catch(() => {
      if (epoch !== sessionEpoch) return
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
      stopConnectionListener?.()
      stopConnectionListener = undefined
      initializing = false
      pendingTail = []
    })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', scheduleIdleClock)
    scheduleIdleClock()
  }
  if (!initialized && !initializing) initialize()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      stopIdleClock()
      document.removeEventListener('visibilitychange', scheduleIdleClock)
    }
  }
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
  stopIdleClock()
  idleConfirmedAt = null
  stopConnectionListener?.()
  stopConnectionListener = undefined
  document.removeEventListener('visibilitychange', scheduleIdleClock)
  transport.off(Events.StatsUpdated, onStatsEvent)
  store = []
  listeners.clear()
  initialized = false
  initializing = false
  pendingTail = []
}

onOperatorSessionLost(() => {
  sessionEpoch++
  stopIdleClock()
  idleConfirmedAt = null
  stopConnectionListener?.()
  stopConnectionListener = undefined
  transport.off(Events.StatsUpdated, onStatsEvent)
  store = []
  pendingTail = []
  initialized = false
  initializing = false
  notify()
})
