import { StatusErrorIcon } from '@renderer/components/icons'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
import {
  SettingsLoadStatus,
  useSettingsLoad,
} from '@renderer/components/settings-kit/use-settings-load'
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
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { Separator } from '@renderer/components/ui/separator'
import { toast } from '@renderer/components/ui/toast'
import { pickDirty } from '@renderer/lib/form-utils'
import { saveSettings } from '@renderer/lib/settings-save'
import { transport } from '@renderer/lib/transport'
import { DEFAULT_APP_SETTINGS, DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import type { AppSettings } from '@shared/types/settings'
import { useState } from 'react'
import { FormProvider } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { z } from 'zod'
import type { SettingsCardDialogProps } from '../card-types'
import { integrationFormSchema } from '../settings-form-schemas'
import { AppImageIntegrationSection } from './appimage-integration-section'
import { AppImageNativeHostSection } from './appimage-native-host-section'
import { BrowserExtensionsSection } from './browser-extensions-section'
import { CLIClientsSection } from './cli-clients-section'
import { CliToolSection } from './cli-tool-section'
import { MediaToolsSection } from './media-tools-section'
import { PendingApprovalsSection } from './pending-approvals-section'
import { SystemProtocolsSection } from './system-protocols-section'

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
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const isWeb = transport.platform === 'web'
  const [protocolRevision, setProtocolRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const form = useSettingsForm<IntegrationFormValues>(
    integrationFormSchema,
    DEFAULTS
  )

  const load = useSettingsLoad((all) => {
    if (!all?.app || !all.media) throw new Error('Missing settings baseline')
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

  const onSubmit = useSettingsSubmit(form, async (values) => {
    if (!load.ready) return
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
    const result = (await saveSettings(patch)) as {
      protocolAssociationApplied?: boolean
    }
    if (dirty.media?.ffmpegBinaryPath !== undefined) {
      toast.add({
        title: t('settings.integration.media.savedTitle'),
        description: t(
          isWeb
            ? 'settings.integration.media.restartHint'
            : 'settings.integration.media.desktopSavedHint'
        ),
        type: 'info',
        timeout: 0,
      })
    }
    if (result.protocolAssociationApplied === false) {
      setSaveError(t('settings.integration.system.protocolMagnetApplyFailed'))
      return
    }
    onClose()
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(v, details) => {
        if (!v) {
          if (form.formState.isSubmitting) details.cancel()
          else onClose()
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>
            {t('settings.integration.description')}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollAreaViewport
            tabIndex={-1}
            className="min-h-0 flex-1 overscroll-contain"
          >
            <ScrollAreaContent
              className="px-6 py-4"
              style={{ minWidth: '100%' }}
            >
              <SettingsLoadStatus {...load} />
              <FormProvider {...form}>
                <fieldset
                  inert={!load.ready || form.formState.isSubmitting}
                  disabled={!load.ready || form.formState.isSubmitting}
                  className="min-w-0 flex flex-col gap-6"
                >
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
                    {!isWeb && <AppImageNativeHostSection />}
                  </section>

                  <Separator />

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
                </fieldset>
              </FormProvider>
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollBar />
        </ScrollArea>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {form.formState.errors.root?.save && (
            <p role="alert" className="mr-auto text-xs text-destructive">
              {form.formState.errors.root.save.message}
            </p>
          )}
          {saveError && (
            <Alert variant="destructive" className="mr-auto">
              <StatusErrorIcon aria-hidden="true" />
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={form.formState.isSubmitting}
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={!load.ready || form.formState.isSubmitting}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
