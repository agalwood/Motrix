import { PresetChips } from '@renderer/components/settings-kit/preset-chips'
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
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { BUILTIN_USER_AGENTS } from '@shared/constants/user-agents'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type DownloadsFields,
  ENGINE_DEFAULTS,
  type EngineFields,
  KB,
  MB,
} from './downloads-form'

// Engine tuning groups of the Downloads dialog: performance, reliability,
// disk, magnet. All fields live under the `engine.*` form namespace.
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

  // Helper to render a numeric form row + optional preset chips.
  // `bounds.scale` (default 1) is the stored-per-displayed multiplier:
  //   1       — no conversion (counts, seconds)
  //   KB      — displayed KB/s, stored bytes/sec
  //   MB      — displayed MB,   stored bytes
  // bounds.min / bounds.max are in DISPLAYED units; call sites read naturally.
  const numericRow = (
    name: keyof EngineFields,
    labelKey: string,
    descKey: string,
    bounds: { min?: number; max?: number; step?: number; scale?: number },
    presets?: { label: string; value: number }[]
  ) => {
    const scale = bounds.scale ?? 1
    const scaledPresets = presets?.map((p) => ({
      ...p,
      value: p.value * scale,
    }))
    return (
      <FormField
        control={form.control}
        name={`engine.${name}` as never}
        render={({ field }) => {
          const stored = field.value as number
          const displayed = scale === 1 ? stored : Math.round(stored / scale)
          return (
            <FormItem className="space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <FormLabel>{t(labelKey)}</FormLabel>
                  <FormDescription className="text-xs">
                    {t(descKey)}
                  </FormDescription>
                </div>
                <FormControl>
                  <Input
                    type="number"
                    min={bounds.min}
                    max={bounds.max}
                    step={bounds.step}
                    className="w-28 h-8"
                    value={displayed}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value, 10)
                      field.onChange(
                        Number.isFinite(n)
                          ? n * scale
                          : (ENGINE_DEFAULTS as never)[name]
                      )
                    }}
                  />
                </FormControl>
              </div>
              {scaledPresets && (
                <PresetChips
                  name={`engine.${name}`}
                  options={scaledPresets as never}
                />
              )}
            </FormItem>
          )
        }}
      />
    )
  }

  return (
    <>
      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.performance.title')}
      </h3>
      {numericRow(
        'maxConcurrentDownloads',
        'settings.downloads.performance.maxConcurrentDownloads',
        'settings.downloads.performance.maxConcurrentDownloadsDesc',
        { min: 1, max: 100 },
        [
          { label: '1', value: 1 },
          { label: '3', value: 3 },
          { label: '5', value: 5 },
          { label: '10', value: 10 },
        ]
      )}
      {numericRow(
        'maxConnectionPerServer',
        'settings.downloads.performance.maxConnectionPerServer',
        'settings.downloads.performance.maxConnectionPerServerDesc',
        { min: 1, max: 16 },
        [
          { label: '1', value: 1 },
          { label: '4', value: 4 },
          { label: '8', value: 8 },
          { label: '16', value: 16 },
        ]
      )}
      {numericRow(
        'split',
        'settings.downloads.performance.split',
        'settings.downloads.performance.splitDesc',
        { min: 1, max: 128 },
        [
          { label: '4', value: 4 },
          { label: '8', value: 8 },
          { label: '16', value: 16 },
          { label: '32', value: 32 },
        ]
      )}
      {numericRow(
        'minSplitSize',
        'settings.downloads.performance.minSplitSize',
        'settings.downloads.performance.minSplitSizeDesc',
        { min: 1, scale: MB }, // displayed MB → stored bytes
        [
          { label: '1 MB', value: 1 },
          { label: '10 MB', value: 10 },
          { label: '50 MB', value: 50 },
        ]
      )}

      <Separator className="my-4" />

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
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
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
                <SelectTrigger className="w-30" size="sm">
                  <SelectValue />
                </SelectTrigger>
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
      {numericRow(
        'diskCache',
        'settings.downloads.disk.diskCache',
        'settings.downloads.disk.diskCacheDesc',
        { min: 0, max: 128, scale: MB } // displayed MB → stored bytes
      )}
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
