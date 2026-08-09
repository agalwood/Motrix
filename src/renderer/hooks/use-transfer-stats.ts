import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type {
  GetTransferStatsParams,
  TransferStatsSnapshot,
} from '@shared/types/stats'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const TRANSFER_REFRESH_THROTTLE_MS = 5_000
export const TRANSFER_WEB_FALLBACK_REFRESH_MS = 30_000

export type TransferStatsState =
  | { status: 'loading'; retry: () => void }
  | {
      status: 'ready'
      snapshot: TransferStatsSnapshot
      retry: () => void
    }
  | {
      status: 'stale'
      snapshot: TransferStatsSnapshot
      retry: () => void
    }
  | { status: 'unavailable'; retry: () => void }

type TransferStatsLifecycle =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: TransferStatsSnapshot }
  | { status: 'stale'; snapshot: TransferStatsSnapshot }
  | { status: 'unavailable' }

interface LocalDayEnvironment {
  params: GetTransferStatsParams
  timezoneOffset: number
}

export function getLocalDayEnvironment(now = new Date()): LocalDayEnvironment {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  const end = new Date(start)
  end.setDate(end.getDate() + 1)

  return {
    params: {
      dayStartMs: start.getTime(),
      dayEndMs: end.getTime(),
    },
    timezoneOffset: now.getTimezoneOffset(),
  }
}

function environmentKey(environment: LocalDayEnvironment): string {
  return `${environment.params.dayStartMs}:${environment.params.dayEndMs}:${environment.timezoneOffset}`
}

export function useTransferStats(): TransferStatsState {
  const [lifecycle, setLifecycle] = useState<TransferStatsLifecycle>({
    status: 'loading',
  })
  const mountedRef = useRef(false)
  const snapshotRef = useRef<TransferStatsSnapshot | null>(null)
  const requestSequenceRef = useRef(0)
  const inFlightRef = useRef(false)
  const queuedRefreshRef = useRef(false)
  const lastRefreshAtRef = useRef(Number.NEGATIVE_INFINITY)
  const environmentKeyRef = useRef('')
  const trailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const midnightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const retryRef = useRef<() => void>(() => {})

  const refresh = useCallback(async () => {
    const now = new Date()
    const environment = getLocalDayEnvironment(now)
    const requestEnvironmentKey = environmentKey(environment)
    environmentKeyRef.current = requestEnvironmentKey

    if (midnightTimerRef.current !== null) {
      clearTimeout(midnightTimerRef.current)
    }
    midnightTimerRef.current = setTimeout(
      () => {
        midnightTimerRef.current = null
        retryRef.current()
      },
      Math.max(1, environment.params.dayEndMs - now.getTime())
    )

    if (inFlightRef.current) {
      queuedRefreshRef.current = true
      return
    }

    inFlightRef.current = true
    const requestSequence = ++requestSequenceRef.current
    lastRefreshAtRef.current = Date.now()

    const isCurrentRequest = () =>
      mountedRef.current &&
      requestSequence === requestSequenceRef.current &&
      requestEnvironmentKey === environmentKeyRef.current

    try {
      const snapshot = (await transport.invoke(
        Queries.GetTransferStats,
        environment.params
      )) as TransferStatsSnapshot
      if (!isCurrentRequest()) return
      snapshotRef.current = snapshot
      setLifecycle({ status: 'ready', snapshot })
    } catch {
      if (!isCurrentRequest()) return
      const snapshot = snapshotRef.current
      setLifecycle(
        snapshot ? { status: 'stale', snapshot } : { status: 'unavailable' }
      )
    } finally {
      inFlightRef.current = false
      if (mountedRef.current && queuedRefreshRef.current) {
        queuedRefreshRef.current = false
        refreshRef.current()
      }
    }
  }, [])

  refreshRef.current = () => {
    void refresh()
  }

  useEffect(() => {
    mountedRef.current = true

    const refreshImmediately = () => {
      if (trailingTimerRef.current !== null) {
        clearTimeout(trailingTimerRef.current)
        trailingTimerRef.current = null
      }
      refreshRef.current()
    }
    retryRef.current = refreshImmediately

    const onStatsUpdated = () => {
      const elapsed = Date.now() - lastRefreshAtRef.current
      if (elapsed >= TRANSFER_REFRESH_THROTTLE_MS) {
        refreshImmediately()
        return
      }
      if (trailingTimerRef.current !== null) return
      trailingTimerRef.current = setTimeout(() => {
        trailingTimerRef.current = null
        refreshRef.current()
      }, TRANSFER_REFRESH_THROTTLE_MS - elapsed)
    }

    const refreshAfterForeground = () => {
      const nextKey = environmentKey(getLocalDayEnvironment())
      if (nextKey !== environmentKeyRef.current) {
        environmentKeyRef.current = nextKey
        refreshImmediately()
        return
      }

      if (
        Date.now() - lastRefreshAtRef.current >=
        TRANSFER_REFRESH_THROTTLE_MS
      ) {
        refreshImmediately()
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshAfterForeground()
      }
    }

    transport.on(Events.StatsUpdated, onStatsUpdated)
    window.addEventListener('focus', refreshAfterForeground)
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (transport.platform === 'web') {
      fallbackTimerRef.current = setInterval(() => {
        if (document.visibilityState === 'visible') onStatsUpdated()
      }, TRANSFER_WEB_FALLBACK_REFRESH_MS)
    }

    // Subscribe first so a StatsUpdated event cannot land in a hydration gap.
    refreshImmediately()

    return () => {
      mountedRef.current = false
      requestSequenceRef.current += 1
      queuedRefreshRef.current = false
      transport.off(Events.StatsUpdated, onStatsUpdated)
      window.removeEventListener('focus', refreshAfterForeground)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (trailingTimerRef.current !== null) {
        clearTimeout(trailingTimerRef.current)
        trailingTimerRef.current = null
      }
      if (midnightTimerRef.current !== null) {
        clearTimeout(midnightTimerRef.current)
        midnightTimerRef.current = null
      }
      if (fallbackTimerRef.current !== null) {
        clearInterval(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
      retryRef.current = () => {}
    }
  }, [])

  const retry = useCallback(() => retryRef.current(), [])

  return useMemo(
    () => ({ ...lifecycle, retry }) as TransferStatsState,
    [lifecycle, retry]
  )
}
