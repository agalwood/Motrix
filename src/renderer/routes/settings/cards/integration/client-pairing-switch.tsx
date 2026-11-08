import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
} from '@renderer/components/ui/form'
import { Switch } from '@renderer/components/ui/switch'
import { usePortableMode } from '@renderer/hooks/use-portable-mode'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { IntegrationFormValues } from './integration-dialog'

export function ClientPairingSwitch({
  browser = false,
}: {
  browser?: boolean
}) {
  const { t } = useTranslation()
  const portable = usePortableMode()
  const form = useFormContext<IntegrationFormValues>()
  return (
    <FormField
      control={form.control}
      name="app.browserBridgeEnabled"
      render={({ field }) => (
        <SettingsFormRow>
          <div className="space-y-1">
            <FormLabel>
              {t(
                browser
                  ? 'settings.integration.browser.masterSwitch'
                  : 'settings.integration.clients.masterSwitch'
              )}
            </FormLabel>
            <FormDescription className="text-xs">
              {t(
                browser
                  ? portable
                    ? 'settings.portable.browserDescription'
                    : 'settings.integration.browser.masterSwitchDesc'
                  : 'settings.integration.clients.masterSwitchDesc'
              )}
            </FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </SettingsFormRow>
      )}
    />
  )
}
