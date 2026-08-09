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

function subscribe(listener: ClockListener): () => void {
  const starting = listeners.size === 0
  listeners.add(listener)
  if (starting) {
    snapshot = Date.now()
    scheduleNextMinute()
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
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
  if (timer !== null) clearTimeout(timer)
  timer = null
  listeners.clear()
  snapshot = Date.now()
}
