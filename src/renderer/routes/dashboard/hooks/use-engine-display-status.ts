// src/renderer/routes/dashboard/hooks/use-engine-display-status.ts
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { EngineStatusSnapshot } from '@shared/types/engine'
import { EngineState } from '@shared/types/engine'
import type { AppSettings } from '@shared/types/settings'
import { useCallback, useEffect, useState } from 'react'
import type {
  EngineDisplayState,
  EngineDisplayStatus,
} from '../tiles/engine-tile'

function mapEngineState(state: EngineState | undefined): EngineDisplayState {
  switch (state) {
    case EngineState.Ready:
      return 'ready'
    case EngineState.Starting:
      return 'starting'
    case EngineState.Restarting:
      return 'reconnecting'
    case EngineState.Failed:
      return 'failed'
    case EngineState.Stopped:
      return 'stopped'
    default:
      return 'disconnected'
  }
}

const DEFAULTS: EngineDisplayStatus = {
  state: 'starting',
  version: '?',
  rpcPort: 0,
  listenPort: 0,
  failureReason: null,
}

export function useEngineDisplayStatus(): EngineDisplayStatus {
  const [status, setStatus] = useState<EngineDisplayStatus>(DEFAULTS)

  const refresh = useCallback(async () => {
    try {
      const [engine, settings] = (await Promise.all([
        transport.invoke(Queries.GetEngineStatus),
        transport.invoke(Queries.GetSettings),
      ])) as [EngineStatusSnapshot, AppSettings]

      setStatus({
        state: mapEngineState(engine.state),
        version: engine.featureReport?.version ?? '?',
        rpcPort: settings.engine.rpcPort,
        listenPort: settings.engine.listenPort,
        failureReason: engine.failure?.reason ?? null,
      })
    } catch {
      /* events will trigger another refresh */
    }
  }, [])

  useEffect(() => {
    refresh()
    const handler = () => refresh()
    transport.on(Events.EngineStateChanged, handler)
    transport.on(Events.SettingsChanged, handler)
    return () => {
      transport.off(Events.EngineStateChanged, handler)
      transport.off(Events.SettingsChanged, handler)
    }
  }, [refresh])

  return status
}
