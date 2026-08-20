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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { RunMode } from '@shared/constants'
import { isSupportedLocale, SUPPORTED_LOCALES } from '@shared/constants/locales'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import type { AppSettings, MotrixAppSettings } from '@shared/types/settings'
import { useTheme } from 'next-themes'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'

type AppearanceFields = Pick<
  MotrixAppSettings,
  'theme' | 'language' | 'traySpeedometer' | 'runMode' | 'liquidGlassEffect'
>

// Source of truth: src/shared/schemas/app-settings.ts (DEFAULT_APP_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits. Keep this Pick<> in sync if the schema fields change.
const DEFAULTS: AppearanceFields = {
  theme: DEFAULT_APP_SETTINGS.theme,
  language: DEFAULT_APP_SETTINGS.language,
  traySpeedometer: DEFAULT_APP_SETTINGS.traySpeedometer,
  runMode: DEFAULT_APP_SETTINGS.runMode,
  liquidGlassEffect: DEFAULT_APP_SETTINGS.liquidGlassEffect,
}

const LANGUAGE_OPTIONS = SUPPORTED_LOCALES.map(({ code, nativeName }) => ({
  value: code,
  label: nativeName,
})) satisfies Array<{
  value: AppearanceFields['language']
  label: string
}>

export function AppearanceDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const { setTheme } = useTheme()
  const form = useForm<AppearanceFields>({ defaultValues: DEFAULTS })

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
            theme: all.app.theme,
            language: all.app.language,
            traySpeedometer: all.app.traySpeedometer,
            runMode: all.app.runMode,
            liquidGlassEffect: all.app.liquidGlassEffect,
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
    await transport.invoke(Commands.UpdateSettings, { app: dirty })
    if (dirty.theme !== undefined) setTheme(dirty.theme)
    onClose()
  })

  const themeOptions = [
    {
      value: 'system',
      label: t('settings.appearance.themeAuto'),
    },
    {
      value: 'light',
      label: t('settings.appearance.themeLight'),
    },
    {
      value: 'dark',
      label: t('settings.appearance.themeDark'),
    },
  ] satisfies Array<{
    value: AppearanceFields['theme']
    label: string
  }>
  const runModeOptions = [
    {
      value: String(RunMode.Standard),
      label: t('settings.appearance.runModeStandard'),
    },
    {
      value: String(RunMode.TrayOnly),
      label: t('settings.appearance.runModeTray'),
    },
    {
      value: String(RunMode.HideTray),
      label: t('settings.appearance.runModeHideTray'),
    },
  ]
  const showMacOnly = transport.platform === 'darwin'

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
              <FormField
                control={form.control}
                name="theme"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>{t('settings.appearance.theme')}</FormLabel>
                    <FormControl>
                      <Select
                        items={themeOptions}
                        value={field.value}
                        onValueChange={(value) => {
                          if (value !== null) field.onChange(value)
                        }}
                      >
                        <SelectTrigger className="w-32" size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {themeOptions.map((option) => (
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
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="language"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <FormLabel>{t('settings.appearance.language')}</FormLabel>
                    <FormControl>
                      <Select
                        items={LANGUAGE_OPTIONS}
                        value={field.value}
                        onValueChange={(value) => {
                          if (isSupportedLocale(value)) field.onChange(value)
                        }}
                      >
                        <SelectTrigger className="min-w-32 max-w-64" size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {LANGUAGE_OPTIONS.map((option) => (
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
                    </FormControl>
                  </FormItem>
                )}
              />

              {showMacOnly && (
                <FormField
                  control={form.control}
                  name="traySpeedometer"
                  render={({ field }) => (
                    <FormItem className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.appearance.traySpeedometer')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.appearance.traySpeedometerDesc')}
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

              {showMacOnly && (
                <FormField
                  control={form.control}
                  name="liquidGlassEffect"
                  render={({ field }) => (
                    <FormItem className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.appearance.liquidGlassEffect')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.appearance.liquidGlassEffectDesc')}
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

              {showMacOnly && (
                <FormField
                  control={form.control}
                  name="runMode"
                  render={({ field }) => (
                    <FormItem className="flex items-start justify-between gap-4">
                      <FormLabel>{t('settings.appearance.runMode')}</FormLabel>
                      <FormControl>
                        <Select
                          items={runModeOptions}
                          value={String(field.value)}
                          onValueChange={(value) => {
                            if (value !== null) {
                              field.onChange(Number(value))
                            }
                          }}
                        >
                          <SelectTrigger className="w-48" size="sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {runModeOptions.map((option) => (
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
