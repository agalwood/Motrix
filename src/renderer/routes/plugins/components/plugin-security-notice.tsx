import { Button } from '@renderer/components/ui/button'
import { usePlatformServices } from '@renderer/platform/services'
import type { PluginSecurityDecision } from '@shared/schemas/plugin-security'
import { useTranslation } from 'react-i18next'

export function PluginSecurityNotice({
  decision,
}: {
  decision?: PluginSecurityDecision
}) {
  const { t } = useTranslation()
  const services = usePlatformServices()
  if (!decision) return null
  const awaitingVerification =
    decision.reason === 'pending' || decision.reason === 'unavailable'
  return (
    <div
      role="status"
      className={
        awaitingVerification
          ? 'shrink-0 rounded-md border bg-muted/30 p-3 text-xs space-y-1'
          : 'shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs space-y-1'
      }
    >
      <p className="font-medium">
        {t(
          awaitingVerification
            ? 'plugins.status.disabled'
            : 'plugins.security.blocked'
        )}
      </p>
      <p>{t(`plugins.security.${decision.reason}`)}</p>
      {decision.advisoryIds.length > 0 && (
        <p>{decision.advisoryIds.join(', ')}</p>
      )}
      {decision.fixedVersion && (
        <p>
          {t('plugins.security.fixedVersion', {
            version: decision.fixedVersion,
          })}
        </p>
      )}
      {decision.url && (
        <Button
          size="sm"
          variant="link"
          className="h-auto px-0 text-xs"
          onClick={(event) => {
            event.stopPropagation()
            if (decision.url) void services.openExternal(decision.url)
          }}
        >
          {t('plugins.security.details')}
        </Button>
      )}
    </div>
  )
}
