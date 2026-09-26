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
  FormLabel,
} from '@renderer/components/ui/form'
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
import { useSidebarColorState } from '@renderer/lib/sidebar-color'
import { transport } from '@renderer/lib/transport'
import {
  isLanguagePreference,
  SUPPORTED_LOCALES,
} from '@shared/constants/locales'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import { resolveByteUnitSystem } from '@shared/schemas/byte-unit-system'
import type { MotrixAppSettings } from '@shared/types/settings'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'
import { appearanceFormSchema } from './settings-form-schemas'
import { SidebarColorPicker } from './sidebar-color-picker'

type AppearanceFields = Pick<
  MotrixAppSettings,
  | 'theme'
  | 'sidebarColor'
  | 'reduceMotion'
  | 'language'
  | 'byteUnitSystem'
  | 'traySpeedometer'
  | 'trayIconColor'
  | 'liquidGlassEffect'
>

// Source of truth: src/shared/schemas/app-settings.ts (DEFAULT_APP_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits. Keep this Pick<> in sync if the schema fields change.
const DEFAULTS: AppearanceFields = {
  theme: DEFAULT_APP_SETTINGS.theme,
  sidebarColor: DEFAULT_APP_SETTINGS.sidebarColor,
  reduceMotion: DEFAULT_APP_SETTINGS.reduceMotion,
  language: DEFAULT_APP_SETTINGS.language,
  byteUnitSystem: DEFAULT_APP_SETTINGS.byteUnitSystem,
  traySpeedometer: DEFAULT_APP_SETTINGS.traySpeedometer,
  trayIconColor: DEFAULT_APP_SETTINGS.trayIconColor,
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
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const languageOptions = [
    { value: 'system', label: t('settings.appearance.followSystem') },
    ...LANGUAGE_OPTIONS,
  ]
  const form = useSettingsForm<AppearanceFields>(appearanceFormSchema, DEFAULTS)

  const load = useSettingsLoad((all) => {
    if (!all?.app) throw new Error('Missing settings baseline')
    if (all?.app) {
      form.reset({
        theme: all.app.theme,
        sidebarColor: all.app.sidebarColor ?? DEFAULTS.sidebarColor,
        reduceMotion: all.app.reduceMotion ?? DEFAULTS.reduceMotion,
        language: all.app.language,
        byteUnitSystem: all.app.byteUnitSystem ?? DEFAULTS.byteUnitSystem,
        traySpeedometer: all.app.traySpeedometer,
        trayIconColor: all.app.trayIconColor ?? DEFAULTS.trayIconColor,
        liquidGlassEffect: all.app.liquidGlassEffect,
      })
    }
  })

  const sidebarColor = form.watch('sidebarColor')
  const colorIsDirty = !!form.formState.dirtyFields.sidebarColor
  useEffect(() => {
    useSidebarColorState.setState({
      preview: open && colorIsDirty ? sidebarColor : null,
    })
    return () => useSidebarColorState.setState({ preview: null })
  }, [open, colorIsDirty, sidebarColor])

  const onSubmit = useSettingsSubmit(form, async (values) => {
    if (!load.ready) return
    const dirty = pickDirty(values, form.formState.dirtyFields)
    if (!dirty) {
      onClose()
      return
    }
    await saveSettings({ app: dirty })
    if (dirty.sidebarColor !== undefined) {
      useSidebarColorState.setState((state) => ({
        saved: dirty.sidebarColor,
        revision: state.revision + 1,
      }))
    }
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
  const trayIconColorOptions = [
    { value: 'auto', label: t('settings.appearance.trayIconColorAuto') },
    { value: 'light', label: t('settings.appearance.trayIconColorLight') },
    { value: 'dark', label: t('settings.appearance.trayIconColorDark') },
  ] satisfies Array<{ value: AppearanceFields['trayIconColor']; label: string }>

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
            {t('settings.appearance.description')}
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
                    <h3 className="text-sm font-semibold">
                      {t('settings.appearance.themeAndEffects')}
                    </h3>
                    <FormField
                      control={form.control}
                      name="theme"
                      render={({ field }) => (
                        <SettingsFormRow>
                          <FormLabel>
                            {t('settings.appearance.theme')}
                          </FormLabel>
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
                      name="sidebarColor"
                      render={({ field }) => (
                        <SettingsFormRow className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                          <FormLabel className="sm:pt-2">
                            {t('settings.appearance.sidebarColor')}
                          </FormLabel>
                          <FormControl>
                            <SidebarColorPicker
                              value={field.value}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                              disabled={
                                !load.ready || form.formState.isSubmitting
                              }
                            />
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
                              {isMac &&
                                ` ${t('settings.appearance.liquidGlassEffectMacDesc')}`}
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
                    <Separator className="my-4" />
                    <h3 className="text-sm font-semibold">
                      {t('settings.appearance.languageAndDisplay')}
                    </h3>
                    <FormField
                      control={form.control}
                      name="language"
                      render={({ field }) => (
                        <SettingsFormRow>
                          <FormLabel>
                            {t('settings.appearance.language')}
                          </FormLabel>
                          <FormControl>
                            <Select
                              items={languageOptions}
                              value={field.value}
                              onValueChange={(value) => {
                                if (isLanguagePreference(value))
                                  field.onChange(value)
                              }}
                            >
                              <SettingsSelectTrigger>
                                <SelectValue />
                              </SettingsSelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {languageOptions.map((option) => (
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
                    <Separator className="my-4" />
                    <h3 className="text-sm font-semibold">
                      {t('settings.appearance.menuBar')}
                    </h3>
                    {isLinux && (
                      <FormField
                        control={form.control}
                        name="trayIconColor"
                        render={({ field }) => (
                          <SettingsFormRow>
                            <div className="space-y-1">
                              <FormLabel>
                                {t('settings.appearance.trayIconColor')}
                              </FormLabel>
                              <FormDescription className="text-xs">
                                {t('settings.appearance.trayIconColorDesc')}
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Select
                                items={trayIconColorOptions}
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
                                    {trayIconColorOptions.map((option) => (
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
