import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
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
  FormLabel,
} from '@renderer/components/ui/form'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
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
import { resolveByteUnitSystem } from '@shared/schemas/byte-unit-system'
import type { AppSettings, MotrixAppSettings } from '@shared/types/settings'
import { useTheme } from 'next-themes'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'
import { appearanceFormSchema } from './settings-form-schemas'

type AppearanceFields = Pick<
  MotrixAppSettings,
  | 'theme'
  | 'reduceMotion'
  | 'language'
  | 'byteUnitSystem'
  | 'traySpeedometer'
  | 'runMode'
  | 'liquidGlassEffect'
  | 'lightweightMode'
>

// Source of truth: src/shared/schemas/app-settings.ts (DEFAULT_APP_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits. Keep this Pick<> in sync if the schema fields change.
const DEFAULTS: AppearanceFields = {
  theme: DEFAULT_APP_SETTINGS.theme,
  reduceMotion: DEFAULT_APP_SETTINGS.reduceMotion,
  language: DEFAULT_APP_SETTINGS.language,
  byteUnitSystem: DEFAULT_APP_SETTINGS.byteUnitSystem,
  traySpeedometer: DEFAULT_APP_SETTINGS.traySpeedometer,
  runMode: DEFAULT_APP_SETTINGS.runMode,
  liquidGlassEffect: DEFAULT_APP_SETTINGS.liquidGlassEffect,
  lightweightMode: DEFAULT_APP_SETTINGS.lightweightMode,
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
  const form = useSettingsForm<AppearanceFields>(appearanceFormSchema, DEFAULTS)

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
            reduceMotion: all.app.reduceMotion ?? DEFAULTS.reduceMotion,
            language: all.app.language,
            byteUnitSystem: all.app.byteUnitSystem ?? DEFAULTS.byteUnitSystem,
            traySpeedometer: all.app.traySpeedometer,
            runMode:
              transport.platform !== 'darwin' &&
              all.app.runMode === RunMode.HideTray
                ? RunMode.Standard
                : all.app.runMode,
            liquidGlassEffect: all.app.liquidGlassEffect,
            lightweightMode: all.app.lightweightMode,
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

  const onSubmit = useSettingsSubmit(form, async (values) => {
    const dirty = pickDirty(values, form.formState.dirtyFields)
    if (!dirty) {
      onClose()
      return
    }
    await transport.invoke(Commands.UpdateSettings, { app: dirty })
    if (dirty.theme !== undefined) setTheme(dirty.theme)
    onClose()
  })

  const systemUnits = resolveByteUnitSystem(
    'system',
    transport.platform === 'web' ? navigator.platform : transport.platform
  )
  const byteUnitOptions = [
    {
      value: 'system',
      label: t('settings.appearance.byteUnitSystemDefault', {
        units: systemUnits === 'binary' ? 'MiB, GiB' : 'MB, GB',
      }),
    },
    { value: 'decimal', label: t('settings.appearance.byteUnitDecimal') },
    { value: 'binary', label: t('settings.appearance.byteUnitBinary') },
  ] satisfies Array<{
    value: AppearanceFields['byteUnitSystem']
    label: string
  }>

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
  const isMac = transport.platform === 'darwin'
  const isLinux = transport.platform === 'linux'
  const showRunMode = transport.platform !== 'web'
  const runModeOptions = isMac
    ? [
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
    : [
        {
          value: String(RunMode.Standard),
          label: t('settings.appearance.runModeStandardDesktop'),
        },
        {
          value: String(RunMode.TrayOnly),
          label: t('settings.appearance.runModeTrayDesktop'),
        },
      ]

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
            <form className="space-y-4" noValidate onSubmit={onSubmit}>
              <FormField
                control={form.control}
                name="theme"
                render={({ field }) => (
                  <SettingsFormRow>
                    <FormLabel>{t('settings.appearance.theme')}</FormLabel>
                    <FormControl>
                      <Select
                        items={themeOptions}
                        value={field.value}
                        onValueChange={(value) => {
                          if (value !== null) field.onChange(value)
                        }}
                      >
                        <SettingsSelectTrigger>
                          <SelectValue />
                        </SettingsSelectTrigger>
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
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="language"
                render={({ field }) => (
                  <SettingsFormRow>
                    <FormLabel>{t('settings.appearance.language')}</FormLabel>
                    <FormControl>
                      <Select
                        items={LANGUAGE_OPTIONS}
                        value={field.value}
                        onValueChange={(value) => {
                          if (isSupportedLocale(value)) field.onChange(value)
                        }}
                      >
                        <SettingsSelectTrigger>
                          <SelectValue />
                        </SettingsSelectTrigger>
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
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="byteUnitSystem"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.appearance.byteUnitSystem')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.appearance.byteUnitSystemDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Select
                        items={byteUnitOptions}
                        value={field.value}
                        onValueChange={(value) => {
                          if (value !== null) field.onChange(value)
                        }}
                      >
                        <SettingsSelectTrigger>
                          <SelectValue />
                        </SettingsSelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {byteUnitOptions.map((option) => (
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
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="reduceMotion"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.appearance.reduceMotion')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.appearance.reduceMotionDesc')}
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

              {isMac && (
                <FormField
                  control={form.control}
                  name="traySpeedometer"
                  render={({ field }) => (
                    <SettingsFormRow>
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
                    </SettingsFormRow>
                  )}
                />
              )}

              {isMac && (
                <FormField
                  control={form.control}
                  name="liquidGlassEffect"
                  render={({ field }) => (
                    <SettingsFormRow>
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
                    </SettingsFormRow>
                  )}
                />
              )}

              {showRunMode && (
                <FormField
                  control={form.control}
                  name="runMode"
                  render={({ field }) => (
                    <SettingsFormRow>
                      <div className="space-y-1">
                        <FormLabel>
                          {t(
                            isMac
                              ? 'settings.appearance.runMode'
                              : 'settings.appearance.runModeLaunch'
                          )}
                        </FormLabel>
                        {isLinux && (
                          <FormDescription className="text-xs">
                            {t('settings.appearance.runModeLinuxDesc')}
                          </FormDescription>
                        )}
                      </div>
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
                          <SettingsSelectTrigger className="min-w-48">
                            <SelectValue />
                          </SettingsSelectTrigger>
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
                    </SettingsFormRow>
                  )}
                />
              )}

              {transport.platform !== 'web' && (
                <FormField
                  control={form.control}
                  name="lightweightMode"
                  render={({ field }) => (
                    <SettingsFormRow>
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.appearance.lightweightMode')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.appearance.lightweightModeDesc')}
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
              )}
            </form>
          </Form>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {form.formState.errors.root?.save && (
            <p role="alert" className="mr-auto text-xs text-destructive">
              {form.formState.errors.root.save.message}
            </p>
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
