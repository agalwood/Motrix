import { Button } from '@renderer/components/ui/button'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type AppImageNativeHostView,
  appImageNativeHostViewSchema,
} from '@shared/schemas/appimage-native-host'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AppImageNativeHostSection() {
  const { t } = useTranslation()
  const [view, setView] = useState<AppImageNativeHostView>({ supported: false })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let stale = false
    transport
      .invoke(Queries.GetAppImageNativeHostStatus)
      .then((value) => {
        const parsed = appImageNativeHostViewSchema.safeParse(value)
        if (!stale && parsed.success) setView(parsed.data)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])
  if (!view.supported) return null
  const run = async (action: 'enable' | 'repair' | 'remove') => {
    setBusy(true)
    setFailed(false)
    try {
      setView(
        appImageNativeHostViewSchema.parse(
          await transport.invoke(Commands.ConfigureAppImageNativeHost, action)
        )
      )
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const status = failed
    ? 'io'
    : (view.issue ?? (view.healthy ? 'ready' : 'disabled'))
  return (
    <div className="space-y-2" data-testid="appimage-native-host">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t('settings.integration.appimageHost.title')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('settings.integration.appimageHost.desc')}
        </p>
        <p className="break-all text-xs text-muted-foreground">{view.target}</p>
        <p className="text-xs" role="status">
          {t(`settings.integration.appimageHost.status.${status}`)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(view.consent === 'accepted' ? 'repair' : 'enable')}
        >
          {t(
            `settings.integration.appimageHost.${view.consent !== 'accepted' ? 'enable' : view.currentTarget ? 'repair' : 'useCurrent'}`
          )}
        </Button>
        {view.consent === 'accepted' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run('remove')}
          >
            {t('settings.integration.appimageHost.remove')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void navigator.clipboard
              .writeText(
                JSON.stringify({
                  enabled: view.enabled,
                  consent: view.consent,
                  healthy: view.healthy,
                  issue: view.issue,
                  currentTarget: view.currentTarget,
                })
              )
              .catch(() => setFailed(true))
          }}
        >
          {t('settings.integration.appimageHost.copyDiagnostics')}
        </Button>
      </div>
    </div>
  )
}
