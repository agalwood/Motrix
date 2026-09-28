import { RandomizeIcon } from '@renderer/components/icons'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
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
import { Label } from '@renderer/components/ui/label'
import { PasswordInput } from '@renderer/components/ui/password-input'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectValue,
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { pickDirty } from '@renderer/lib/form-utils'
import { saveSettings } from '@renderer/lib/settings-save'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas'
import type { EngineSettings } from '@shared/types/settings'
import { generateRpcSecret } from '@shared/utils/rpc-secret'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'
import { advancedFormSchema } from './settings-form-schemas'

type HistoryRetentionMode = 'all' | 'limited' | 'session'

type AdvancedFields = Pick<
  EngineSettings,
  | 'sessionSaveInterval'
  | 'rpcPort'
  | 'rpcSecret'
  | 'sqlite3Persistence'
  | 'sqlite3DbPath'
  | 'sqlite3HistoryLimit'
>

const DEFAULTS: AdvancedFields = {
  sessionSaveInterval: DEFAULT_ENGINE_SETTINGS.sessionSaveInterval,
  rpcPort: DEFAULT_ENGINE_SETTINGS.rpcPort,
  rpcSecret: DEFAULT_ENGINE_SETTINGS.rpcSecret,
  sqlite3Persistence: DEFAULT_ENGINE_SETTINGS.sqlite3Persistence,
  sqlite3DbPath: DEFAULT_ENGINE_SETTINGS.sqlite3DbPath,
  sqlite3HistoryLimit: DEFAULT_ENGINE_SETTINGS.sqlite3HistoryLimit,
}

