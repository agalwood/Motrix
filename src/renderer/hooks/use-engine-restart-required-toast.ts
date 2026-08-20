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
    const onRestartRequired = () => {
      toast.close(ENGINE_RESTART_REQUIRED_TOAST_ID)
      toast.add({
        id: ENGINE_RESTART_REQUIRED_TOAST_ID,
        title: t('notification.engineRestartRequired.title'),
        description: t('notification.engineRestartRequired.body'),
        type: 'warning',
        timeout: 0,
        actionProps: {
          children: t('notification.engineRestartRequired.restartNow'),
          onClick: () => {
            void transport.invoke(Commands.RestartEngine).catch(() => {})
          },
        },
      })
    }

    const onEngineStateChanged = (...args: unknown[]) => {
      if (args[0] === EngineState.Ready) {
        toast.close(ENGINE_RESTART_REQUIRED_TOAST_ID)
      }
    }

    transport.on(Events.EngineRestartRequired, onRestartRequired)
    transport.on(Events.EngineStateChanged, onEngineStateChanged)
    return () => {
      transport.off(Events.EngineRestartRequired, onRestartRequired)
      transport.off(Events.EngineStateChanged, onEngineStateChanged)
    }
  }, [t])
}
