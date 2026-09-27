import { Badge } from '@renderer/components/ui/badge'
import { requestEngineDiagnostics } from '@renderer/features/engine-diagnostics/controller'
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
  const statusTitle = connectionText
    ? `${engineText}, ${connectionText}`
    : engineText
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
      render={<button type="button" />}
      variant="secondary"
      className="app-no-drag cursor-pointer select-none hover:bg-secondary/80 focus-visible:outline-none"
      aria-haspopup="dialog"
      title={`${t('panel.dashboard.engine.diagnostics.title')}: ${statusTitle}`}
      onClick={requestEngineDiagnostics}
    >
      <span
        aria-hidden="true"
        className={cn('flex size-2 rounded-full me-2', dot)}
      />
      <span role="status">{text}</span>
    </Badge>
  )
}
