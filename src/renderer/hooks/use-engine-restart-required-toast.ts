import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export const ENGINE_RESTART_REQUIRED_TOAST_ID = 'engine-restart-required'

/** Show one coalesced, action-bearing reminder until the engine is Ready again. */
export function useEngineRestartRequiredToast(): void {
  const { t } = useTranslation()

  useEffect(() => {
    let restartPending = false
    let reminderVisible = false

    const restartAction = () => {
      if (restartPending) return
      restartPending = true
      toast.update(ENGINE_RESTART_REQUIRED_TOAST_ID, {
        actionProps: {
          children: t('notification.engineRestartRequired.restartNow'),
          disabled: true,
          'aria-busy': true,
          onClick: restartAction,
        },
      })
      void transport
        .invoke(Commands.RestartEngine)
        .catch(() => {})
        .finally(() => {
          restartPending = false
          if (!reminderVisible) return
          toast.update(ENGINE_RESTART_REQUIRED_TOAST_ID, {
            actionProps: {
              children: t('notification.engineRestartRequired.restartNow'),
              disabled: false,
              onClick: restartAction,
            },
          })
        })
    }

    const onRestartRequired = () => {
      reminderVisible = true
      toast.close(ENGINE_RESTART_REQUIRED_TOAST_ID)
      toast.add({
        id: ENGINE_RESTART_REQUIRED_TOAST_ID,
        title: t('notification.engineRestartRequired.title'),
        description: t('notification.engineRestartRequired.body'),
        type: 'warning',
        timeout: 0,
        actionProps: {
          children: t('notification.engineRestartRequired.restartNow'),
          disabled: restartPending,
          onClick: restartAction,
        },
      })
    }

    const onEngineStateChanged = (...args: unknown[]) => {
      if (args[0] === EngineState.Ready) {
        reminderVisible = false
        toast.close(ENGINE_RESTART_REQUIRED_TOAST_ID)
      }
    }

    transport.on(Events.EngineRestartRequired, onRestartRequired)
    transport.on(Events.EngineStateChanged, onEngineStateChanged)
    return () => {
      reminderVisible = false
      transport.off(Events.EngineRestartRequired, onRestartRequired)
      transport.off(Events.EngineStateChanged, onEngineStateChanged)
    }
  }, [t])
}
