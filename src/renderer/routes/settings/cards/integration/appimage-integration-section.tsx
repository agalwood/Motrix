import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppImageIntegrationView } from '@shared/types/appimage-integration'
import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type SupportedView = Extract<AppImageIntegrationView, { supported: true }>

// The main process answers { supported: false } outside a packaged Linux
// AppImage; the web shell has no handler at all and rejects. Both collapse to
// "render nothing".
function parseView(value: unknown): SupportedView | null {
  if (typeof value !== 'object' || value === null) return null
  const view = value as AppImageIntegrationView
  return view.supported === true ? view : null
}

export interface AppImageIntegrationSectionProps {
  onIntegrationChange?: () => void
}

export function AppImageIntegrationSection({
  onIntegrationChange,
}: AppImageIntegrationSectionProps = {}) {
  const { t } = useTranslation()
  const [view, setView] = useState<SupportedView | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastAction, setLastAction] = useState<'enable' | 'remove' | null>(null)

  useEffect(() => {
    let stale = false
    transport
      .invoke(Queries.GetAppImageIntegrationStatus)
      .then((result) => {
        if (!stale) setView(parseView(result))
      })
      .catch(() => {
        if (!stale) setView(null)
      })
    return () => {
      stale = true
    }
  }, [])

  if (!view) return null

  const integratedBySelf = view.decision === 'accepted' && view.owner === 'self'
  const external = view.owner === 'external'
  const failed = integratedBySelf && view.status === 'failed'
  const showEnable = !external && (!integratedBySelf || failed)
  const showRemove = integratedBySelf && !external

  const runAction = async (
    channel:
      | typeof Commands.EnableAppImageIntegration
      | typeof Commands.RemoveAppImageIntegration
  ) => {
    const action =
      channel === Commands.RemoveAppImageIntegration ? 'remove' : 'enable'
    setBusy(true)
    setLastAction(null)
    try {
      const next = parseView(await transport.invoke(channel))
      setView(next)
      setLastAction(action)
      onIntegrationChange?.()
    } catch {
      // Keep the current view; the main process logs the failure.
    } finally {
      setBusy(false)
    }
  }

  const statusText = external
    ? t('settings.integration.appimage.status.externalManaged')
    : integratedBySelf && view.status === 'healthy'
      ? t('settings.integration.appimage.status.healthy')
      : integratedBySelf
        ? null
        : t('settings.integration.appimage.status.notIntegrated')

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <span className="text-sm font-medium">
            {t('settings.integration.appimage.title')}
          </span>
          <p className="text-xs text-muted-foreground">
            {t('settings.integration.appimage.desc')}
          </p>
          {statusText && (
            <p className="text-xs text-muted-foreground" role="status">
              {statusText}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {showEnable && (
            <Button
              type="button"
              variant={integratedBySelf ? 'outline' : 'default'}
              size="sm"
              disabled={busy}
              onClick={() => runAction(Commands.EnableAppImageIntegration)}
            >
              {busy && (
                <Spinner
                  data-icon="inline-start"
                  role="presentation"
                  aria-hidden="true"
                />
              )}
              {t('settings.integration.appimage.enable')}
            </Button>
          )}
          {showRemove && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => runAction(Commands.RemoveAppImageIntegration)}
            >
              {t('settings.integration.appimage.remove')}
            </Button>
          )}
        </div>
      </div>

      {failed && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {t('settings.integration.appimage.status.failedTitle')}
          </AlertTitle>
          <AlertDescription>
            {t(
              lastAction === 'remove'
                ? 'settings.integration.appimage.status.removeBlockedDetail'
                : 'settings.integration.appimage.status.failedDetail'
            )}
          </AlertDescription>
        </Alert>
      )}

      {integratedBySelf && view.status === 'healthy' && (
        <p className="text-xs text-muted-foreground">
          {t('settings.integration.appimage.movedHint')}
        </p>
      )}
    </div>
  )
}
