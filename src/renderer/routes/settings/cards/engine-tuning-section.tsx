import { PresetChips } from '@renderer/components/settings-kit/preset-chips'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
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
import { type DownloadsFields, type EngineFields, KB } from './downloads-form'
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
    name: keyof EngineFields,
    labelKey: string,
    descKey: string,
    bounds: { min?: number; max?: number; step?: number; scale?: number },
    presets?: { label: string; value: number }[]
  ) => (
    <EngineNumberSettingRow
      form={form}
      name={name}
      labelKey={labelKey}
      descKey={descKey}
      bounds={bounds}
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
                <Input
                  value={field.value}
                  onChange={field.onChange}
                  className="w-64 h-8"
                />
              </FormControl>
            </div>
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
        { min: 1, max: 600 },
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
        { min: 1, max: 600 },
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
        { min: 0, max: 100 },
        [
          { label: '0', value: 0 },
          { label: '5', value: 5 },
          { label: '10', value: 10 },
        ]
      )}
      {numericRow(
        'retryWait',
        'settings.downloads.reliability.retryWait',
        'settings.downloads.reliability.retryWaitDesc',
        { min: 0, max: 300 }
      )}
      {numericRow(
        'lowestSpeedLimit',
        'settings.downloads.reliability.lowestSpeedLimit',
        'settings.downloads.reliability.lowestSpeedLimitDesc',
        { min: 0, scale: KB } // displayed KB/s → stored bytes/sec
      )}

      <Separator className="my-4" />

      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.disk.title')}
      </h3>
      <FormField
        control={form.control}
        name="engine.fileAllocation"
        render={({ field }) => (
          <FormItem className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
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
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="engine.remoteTime"
        render={({ field }) => (
          <FormItem className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
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
          </FormItem>
        )}
      />
      {numericRow(
        'sessionSaveInterval',
        'settings.downloads.disk.sessionSaveInterval',
        'settings.downloads.disk.sessionSaveIntervalDesc',
        { min: 10, max: 3600 }
      )}

      <Separator className="my-4" />

      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.magnet.title')}
      </h3>
      {numericRow(
        'magnetResolveTimeout',
        'settings.downloads.magnet.magnetResolveTimeout',
        'settings.downloads.magnet.magnetResolveTimeoutDesc',
        { min: 30, max: 600 }
      )}
    </>
  )
}
