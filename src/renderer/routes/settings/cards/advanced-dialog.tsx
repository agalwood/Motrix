import { RandomizeIcon } from '@renderer/components/icons'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
import {
  SettingsLoadStatus,
  useSettingsLoad,
} from '@renderer/components/settings-kit/use-settings-load'
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
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { PasswordInput } from '@renderer/components/ui/password-input'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { Separator } from '@renderer/components/ui/separator'
import { pickDirty } from '@renderer/lib/form-utils'
import { saveSettings } from '@renderer/lib/settings-save'
import { LEGACY_MIGRATION_SETTINGS_ROUTE } from '@shared/lib/legacy-import-navigation'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas'
import type { EngineSettings } from '@shared/types/settings'
import { generateRpcSecret } from '@shared/utils/rpc-secret'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { SettingsCardDialogProps } from './card-types'
import { OperatorTokenSection } from './operator-token-section'
import { SettingsFileSection } from './settings-file-section'
import { advancedFormSchema } from './settings-form-schemas'

type AdvancedFields = Pick<
  EngineSettings,
  'sessionSaveInterval' | 'rpcPort' | 'rpcSecret'
>
const DEFAULTS: AdvancedFields = {
  sessionSaveInterval: DEFAULT_ENGINE_SETTINGS.sessionSaveInterval,
  rpcPort: DEFAULT_ENGINE_SETTINGS.rpcPort,
  rpcSecret: DEFAULT_ENGINE_SETTINGS.rpcSecret,
}

export function AdvancedDialog({
  open,
  onClose,
  labelKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const form = useSettingsForm<AdvancedFields>(advancedFormSchema, DEFAULTS)

  const load = useSettingsLoad((all) => {
    if (!all?.engine) throw new Error('Missing settings baseline')
    if (all?.engine) {
      form.reset({
        sessionSaveInterval:
          all.engine.sessionSaveInterval ?? DEFAULTS.sessionSaveInterval,
        rpcPort: all.engine.rpcPort,
        rpcSecret: all.engine.rpcSecret,
      })
    }
  })

  const onSubmit = useSettingsSubmit(form, async (values) => {
    if (!load.ready) return
    const dirty = pickDirty(values, form.formState.dirtyFields)
    if (!dirty) {
      onClose()
      return
    }
    const patch = { engine: dirty }
    await saveSettings(patch)
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
            {t('settings.advanced.description')}
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
              <Form {...form}>
                <form noValidate onSubmit={onSubmit}>
                  <fieldset
                    inert={!load.ready || form.formState.isSubmitting}
                    disabled={!load.ready || form.formState.isSubmitting}
                    className="min-w-0 space-y-4"
                  >
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('settings.advanced.rpc.title')}
                    </h3>

                    <FormField
                      control={form.control}
                      name="rpcPort"
                      render={({ field }) => (
                        <SettingsFormRow>
                          <div className="space-y-1">
                            <FormLabel>
                              {t('settings.advanced.rpc.port')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('settings.advanced.rpc.portDesc')}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Input
                              {...field}
                              type="number"
                              min={1024}
                              max={65535}
                              className="w-30 h-8"
                              value={
                                Number.isFinite(field.value) ? field.value : ''
                              }
                              onChange={(event) =>
                                field.onChange(event.target.valueAsNumber)
                              }
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="rpcSecret"
                      render={({ field }) => (
                        <FormItem className="space-y-2">
                          <div className="space-y-1">
                            <FormLabel>
                              {t('settings.advanced.rpc.secret')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('settings.advanced.rpc.secretDesc')}
                            </FormDescription>
                          </div>
                          <div className="flex gap-2">
                            <FormControl>
                              <PasswordInput
                                {...field}
                                value={field.value}
                                onChange={field.onChange}
                                onBlur={field.onBlur}
                                showPasswordLabel={t(
                                  'settings.common.showSecret'
                                )}
                                hidePasswordLabel={t(
                                  'settings.common.hideSecret'
                                )}
                                className="flex-1"
                              />
                            </FormControl>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={t('settings.common.generate')}
                              onClick={() =>
                                field.onChange(generateRpcSecret())
                              }
                            >
                              <RandomizeIcon className="h-3 w-3" />
                            </Button>
                          </div>
                          <FormMessage className="basis-full text-xs" />
                        </FormItem>
                      )}
                    />

                    <Separator className="my-4" />

                    <h3 className="text-sm font-semibold text-foreground">
                      {t('settings.advanced.persistence.title')}
                    </h3>

                    <p className="text-xs text-muted-foreground">
                      {t('settings.advanced.persistence.managedByTaiji')}
                    </p>
                    <FormField
                      control={form.control}
                      name="sessionSaveInterval"
                      render={({ field }) => (
                        <SettingsFormRow>
                          <div className="space-y-1">
                            <FormLabel>
                              {t('settings.downloads.disk.sessionSaveInterval')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t(
                                'settings.downloads.disk.sessionSaveIntervalDesc'
                              )}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Input
                              {...field}
                              type="number"
                              min={10}
                              max={3600}
                              className="w-30 h-8"
                              onChange={(e) =>
                                field.onChange(e.target.valueAsNumber)
                              }
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />
                  </fieldset>
                </form>
              </Form>
              <Separator className="my-4" />
              <SettingsFileSection />
              {__MOTRIX_TARGET__ === 'web' && <OperatorTokenSection />}
              {__MOTRIX_TARGET__ === 'electron' && (
                <>
                  <Separator className="my-4" />
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <h3 className="text-sm font-medium">
                        {t('legacyImport.settingsTitle')}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t('legacyImport.settingsDescription')}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(LEGACY_MIGRATION_SETTINGS_ROUTE)}
                    >
                      {t('legacyImport.settingsAction')}
                    </Button>
                  </div>
                </>
              )}
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollBar />
        </ScrollArea>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {form.formState.errors.root?.save && (
            <p role="alert" className="me-auto text-xs text-destructive">
              {form.formState.errors.root.save.message}
            </p>
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
