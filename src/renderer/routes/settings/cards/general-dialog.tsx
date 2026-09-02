import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Switch } from '@renderer/components/ui/switch'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import type { AppSettings, MotrixAppSettings } from '@shared/types/settings'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'

type GeneralFields = Pick<
  MotrixAppSettings,
  | 'launchAtStartup'
  | 'defaultSaveDir'
  | 'notifyOnComplete'
  | 'notifyOnError'
  | 'autofillClipboardLinks'
  | 'warnBeforeQuit'
>

// Source of truth: src/shared/schemas/app-settings.ts (DEFAULT_APP_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits. Keep this Pick<> in sync if the schema fields change.
const DEFAULTS: GeneralFields = {
  launchAtStartup: DEFAULT_APP_SETTINGS.launchAtStartup,
  defaultSaveDir: DEFAULT_APP_SETTINGS.defaultSaveDir,
  notifyOnComplete: DEFAULT_APP_SETTINGS.notifyOnComplete,
  notifyOnError: DEFAULT_APP_SETTINGS.notifyOnError,
  autofillClipboardLinks: DEFAULT_APP_SETTINGS.autofillClipboardLinks,
  warnBeforeQuit: DEFAULT_APP_SETTINGS.warnBeforeQuit,
}

export function GeneralDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const isWeb = transport.platform === 'web'
  const form = useForm<GeneralFields>({ defaultValues: DEFAULTS })

  // biome-ignore lint/correctness/useExhaustiveDependencies: form is stable across renders; this is a mount-only fetch
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings
        if (all?.app) {
          form.reset({
            launchAtStartup: all.app.launchAtStartup,
            defaultSaveDir: all.app.defaultSaveDir,
            notifyOnComplete: all.app.notifyOnComplete,
            notifyOnError: all.app.notifyOnError,
            autofillClipboardLinks: all.app.autofillClipboardLinks,
            warnBeforeQuit: all.app.warnBeforeQuit,
          })
        }
      })
      .catch(() => {
        /* keep defaults */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = form.handleSubmit(async (values) => {
    const dirty = pickDirty(values, form.formState.dirtyFields)
    if (!dirty) {
      onClose()
      return
    }
    const patch = { app: dirty }
    await transport.invoke(Commands.UpdateSettings, patch)
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
          <Form {...form}>
            <form className="space-y-4">
              {!isWeb && (
                <FormField
                  control={form.control}
                  name="launchAtStartup"
                  render={({ field }) => (
                    <FormItem className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.general.launchAtStartup')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.general.launchAtStartupDesc')}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="defaultSaveDir"
                render={() => (
                  <FormItem className="space-y-2">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.general.defaultSaveDir')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.general.defaultSaveDirDesc')}
                      </FormDescription>
                    </div>
                    <DirectoryPicker name="defaultSaveDir" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="autofillClipboardLinks"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.general.autofillClipboardLinks')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.general.autofillClipboardLinksDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notifyOnComplete"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.general.notifyOnComplete')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.general.notifyOnCompleteDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notifyOnError"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.general.notifyOnError')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.general.notifyOnErrorDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {!isWeb && (
                <FormField
                  control={form.control}
                  name="warnBeforeQuit"
                  render={({ field }) => (
                    <FormItem className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.general.warnBeforeQuit')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.general.warnBeforeQuitDesc')}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}
            </form>
          </Form>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
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
