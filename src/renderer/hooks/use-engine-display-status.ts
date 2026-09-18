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
import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (session.state === 'locked' || session.state === 'logging-out') {
      setStatus(DEFAULTS)
      return
    }
    let disposed = false
    let generation = 0
    let inFlight = false
    let trailing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (disposed) return
      if (inFlight) {
        trailing = true
        return
      }
      inFlight = true
      clearTimeout(timer)
      const current = generation
      try {
        const [engine, settings] = await Promise.all([
          transport.invoke(
            Queries.GetEngineStatus
          ) as Promise<EngineStatusSnapshot>,
          (transport.invoke(Queries.GetSettings) as Promise<AppSettings>).catch(
            () => null
          ),
        ])
        if (
          !disposed &&
          current === generation &&
          session.epoch === useOperatorSession.getState().epoch
        )
          setStatus((previous) => ({
            state: mapState(engine.state),
            version: engine.featureReport?.version ?? '?',
            rpcPort: settings?.engine?.rpcPort ?? previous.rpcPort,
            listenPort: settings?.engine?.listenPort ?? previous.listenPort,
            failureReason: engine.failure?.reason ?? null,
          }))
      } catch {
        // Retain the last engine observation; connection health is separate.
      } finally {
        inFlight = false
        if (!disposed) {
          if (trailing) {
            trailing = false
            void refresh()
          } else if (transport.platform === 'web')
            timer = setTimeout(
              () => {
                if (document.visibilityState !== 'hidden') void refresh()
              },
              realtimeConnected ? 30_000 : 5_000
            )
        }
      }
    }
    const invalidate = () => {
      generation++
      void refresh()
    }
    const foreground = () => {
      if (document.visibilityState !== 'hidden') invalidate()
    }
    transport.on(Events.EngineStateChanged, invalidate)
    transport.on(Events.SettingsChanged, invalidate)
    window.addEventListener('online', foreground)
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
      transport.off(Events.EngineStateChanged, invalidate)
      transport.off(Events.SettingsChanged, invalidate)
      window.removeEventListener('online', foreground)
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [realtimeConnected, session.epoch, session.state])

  let connection: WebConnectionStatus | null = null
  if (
    transport.platform === 'web' &&
    (!realtimeConnected || taskStatus === 'error')
  ) {
    connection =
      taskStatus === 'error'
        ? 'unavailable'
        : session.status?.eventOriginMatches === false
          ? 'originMismatch'
          : taskStatus === 'ready'
            ? 'polling'
            : 'reconnecting'
  }
  return { ...status, connection }
}
