import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppUpdateState } from '@shared/types/app-update'
import { useCallback, useEffect, useState } from 'react'

const initialState: AppUpdateState = {
  phase: 'idle',
  currentVersion: __MOTRIX_APP_METADATA__.version,
}

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>(initialState)

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const onStateChanged = (value: unknown) => {
      receivedEvent = true
      if (active) setState(value as AppUpdateState)
    }

    transport.on(Events.UpdateStateChanged, onStateChanged)
    void transport
      .invoke(Queries.GetUpdateState)
      .then((value) => {
        if (active && !receivedEvent) setState(value as AppUpdateState)
      })
      .catch((error: unknown) => {
        if (!active || receivedEvent) return
        setState({
          ...initialState,
          phase: 'error',
          error: { message: toMessage(error) },
        })
      })

    return () => {
      active = false
      transport.off(Events.UpdateStateChanged, onStateChanged)
    }
  }, [])

  const invoke = useCallback(
    async (command: (typeof Commands)[keyof typeof Commands]) => {
      try {
        await transport.invoke(command)
      } catch (error) {
        setState((current) => ({
          ...current,
          phase: 'error',
          progress: undefined,
          error: { message: toMessage(error) },
        }))
      }
    },
    []
  )

  return {
    state,
    check: () => invoke(Commands.CheckForUpdates),
    download: () => invoke(Commands.DownloadUpdate),
    install: () => invoke(Commands.InstallUpdate),
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Unable to communicate with the update service'
}
