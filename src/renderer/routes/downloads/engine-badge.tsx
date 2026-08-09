import { Badge } from '@renderer/components/ui/badge'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { EngineState } from '@shared/types/engine'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const dotColor: Record<EngineState, string> = {
  [EngineState.Starting]: 'bg-blue-500',
  [EngineState.Ready]: 'bg-green-500',
  [EngineState.Failed]: 'bg-red-500',
  [EngineState.Restarting]: 'bg-yellow-500',
  [EngineState.Stopped]: 'bg-gray-500',
}

function useEngineState() {
  const [state, setState] = useState<EngineState>(EngineState.Starting)
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetEngineStatus)
      .then((res) => {
        if (cancelled) return
        const next = (res as { state?: EngineState })?.state
        if (next) setState(next)
      })
      .catch(() => {})
    const onChange = (...args: unknown[]) => {
      const next = args[0] as EngineState | undefined
      if (next) setState(next)
    }
    transport.on(Events.EngineStateChanged, onChange)
    return () => {
      cancelled = true
      transport.off(Events.EngineStateChanged, onChange)
    }
  }, [])
  return state
}

export function EngineBadge() {
  const { t } = useTranslation()
  const state = useEngineState()
  const text =
    state === EngineState.Ready
      ? t('panel.downloads.stats.engineOk')
      : state === EngineState.Starting || state === EngineState.Restarting
        ? t('panel.downloads.stats.engineStarting')
        : t('panel.downloads.stats.engineOffline')
  return (
    <Badge variant="secondary">
      <span className={cn('flex size-2 rounded-full mr-2', dotColor[state])} />
      {text}
    </Badge>
  )
}
