import { Switch } from '@renderer/components/ui/switch'
import { saveSettings } from '@renderer/lib/settings-save'
import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import type { AppSettings } from '@shared/types/settings'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AutomaticUpdateSetting() {
  const { t } = useTranslation()
  const id = useId()
  const descriptionId = `${id}-description`
  const [enabled, setEnabled] = useState(
    DEFAULT_APP_SETTINGS.checkForUpdatesOnLaunch
  )
  const [pending, setPending] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    void transport
      .invoke(Queries.GetSettings)
      .then((value) => {
        if (!active) return
        const settings = value as AppSettings
        setEnabled(settings.app.checkForUpdatesOnLaunch)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setPending(false)
      })
    return () => {
      active = false
    }
  }, [])

  const onCheckedChange = useCallback(
    async (checked: boolean) => {
      const previous = enabled
      setEnabled(checked)
      setPending(true)
      setFailed(false)
      try {
        await saveSettings({
          app: { checkForUpdatesOnLaunch: checked },
        })
      } catch {
        setEnabled(previous)
        setFailed(true)
      } finally {
        setPending(false)
      }
    },
    [enabled]
  )

  return (
    <div className="min-w-0" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <Switch
          id={id}
          size="sm"
          checked={enabled}
          disabled={pending}
          onCheckedChange={(checked) => void onCheckedChange(checked)}
          aria-describedby={descriptionId}
        />
        <div className="min-w-0">
          <label htmlFor={id} className="block text-xs font-medium">
            {t('settings.about.update.automaticChecks')}
          </label>
          <p
            id={descriptionId}
            className="truncate text-[11px] leading-4 text-muted-foreground"
          >
            {failed
              ? t('settings.about.update.automaticChecksError')
              : t('settings.about.update.automaticChecksDescription')}
          </p>
        </div>
      </div>
    </div>
  )
}
