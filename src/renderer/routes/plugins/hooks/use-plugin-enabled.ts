import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePluginsStore } from '../store'

const runtimeMessages = [
  'plugin.runtime.ffmpegUnavailable',
  'plugin.runtime.ffmpegIncompatible',
  'plugins.security.blocked',
  'plugins.security.pending',
] as const

/** Both plugin surfaces preserve the current switch state on admission failure. */
export function usePluginEnabled(pluginId: string) {
  const { t } = useTranslation()
  const applyStatus = usePluginsStore((state) => state.applyStatus)
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const toggleEnabled = useCallback(
    async (next: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      setPending(true)
      try {
        await transport.invoke(
          next ? Commands.EnablePlugin : Commands.DisablePlugin,
          pluginId
        )
        applyStatus(pluginId, next ? 'inactive' : 'disabled', undefined, next)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const key = runtimeMessages.find((candidate) =>
          message.endsWith(candidate)
        )
        toast.add({
          type: 'error',
          title: key ? t(key) : t('common.error'),
          ...(!key ? { description: message } : {}),
        })
      } finally {
        inFlight.current = false
        setPending(false)
      }
    },
    [applyStatus, pluginId, t]
  )
  return { toggleEnabled, pending }
}
