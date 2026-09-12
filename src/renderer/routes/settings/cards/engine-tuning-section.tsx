import { PresetChips } from '@renderer/components/settings-kit/preset-chips'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectValue,
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { BUILTIN_USER_AGENTS } from '@shared/constants/user-agents'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { DownloadsFields, EngineNumberField } from './downloads-form'
import { EngineNumberSettingRow } from './engine-number-setting-row'

// Advanced engine groups of the Downloads dialog: reliability, disk, magnet.
// Performance is rendered separately so speed limits can sit directly below it.
export function EngineTuningSection({
  form,
}: {
  form: UseFormReturn<DownloadsFields>
}) {
  const { t } = useTranslation()
  const fileAllocationOptions = [
    {
      value: 'none',
      label: t('settings.downloads.disk.fileAllocationNone'),
    },
    {
      value: 'prealloc',
      label: t('settings.downloads.disk.fileAllocationPrealloc'),
    },
    {
      value: 'trunc',
      label: t('settings.downloads.disk.fileAllocationTrunc'),
    },
    {
      value: 'falloc',
      label: t('settings.downloads.disk.fileAllocationFalloc'),
    },
  ] as const
  const modifiedTimeOptions = [
    {
      value: 'local',
      label: t('settings.downloads.disk.modifiedTimeLocal'),
    },
    {
      value: 'server',
      label: t('settings.downloads.disk.modifiedTimeServer'),
    },
  ] as const
  const numericRow = (
    name: EngineNumberField,
    labelKey: string,
    descKey: string,
    presets?: { label: string; value: number }[]
  ) => (
    <EngineNumberSettingRow
      form={form}
      name={name}
      labelKey={labelKey}
      descKey={descKey}
      presets={presets}
    />
  )

  return (
    <>
      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.reliability.title')}
      </h3>
      <FormField
        control={form.control}
        name="engine.userAgent"
        render={({ field }) => (
          <FormItem className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>
                  {t('settings.downloads.reliability.userAgent')}
                </FormLabel>
                <FormDescription className="text-xs">
                  {t('settings.downloads.reliability.userAgentDesc')}
                </FormDescription>
              </div>
              <FormControl>
                <Input {...field} className="w-64 h-8" />
              </FormControl>
            </div>
            <FormMessage className="text-xs" />
            <PresetChips
              name="engine.userAgent"
              options={BUILTIN_USER_AGENTS as never}
            />
          </FormItem>
        )}
      />
      {numericRow(
        'connectTimeout',
        'settings.downloads.reliability.connectTimeout',
        'settings.downloads.reliability.connectTimeoutDesc',
        [
          { label: '10s', value: 10 },
          { label: '30s', value: 30 },
          { label: '60s', value: 60 },
        ]
      )}
      {numericRow(
        'socketTimeout',
        'settings.downloads.reliability.socketTimeout',
        'settings.downloads.reliability.socketTimeoutDesc',
        [
          { label: '10s', value: 10 },
          { label: '30s', value: 30 },
          { label: '60s', value: 60 },
        ]
      )}
      {numericRow(
        'maxTries',
        'settings.downloads.reliability.maxTries',
        'settings.downloads.reliability.maxTriesDesc',
        [
          { label: '0', value: 0 },
          { label: '5', value: 5 },
          { label: '10', value: 10 },
        ]
      )}
      {numericRow(
        'retryWait',
        'settings.downloads.reliability.retryWait',
        'settings.downloads.reliability.retryWaitDesc'
      )}
      {numericRow(
        'lowestSpeedLimit',
        'settings.downloads.reliability.lowestSpeedLimit',
        'settings.downloads.reliability.lowestSpeedLimitDesc'
      )}

      <Separator className="my-4" />

      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.disk.title')}
      </h3>
      <FormField
        control={form.control}
        name="engine.fileAllocation"
        render={({ field }) => (
          <SettingsFormRow className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1 space-y-1">
              <FormLabel>
                {t('settings.downloads.disk.fileAllocation')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.downloads.disk.fileAllocationDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Select
                items={fileAllocationOptions}
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
                    {fileAllocationOptions.map(({ label, value }) => (
                      <SelectItem key={value} value={value}>
                        {label}
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
        name="engine.remoteTime"
        render={({ field }) => (
          <SettingsFormRow className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1 space-y-1">
              <FormLabel>{t('settings.downloads.disk.modifiedTime')}</FormLabel>
              <FormDescription className="text-xs">
                {t('settings.downloads.disk.modifiedTimeDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Select
                items={modifiedTimeOptions}
                value={field.value ? 'server' : 'local'}
                onValueChange={(value) => {
                  if (value !== null) field.onChange(value === 'server')
                }}
              >
                <SettingsSelectTrigger>
                  <SelectValue />
                </SettingsSelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modifiedTimeOptions.map(({ label, value }) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormControl>
          </SettingsFormRow>
        )}
      />
      {numericRow(
        'sessionSaveInterval',
        'settings.downloads.disk.sessionSaveInterval',
        'settings.downloads.disk.sessionSaveIntervalDesc'
      )}

      <Separator className="my-4" />

      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.magnet.title')}
      </h3>
      {numericRow(
        'magnetResolveTimeout',
        'settings.downloads.magnet.magnetResolveTimeout',
        'settings.downloads.magnet.magnetResolveTimeoutDesc'
      )}
    </>
  )
}
