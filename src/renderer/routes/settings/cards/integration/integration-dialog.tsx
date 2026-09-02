import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Separator } from '@renderer/components/ui/separator'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS, DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import type { AppSettings } from '@shared/types/settings'
import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { SettingsCardDialogProps } from '../card-types'
import { AppImageIntegrationSection } from './appimage-integration-section'
import { BrowserExtensionsSection } from './browser-extensions-section'
import { CLIClientsSection } from './cli-clients-section'
import { CliToolSection } from './cli-tool-section'
import { MediaToolsSection } from './media-tools-section'
import { PendingApprovalsSection } from './pending-approvals-section'
import { SystemProtocolsSection } from './system-protocols-section'

const integrationFormSchema = z.object({
  app: z.object({
    browserBridgeEnabled: z.boolean(),
    protocols: z.object({
      magnet: z.boolean(),
    }),
  }),
  media: z.object({
    ffmpegBinaryPath: z.string(),
    ffmpegStagingMB: z.number().int().min(256).max(65536),
    ffmpegOpTimeoutSec: z.number().int().min(60).max(3600),
  }),
})

export type IntegrationFormValues = z.infer<typeof integrationFormSchema>

const DEFAULTS: IntegrationFormValues = {
  app: {
    browserBridgeEnabled: DEFAULT_APP_SETTINGS.browserBridgeEnabled,
    protocols: DEFAULT_APP_SETTINGS.protocols,
  },
  media: { ...DEFAULT_MEDIA_SETTINGS },
}

export function IntegrationDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const isWeb = transport.platform === 'web'
  const [protocolRevision, setProtocolRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const form = useForm<IntegrationFormValues>({
    resolver: zodResolver(integrationFormSchema),
    defaultValues: DEFAULTS,
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only fetch
  useEffect(() => {
    if (!open) return
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings
        if (all?.app && all?.media) {
          form.reset({
            app: {
              browserBridgeEnabled: all.app.browserBridgeEnabled,
              protocols: all.app.protocols,
            },
            media: { ...all.media },
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  const onSubmit = form.handleSubmit(async (values) => {
    setSaveError(null)
    const dirty = pickDirty(values, form.formState.dirtyFields) as
      | Partial<{
          app: Partial<IntegrationFormValues['app']>
          media: Partial<IntegrationFormValues['media']>
        }>
      | undefined
    if (!dirty) {
      onClose()
      return
    }
    const patch = dirty as Partial<AppSettings>
    const result = (await transport.invoke(Commands.UpdateSettings, patch)) as {
      protocolAssociationApplied?: boolean
    }
    if (result.protocolAssociationApplied === false) {
      setSaveError(t('settings.integration.system.protocolMagnetApplyFailed'))
      return
    }
    onClose()
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <FormProvider {...form}>
            <div className="flex flex-col gap-6">
              {!isWeb && (
                <>
                  <section
                    aria-labelledby="integration-system"
                    className="flex flex-col gap-3"
                  >
                    <h3
                      id="integration-system"
                      className="text-sm font-semibold text-foreground"
                    >
                      {t('settings.integration.system.title')}
                    </h3>
                    <SystemProtocolsSection
                      refreshRevision={protocolRevision}
                    />
                    <AppImageIntegrationSection
                      onIntegrationChange={() =>
                        setProtocolRevision((revision) => revision + 1)
                      }
                    />
                  </section>

                  <Separator />
                </>
              )}

              <section
                aria-labelledby="integration-browser"
                className="flex flex-col gap-3"
              >
                <h3
                  id="integration-browser"
                  className="text-sm font-semibold text-foreground"
                >
                  {t('settings.integration.browser.title')}
                </h3>
                <BrowserExtensionsSection />
              </section>

              <Separator />

              <section
                aria-labelledby="integration-cli"
                className="flex flex-col gap-4"
              >
                <h3
                  id="integration-cli"
                  className="text-sm font-semibold text-foreground"
                >
                  {t('settings.integration.cli.title')}
                </h3>
                <CliToolSection />
                <Separator />
                <CLIClientsSection />
                <PendingApprovalsSection />
              </section>

              <Separator />

              <section
                aria-labelledby="integration-media"
                className="flex flex-col gap-3"
              >
                <h3
                  id="integration-media"
                  className="text-sm font-semibold text-foreground"
                >
                  {t('settings.integration.media.title')}
                </h3>
                <MediaToolsSection />
              </section>
            </div>
          </FormProvider>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {saveError && (
            <Alert variant="destructive" className="mr-auto">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={form.formState.isSubmitting}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
