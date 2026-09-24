import { useSyncExternalStore } from 'react'

type ClockListener = () => void

const listeners = new Set<ClockListener>()
const SERVER_SNAPSHOT = 0

let snapshot = Date.now()
let timer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

function scheduleNextMinute(): void {
  if (timer !== null || listeners.size === 0) return

  const now = Date.now()
  const remainder = now % 60_000
  const delay = remainder === 0 ? 60_000 : 60_000 - remainder
  timer = setTimeout(() => {
    timer = null
    snapshot = Date.now()
    notify()
    scheduleNextMinute()
  }, delay)
}

function refresh(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  snapshot = Date.now()
  notify()
  scheduleNextMinute()
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') refresh()
}

function removeResumeListeners(): void {
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

function subscribe(listener: ClockListener): () => void {
  const starting = listeners.size === 0
  listeners.add(listener)
  if (starting) {
    snapshot = Date.now()
    scheduleNextMinute()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (timer !== null) clearTimeout(timer)
      timer = null
      removeResumeListeners()
    }
  }
}

function getSnapshot(): number {
  return snapshot
}

function getServerSnapshot(): number {
  return SERVER_SNAPSHOT
}

export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Internal: tests only. */
export function __resetMinuteClockForTests(): void {
  removeResumeListeners()
  if (timer !== null) clearTimeout(timer)
  timer = null
  listeners.clear()
  snapshot = Date.now()
}
