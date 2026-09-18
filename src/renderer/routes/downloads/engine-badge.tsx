import { Badge } from '@renderer/components/ui/badge'
import { useEngineDisplayStatus } from '@renderer/hooks/use-engine-display-status'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'

export function EngineBadge() {
  const { t } = useTranslation()
  const { state, connection } = useEngineDisplayStatus()
  const engineText =
    state === 'ready'
      ? t('panel.downloads.stats.engineOk')
      : state === 'starting' || state === 'reconnecting'
        ? t('panel.downloads.stats.engineStarting')
        : t('panel.downloads.stats.engineOffline')
  const connectionText = connection ? t(`panel.connection.${connection}`) : null
  const text =
    state === 'failed' || state === 'stopped'
      ? engineText
      : (connectionText ?? engineText)
  const dot =
    state === 'failed'
      ? 'bg-red-500'
      : connection
        ? 'bg-amber-500'
        : state === 'ready'
          ? 'bg-green-500'
          : state === 'starting' || state === 'reconnecting'
            ? 'bg-blue-500'
            : 'bg-gray-500'
  return (
    <Badge
      variant="secondary"
      title={connectionText ? `${engineText} · ${connectionText}` : engineText}
      role="status"
    >
      <span className={cn('flex size-2 rounded-full mr-2', dot)} />
      {text}
    </Badge>
  )
}
