import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppUpdateState } from '@shared/types/app-update'
import { useCallback, useEffect, useRef, useState } from 'react'

const initialState: AppUpdateState = {
  phase: 'idle',
  currentVersion: __MOTRIX_APP_METADATA__.version,
}

export function useAppUpdate(enabled = true) {
  const [state, setState] = useState<AppUpdateState>(initialState)
  const [hasState, setHasState] = useState(false)
  const [loading, setLoading] = useState(true)
  const systemManaged = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let active = true
    let revision = 0
    let snapshotRequest = 0
    setLoading(true)

    const applyState = (value: unknown) => {
      const next = value as AppUpdateState
      // Update authority is fixed for this host. A late event from an older
      // backend must not restore app-managed actions after a managed snapshot.
      systemManaged.current ||= isSystemManaged(next)
      setState(
        systemManaged.current
          ? { ...next, phase: 'managed', updateAuthority: 'system' }
          : next
      )
      setHasState(true)
      setLoading(false)
    }
    const refresh = () => {
      const request = ++snapshotRequest
      const startedAtRevision = revision
      void transport
        .invoke(Queries.GetUpdateState)
        .then((value) => {
          if (
            active &&
            request === snapshotRequest &&
            revision === startedAtRevision
          ) {
            applyState(value)
          }
        })
        .catch((error: unknown) => {
          if (
            !active ||
            request !== snapshotRequest ||
            revision !== startedAtRevision
          ) {
            return
          }
          setLoading(false)
          setState((current) =>
            systemManaged.current
              ? current
              : {
                  ...current,
                  phase: 'error',
                  error: { message: toMessage(error) },
                }
          )
        })
    }
    const onStateChanged = (value: unknown) => {
      if (!active) return
      revision += 1
      applyState(value)
    }

    transport.on(Events.UpdateStateChanged, onStateChanged)
    const stopConnectionListener = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') refresh()
    })
    refresh()

    return () => {
      active = false
      transport.off(Events.UpdateStateChanged, onStateChanged)
      stopConnectionListener?.()
    }
  }, [enabled])

  const showControls = enabled && hasState && !isSystemManaged(state)
  const invoke = useCallback(
    async (command: (typeof Commands)[keyof typeof Commands]) => {
      if (!showControls || systemManaged.current) return
      try {
        await transport.invoke(command)
      } catch (error) {
        setState((current) =>
          systemManaged.current
            ? current
            : {
                ...current,
                phase: 'error',
                progress: undefined,
                error: { message: toMessage(error) },
              }
        )
      }
    },
    [showControls]
  )

  return {
    state,
    loading,
    showControls,
    check: () => invoke(Commands.CheckForUpdates),
    download: () => invoke(Commands.DownloadUpdate),
    install: () => invoke(Commands.InstallUpdate),
  }
}

export type AppUpdateController = ReturnType<typeof useAppUpdate>

function isSystemManaged(state: AppUpdateState): boolean {
  return state.updateAuthority === 'system' || state.phase === 'managed'
}

function toMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Unable to communicate with the update service'
}
