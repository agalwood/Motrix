import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Switch } from '@renderer/components/ui/switch'
import { transport } from '@renderer/lib/transport'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { CircleQuestionMark } from 'lucide-react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { IntegrationFormValues } from './integration-dialog'

export function SystemProtocolsSection() {
  const { t } = useTranslation()
  const form = useFormContext<IntegrationFormValues>()

  const handleOpenSystemSettings = async () => {
    await transport.invoke(Commands.RequestDefaultTorrentHandler)
  }

  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="app.protocols.magnet"
        render={({ field }) => (
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.system.protocolMagnet')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.system.protocolMagnetDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            {t('settings.integration.system.torrentAssociation')}
            <a
              href={EXTERNAL_URLS.motrix.manual.defaultApplication}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('settings.common.openHelp')}
              className="text-muted-foreground hover:text-foreground"
            >
              <CircleQuestionMark className="size-4" />
            </a>
          </span>
          <p className="text-xs text-muted-foreground">
            {transport.platform === 'darwin'
              ? t('settings.integration.system.torrentAssociationMacDesc')
              : t('settings.integration.system.torrentAssociationDesc')}
          </p>
        </div>
        {transport.platform !== 'darwin' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOpenSystemSettings}
          >
            {t('settings.common.setAsDefault')}
          </Button>
        )}
      </div>
    </div>
  )
}
