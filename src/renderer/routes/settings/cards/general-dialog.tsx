import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
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
  FormMessage,
  useFormField,
} from '@renderer/components/ui/form'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { Switch } from '@renderer/components/ui/switch'
import {
  DirectoryPreferencesSection,
  DirectoryPreferencesStatus,
} from '@renderer/features/directory-preferences/directory-preferences-section'
import { useDirectoryPreferencesDraft } from '@renderer/features/directory-preferences/use-directory-preferences-draft'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import type { GeneralSettingsApp } from '@shared/schemas/general-settings'
import { type ComponentProps, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'
import { generalFormSchema } from './settings-form-schemas'

type GeneralFields = GeneralSettingsApp

// Source of truth: src/shared/schemas/app-settings.ts (DEFAULT_APP_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits. Keep this Pick<> in sync if the schema fields change.
const DEFAULTS: GeneralFields = {
  launchAtStartup: DEFAULT_APP_SETTINGS.launchAtStartup,
  showMainWindowAtLogin: DEFAULT_APP_SETTINGS.showMainWindowAtLogin,
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
  const form = useSettingsForm<GeneralFields>(generalFormSchema, DEFAULTS)
  const directories = useDirectoryPreferencesDraft({
    getAppDraft: () => ({
      values: form.getValues(),
      dirty: pickDirty(form.getValues(), form.formState.dirtyFields) ?? {},
    }),
    onAppRebase: (baseline, intent) => {
      form.reset(baseline)
      for (const key of Object.keys(intent) as (keyof GeneralFields)[]) {
        const value = intent[key]
        if (value !== undefined)
          form.setValue(key, value, { shouldDirty: true })
      }
    },
  })
  const contentRef = useRef<HTMLDivElement>(null)
  const [defaultPicking, setDefaultPicking] = useState(false)
  const [favoritePicking, setFavoritePicking] = useState(false)
  const busy = directories.saving || defaultPicking || favoritePicking
  const fieldsDisabled =
    directories.saving || directories.loading || !directories.ready
  const close = () => {
    if (!busy) onClose()
  }

  const onSubmit = useSettingsSubmit(form, async () => {
    if (busy || directories.loading || !directories.ready) return
    contentRef.current?.focus({ preventScroll: true })
    if (await directories.save()) onClose()
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(v, details) => {
        if (v) return
        if (busy) details.cancel()
        else close()
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollAreaViewport
            ref={contentRef}
            tabIndex={-1}
            className="min-h-0 flex-1 overscroll-contain"
          >
            <ScrollAreaContent
              className="px-6 py-4"
              style={{ minWidth: '100%' }}
            >
              <DirectoryPreferencesStatus
                loading={directories.loading}
                error={directories.error}
                disabled={busy}
                onRetry={() => {
                  contentRef.current?.focus({ preventScroll: true })
                  void directories.refresh()
                }}
              />

              <Form {...form}>
                <form noValidate onSubmit={onSubmit}>
                  <fieldset
                    className="min-w-0 space-y-4"
                    disabled={fieldsDisabled}
                  >
                    {!isWeb && (
                      <FormField
                        control={form.control}
                        name="launchAtStartup"
                        render={({ field }) => (
                          <SettingsFormRow>
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
                                disabled={fieldsDisabled}
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                          </SettingsFormRow>
                        )}
                      />
                    )}

                    {!isWeb && (
                      <FormField
                        control={form.control}
                        name="showMainWindowAtLogin"
                        render={({ field }) => (
                          <SettingsFormRow>
                            <div className="space-y-1">
                              <FormLabel>
                                {t('settings.general.showMainWindowAtLogin')}
                              </FormLabel>
                              <FormDescription className="text-xs">
                                {t(
                                  'settings.general.showMainWindowAtLoginDesc',
                                  {
                                    mode: t(
                                      transport.platform === 'darwin'
                                        ? 'settings.appearance.runModeTray'
                                        : 'settings.appearance.runModeTrayDesktop'
                                    ),
                                  }
                                )}
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                disabled={
                                  fieldsDisabled ||
                                  !form.watch('launchAtStartup')
                                }
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                          </SettingsFormRow>
                        )}
                      />
                    )}

                    <FormField
                      control={form.control}
                      name="defaultSaveDir"
                      render={({ field }) => (
                        <FormItem className="space-y-2">
                          <div className="space-y-1">
                            <FormLabel>
                              {t('settings.general.defaultSaveDir')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('settings.general.defaultSaveDirDesc')}
                            </FormDescription>
                          </div>
                          <SettingsDirectoryPicker
                            inputProps={{
                              ref: field.ref,
                              onBlur: field.onBlur,
                            }}
                            recordRecent={false}
                            allowFavoriteEditing={false}
                            disabled={directories.saving || favoritePicking}
                            onPickingChange={setDefaultPicking}
                          />
                          <FormMessage className="basis-full text-xs" />
                        </FormItem>
                      )}
                    />

                    <div className="space-y-3 border-b pb-4">
                      <p className="text-xs text-muted-foreground">
                        {t('directoryPreferences.sectionDescription')}
                      </p>
                      <DirectoryPreferencesSection
                        preferences={directories.preferences}
                        onChange={directories.setPreferences}
                        disabled={
                          busy || directories.loading || !directories.ready
                        }
                        onPickingChange={setFavoritePicking}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="autofillClipboardLinks"
                      render={({ field }) => (
                        <SettingsFormRow>
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
                              disabled={fieldsDisabled}
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="notifyOnComplete"
                      render={({ field }) => (
                        <SettingsFormRow>
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
                              disabled={fieldsDisabled}
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="notifyOnError"
                      render={({ field }) => (
                        <SettingsFormRow>
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
                              disabled={fieldsDisabled}
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />

                    {!isWeb && (
                      <FormField
                        control={form.control}
                        name="warnBeforeQuit"
                        render={({ field }) => (
                          <SettingsFormRow>
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
                                disabled={fieldsDisabled}
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                          </SettingsFormRow>
                        )}
                      />
                    )}
                  </fieldset>
                </form>
              </Form>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={close}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={
              form.formState.isSubmitting ||
              busy ||
              directories.loading ||
              !directories.ready
            }
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SettingsDirectoryPicker({
  inputProps,
  ...props
}: Omit<ComponentProps<typeof DirectoryPicker>, 'name'>) {
  const { formItemId, formMessageId, formDescriptionId, error } = useFormField()
  return (
    <DirectoryPicker
      {...props}
      name="defaultSaveDir"
      inputProps={{
        ...inputProps,
        id: formItemId,
        'aria-invalid': Boolean(error),
        'aria-describedby': `${formDescriptionId} ${formMessageId}`,
      }}
    />
  )
}
