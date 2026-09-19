import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type EngineFailureReason,
  EngineState,
  type EngineStatusSnapshot,
} from '@shared/types/engine'
import type { AppSettings } from '@shared/types/settings'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useTaskList } from './use-task-list'

export type EngineDisplayState =
  | 'ready'
  | 'starting'
  | 'reconnecting'
  | 'failed'
  | 'disconnected'
  | 'stopped'
export type WebConnectionStatus =
  | 'polling'
  | 'reconnecting'
  | 'unavailable'
  | 'originMismatch'
export interface EngineDisplayStatus {
  state: EngineDisplayState
  version: string
  rpcPort: number
  listenPort: number
  failureReason: EngineFailureReason | null
  connection?: WebConnectionStatus | null
}

function mapState(state: EngineState | undefined): EngineDisplayState {
  if (state === EngineState.Restarting) return 'reconnecting'
  return state ?? 'disconnected'
}

const engineStateSchema = z.enum(EngineState)

const DEFAULTS: EngineDisplayStatus = {
  state: 'starting',
  version: '?',
  rpcPort: 0,
  listenPort: 0,
  failureReason: null,
}

/** Both engine surfaces consume the task store's connection/data health.
 * Losing the browser event stream does not mean aria2 has stopped. */
export function useEngineDisplayStatus(): EngineDisplayStatus {
  const { realtimeConnected, status: taskStatus } = useTaskList()
  const session = useOperatorSession()
  const [status, setStatus] = useState<EngineDisplayStatus>(DEFAULTS)

  const connection = useRef(realtimeConnected)
  const refreshConnection = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (session.state === 'locked' || session.state === 'logging-out') {
      setStatus(DEFAULTS)
      return
    }
    let disposed = false
    const isCurrentSession = () =>
      !disposed && session.epoch === useOperatorSession.getState().epoch

    // Engine observations must remain available even if settings is slow.
    // Each reader owns its own coalescer, invalidation generation and timer.
    const reader = <T>(load: () => Promise<T>, apply: (value: T) => void) => {
      let generation = 0
      let inFlight = false
      let trailing = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = async (invalidate = false) => {
        if (!isCurrentSession()) return
        if (invalidate) generation++
        if (inFlight) {
          trailing = true
          return
        }
        inFlight = true
        clearTimeout(timer)
        const current = generation
        try {
          const value = await load()
          if (isCurrentSession() && current === generation) apply(value)
        } catch {
          // Retain the last observation; task/connection health is separate.
        } finally {
          inFlight = false
          if (isCurrentSession()) {
            if (trailing) {
              trailing = false
              void refresh()
            } else if (transport.platform === 'web')
              timer = setTimeout(
                () => {
                  if (document.visibilityState !== 'hidden') void refresh()
                },
                connection.current ? 30_000 : 5_000
              )
          }
        }
      }
      return { refresh, dispose: () => clearTimeout(timer) }
    }
    const engine = reader(
      () =>
        transport.invoke(
          Queries.GetEngineStatus
        ) as Promise<EngineStatusSnapshot>,
      (value) =>
        setStatus((previous) => ({
          ...previous,
          state: mapState(value.state),
          version: value.featureReport?.version ?? '?',
          failureReason: value.failure?.reason ?? null,
        }))
    )
    const settings = reader(
      () => transport.invoke(Queries.GetSettings) as Promise<AppSettings>,
      (value) =>
        setStatus((previous) => ({
          ...previous,
          rpcPort: value?.engine?.rpcPort ?? previous.rpcPort,
          listenPort: value?.engine?.listenPort ?? previous.listenPort,
        }))
    )
    const refresh = () => {
      void engine.refresh()
      void settings.refresh()
    }
    const onEngine = (...args: unknown[]) => {
      if (!isCurrentSession()) return
      const next = engineStateSchema.safeParse(args[0])
      if (next.success)
        setStatus((previous) => ({
          ...previous,
          state: mapState(next.data),
          failureReason: null,
        }))
      void engine.refresh(true)
    }
    const onSettings = () => {
      void settings.refresh(true)
    }
    const foreground = () => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    transport.on(Events.EngineStateChanged, onEngine)
    transport.on(Events.SettingsChanged, onSettings)
    window.addEventListener('online', foreground)
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    refreshConnection.current = refresh
    refresh()
    return () => {
      disposed = true
      engine.dispose()
      settings.dispose()
      refreshConnection.current = null
      transport.off(Events.EngineStateChanged, onEngine)
      transport.off(Events.SettingsChanged, onSettings)
      window.removeEventListener('online', foreground)
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [session.epoch, session.state])

  useEffect(() => {
    if (connection.current === realtimeConnected) return
    connection.current = realtimeConnected
    // A transport edge does not invalidate a healthy in-flight HTTP read.
    refreshConnection.current?.()
  }, [realtimeConnected])

  let connectionStatus: WebConnectionStatus | null = null
  if (
    transport.platform === 'web' &&
    (!realtimeConnected || taskStatus === 'error')
  ) {
    connectionStatus =
      taskStatus === 'error'
        ? 'unavailable'
        : session.status?.eventOriginMatches === false
          ? 'originMismatch'
          : taskStatus === 'ready'
            ? 'polling'
            : 'reconnecting'
  }
  return { ...status, connection: connectionStatus }
}
