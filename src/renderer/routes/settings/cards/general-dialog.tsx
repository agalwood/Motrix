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
import { DirectoryPreferencesStatus } from '@renderer/features/directory-preferences/directory-preferences-section'
import { useDirectoryPreferencesDraft } from '@renderer/features/directory-preferences/use-directory-preferences-draft'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { RunMode } from '@shared/constants'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas'
import { GeneralSettingsAppSchema } from '@shared/schemas/general-settings'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'
import { generalFormSchema } from './settings-form-schemas'

export function GeneralDialog({
  open,
  onClose,
  labelKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const isWeb = transport.platform === 'web'
  const isMac = transport.platform === 'darwin'
  const isLinux = transport.platform === 'linux'
  const form = useSettingsForm(
    generalFormSchema,
    generalFormSchema.parse(DEFAULT_APP_SETTINGS)
  )
  const baseline = useRef(GeneralSettingsAppSchema.parse(DEFAULT_APP_SETTINGS))
  const directories = useDirectoryPreferencesDraft({
    getAppDraft: () => ({
      values: { ...baseline.current, ...form.getValues() },
      dirty: pickDirty(form.getValues(), form.formState.dirtyFields) ?? {},
    }),
    onAppRebase: (authority, intent) => {
      baseline.current = authority
      form.reset(
        generalFormSchema.parse({
          ...authority,
          runMode:
            !isMac && authority.runMode === RunMode.HideTray
              ? RunMode.Standard
              : authority.runMode,
        })
      )
      const edits = generalFormSchema.partial().parse(intent)
      for (const [key, value] of Object.entries(edits))
        form.setValue(key as keyof typeof edits, value as never, {
          shouldDirty: true,
        })
    },
  })
  const busy = form.formState.isSubmitting || directories.saving
  const disabled = !directories.ready || directories.loading || busy
  const onSubmit = useSettingsSubmit(form, async () => {
    if (!directories.ready || directories.loading || isWeb) return
    if (await directories.save()) onClose()
  })
  const close = () => {
    if (!busy) onClose()
  }
  const boolRow = (
    name:
      | 'launchAtStartup'
      | 'showMainWindowAtLogin'
      | 'lightweightMode'
      | 'warnBeforeQuit',
    description?: string,
    dependsOn = true
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <SettingsFormRow>
          <div className="space-y-1">
            <FormLabel>{t(`settings.general.${name}`)}</FormLabel>
            {description && (
              <FormDescription className="text-xs">
                {t(description)}
              </FormDescription>
            )}
          </div>
          <FormControl>
            <Switch
              disabled={disabled || !dependsOn}
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          </FormControl>
        </SettingsFormRow>
      )}
    />
  )
  const notificationRow = (
    system: 'notifyOnComplete' | 'notifyOnError',
    inside: 'notifyInAppOnComplete' | 'notifyInAppOnError',
    label: string
  ) => {
    const os = form.watch(system),
      app = form.watch(inside)
    const value = os ? (app ? 'both' : 'system') : app ? 'app' : 'none'
    const options = [
      { value: 'none', label: t('settings.general.notificationOff') },
      { value: 'system', label: t('settings.general.notificationSystem') },
      { value: 'app', label: t('settings.general.notificationInApp') },
      { value: 'both', label: t('settings.general.notificationBoth') },
    ]
    return (
      <FormField
        control={form.control}
        name={system}
        render={() => (
          <SettingsFormRow>
            <FormLabel>{t(label)}</FormLabel>
            <FormControl>
              <Select
                items={options}
                value={value}
                disabled={disabled}
                onValueChange={(v) => {
                  if (!v) return
                  form.setValue(system, v === 'system' || v === 'both', {
                    shouldDirty: true,
                  })
                  form.setValue(inside, v === 'app' || v === 'both', {
                    shouldDirty: true,
                  })
                }}
              >
                <SettingsSelectTrigger>
                  <SelectValue />
                </SettingsSelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectGroup>
                    {options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormControl>
          </SettingsFormRow>
        )}
      />
    )
  }
  const runModeOptions = isMac
    ? [
        {
          value: RunMode.Standard,
          label: t('settings.general.runModeStandard'),
        },
        { value: RunMode.TrayOnly, label: t('settings.general.runModeTray') },
        {
          value: RunMode.HideTray,
          label: t('settings.general.runModeHideTray'),
        },
      ]
    : [
        {
          value: RunMode.Standard,
          label: t('settings.appearance.runModeStandardDesktop'),
        },
        {
          value: RunMode.TrayOnly,
          label: t('settings.appearance.runModeTrayDesktop'),
        },
      ]
  const badgeOptions = ['count', 'dot', 'hidden'].map((value) => ({
    value,
    label: t(
      `settings.general.notificationBadge${value[0].toUpperCase()}${value.slice(1)}`
    ),
  }))
  return (
    <Dialog
      open={open}
      onOpenChange={(v, details) => {
        if (!v) {
          if (busy) details.cancel()
          else close()
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
            {t('settings.general.description')}
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
              <DirectoryPreferencesStatus
                loading={directories.loading}
                error={directories.error}
                disabled={busy}
                onRetry={() => void directories.refresh()}
              />
              {isWeb ? (
                <p className="text-sm text-muted-foreground">
                  {t('settings.general.desktopOnly')}
                </p>
              ) : (
                <Form {...form}>
                  <form noValidate onSubmit={onSubmit}>
                    <fieldset
                      inert={disabled}
                      disabled={disabled}
                      className="min-w-0 space-y-4"
                    >
                      <h3 className="text-sm font-semibold">
                        {t('settings.general.startupAndQuitting')}
                      </h3>
                      {boolRow('launchAtStartup')}
                      {boolRow(
                        'showMainWindowAtLogin',
                        undefined,
                        form.watch('launchAtStartup')
                      )}
                      <FormField
                        control={form.control}
                        name="runMode"
                        render={({ field }) => (
                          <SettingsFormRow>
                            <div className="space-y-1">
                              <FormLabel>
                                {t(
                                  isMac
                                    ? 'settings.general.runMode'
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
                                value={field.value}
                                disabled={disabled}
                                onValueChange={(v) =>
                                  v !== null && field.onChange(v)
                                }
                              >
                                <SettingsSelectTrigger className="min-w-48">
                                  <SelectValue />
                                </SettingsSelectTrigger>
                                <SelectContent position="popper" align="end">
                                  <SelectGroup>
                                    {runModeOptions.map((o) => (
                                      <SelectItem key={o.value} value={o.value}>
                                        {o.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </FormControl>
                          </SettingsFormRow>
                        )}
                      />
                      {boolRow(
                        'lightweightMode',
                        'settings.general.lightweightModeDesc'
                      )}
                      {boolRow(
                        'warnBeforeQuit',
                        'settings.general.warnBeforeQuitDesc'
                      )}
                      <Separator className="my-4" />
                      <h3 className="text-sm font-semibold">
                        {t('settings.general.notifications')}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t('settings.general.notificationsDesc')}
                      </p>
                      {notificationRow(
                        'notifyOnComplete',
                        'notifyInAppOnComplete',
                        'settings.general.downloadCompleted'
                      )}
                      {notificationRow(
                        'notifyOnError',
                        'notifyInAppOnError',
                        'settings.general.downloadFailed'
                      )}
                      <FormField
                        control={form.control}
                        name="notificationBadgeStyle"
                        render={({ field }) => (
                          <SettingsFormRow>
                            <div className="space-y-1">
                              <FormLabel>
                                {t('settings.general.notificationBadgeStyle')}
                              </FormLabel>
                              <FormDescription className="text-xs">
                                {t('settings.general.notificationBadgeDesc')}
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Select
                                items={badgeOptions}
                                value={field.value}
                                disabled={disabled}
                                onValueChange={(v) =>
                                  v !== null && field.onChange(v)
                                }
                              >
                                <SettingsSelectTrigger>
                                  <SelectValue />
                                </SettingsSelectTrigger>
                                <SelectContent position="popper" align="end">
                                  <SelectGroup>
                                    {badgeOptions.map((o) => (
                                      <SelectItem key={o.value} value={o.value}>
                                        {o.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </FormControl>
                          </SettingsFormRow>
                        )}
                      />
                    </fieldset>
                  </form>
                </Form>
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
            disabled={busy}
            onClick={close}
          >
            {t(isWeb ? 'common.close' : 'common.cancel')}
          </Button>
          {!isWeb && (
            <Button
              type="button"
              size="sm"
              onClick={onSubmit}
              disabled={disabled}
            >
              {t('common.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