export function AdvancedDialog({
  open,
  onClose,
  labelKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const [historyModeOverride, setHistoryModeOverride] =
    useState<HistoryRetentionMode | null>(null)
  const historyModeRef = useRef<HistoryRetentionMode | null>(null)
  const lastHistoryCount = useRef(1000)
  const historyCountId = useId()
  const historyCountHintId = useId()
  const historyErrorId = useId()
  const form = useSettingsForm<AdvancedFields>(
    advancedFormSchema.refine(
      (values) =>
        historyModeRef.current !== 'limited' || values.sqlite3HistoryLimit > 0,
      {
        path: ['sqlite3HistoryLimit'],
        message: t('settings.advanced.persistence.historyCountPositive'),
      }
    ),
    DEFAULTS
  )
  const historyLimit = form.watch('sqlite3HistoryLimit')
  const historyMode =
    historyModeOverride ??
    (historyLimit === -1 ? 'all' : historyLimit === 0 ? 'session' : 'limited')
  const historyModeOptions = [
    { value: 'all', label: t('settings.advanced.persistence.historyKeepAll') },
    {
      value: 'limited',
      label: t('settings.advanced.persistence.historyKeepRecent'),
    },
    {
      value: 'session',
      label: t('settings.advanced.persistence.historySessionOnly'),
    },
  ] as const

  useEffect(() => {
    if (
      Number.isInteger(historyLimit) &&
      historyLimit > 0 &&
      historyLimit <= 1000000
    ) {
      lastHistoryCount.current = historyLimit
    }
  }, [historyLimit])

  const load = useSettingsLoad((all) => {
    if (!all?.engine) throw new Error('Missing settings baseline')
    if (all?.engine) {
      historyModeRef.current = null
      setHistoryModeOverride(null)
      form.reset({
        sessionSaveInterval:
          all.engine.sessionSaveInterval ?? DEFAULTS.sessionSaveInterval,
        rpcPort: all.engine.rpcPort,
        rpcSecret: all.engine.rpcSecret,
        sqlite3Persistence: all.engine.sqlite3Persistence,
        sqlite3DbPath: all.engine.sqlite3DbPath,
        sqlite3HistoryLimit: all.engine.sqlite3HistoryLimit,
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

  const persistenceOn = form.watch('sqlite3Persistence')

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

                    <FormField
                      control={form.control}
                      name="sqlite3Persistence"
                      render={({ field }) => (
                        <SettingsFormRow>
                          <div className="space-y-1">
                            <FormLabel>
                              {t('settings.advanced.persistence.enable')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('settings.advanced.persistence.enableDesc')}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="sqlite3DbPath"
                      render={({ field }) => (
                        <SettingsFormRow>
                          <div className="space-y-1">
                            <FormLabel>
                              {t('settings.advanced.persistence.dbPath')}
                            </FormLabel>
                            <FormDescription className="text-xs">
                              {t('settings.advanced.persistence.dbPathDesc')}
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Input
                              {...field}
                              className="w-56 h-8"
                              placeholder={t(
                                'settings.advanced.persistence.dbPathPlaceholder'
                              )}
                              disabled={
                                !persistenceOn &&
                                !form.formState.errors.sqlite3DbPath
                              }
                              value={field.value}
                              onChange={field.onChange}
                            />
                          </FormControl>
                        </SettingsFormRow>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="sqlite3HistoryLimit"
                      render={({ field, fieldState }) => {
                        const disabled = !persistenceOn && !fieldState.error
                        return (
                          <FormItem className="space-y-3">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <FormLabel>
                                  {t(
                                    'settings.advanced.persistence.historyLimit'
                                  )}
                                </FormLabel>
                                <FormDescription className="text-xs">
                                  {t(
                                    'settings.advanced.persistence.historyLimitDesc'
                                  )}
                                </FormDescription>
                              </div>
                              <Select
                                items={historyModeOptions}
                                value={historyMode}
                                disabled={disabled}
                                onValueChange={(
                                  next: HistoryRetentionMode | null
                                ) => {
                                  if (!next) return
                                  historyModeRef.current = next
                                  setHistoryModeOverride(next)
                                  form.setValue(
                                    'sqlite3HistoryLimit',
                                    next === 'all'
                                      ? -1
                                      : next === 'session'
                                        ? 0
                                        : lastHistoryCount.current,
                                    {
                                      shouldDirty: true,
                                      shouldValidate: true,
                                    }
                                  )
                                }}
                              >
                                <FormControl>
                                  <SettingsSelectTrigger
                                    ref={
                                      historyMode === 'limited'
                                        ? undefined
                                        : field.ref
                                    }
                                    onBlur={field.onBlur}
                                    className="shrink-0"
                                  >
                                    <SelectValue />
                                  </SettingsSelectTrigger>
                                </FormControl>
                                <SelectContent position="popper" align="end">
                                  <SelectGroup>
                                    {historyModeOptions.map((option) => (
                                      <SelectItem
                                        key={option.value}
                                        value={option.value}
                                      >
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </div>
                            {historyMode === 'limited' && (
                              <div className="flex items-start justify-between gap-4 border-s border-border/60 ps-4">
                                <div className="space-y-1">
                                  <Label htmlFor={historyCountId}>
                                    {t(
                                      'settings.advanced.persistence.historyCount'
                                    )}
                                  </Label>
                                  <p
                                    id={historyCountHintId}
                                    className="text-xs text-muted-foreground"
                                  >
                                    {t(
                                      'settings.advanced.persistence.historyCountHint'
                                    )}
                                  </p>
                                </div>
                                <Input
                                  id={historyCountId}
                                  ref={field.ref}
                                  name={field.name}
                                  type="number"
                                  min={1}
                                  max={1000000}
                                  step={1}
                                  className="w-30 h-8 shrink-0"
                                  disabled={disabled}
                                  aria-invalid={Boolean(fieldState.error)}
                                  aria-describedby={`${historyCountHintId}${fieldState.error ? ` ${historyErrorId}` : ''}`}
                                  value={
                                    Number.isFinite(field.value)
                                      ? field.value
                                      : ''
                                  }
                                  onBlur={field.onBlur}
                                  onChange={(event) => {
                                    historyModeRef.current = 'limited'
                                    setHistoryModeOverride('limited')
                                    field.onChange(event.target.valueAsNumber)
                                  }}
                                />
                              </div>
                            )}
                            {fieldState.error && (
                              <div id={historyErrorId}>
                                <FormMessage className="text-xs" />
                              </div>
                            )}
                          </FormItem>
                        )
                      }}
                    />
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
