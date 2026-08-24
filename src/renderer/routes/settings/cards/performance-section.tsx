import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import { Badge } from '@renderer/components/ui/badge'
import {
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
  SelectValue,
} from '@renderer/components/ui/select'
import {
  ENGINE_PERFORMANCE_PROFILE_IDS,
  type EnginePerformanceProfile,
  getEnginePerformanceProfileValues,
} from '@shared/constants/engine-performance-profiles'
import { MAX_CONNECTIONS_PER_SERVER } from '@shared/schemas/engine-settings'
import {
  DatabaseIcon,
  type LucideIcon,
  RulerIcon,
  ServerIcon,
  SplitIcon,
} from 'lucide-react'
import { type UseFormReturn, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { type DownloadsFields, MB } from './downloads-form'
import { EngineNumberSettingRow } from './engine-number-setting-row'

type PerformanceMetric = {
  icon: LucideIcon
  label: string
  value: number | string
}

export function PerformanceSection({
  form,
}: {
  form: UseFormReturn<DownloadsFields>
}) {
  const { t } = useTranslation()
  const performanceProfile = useWatch({
    control: form.control,
    name: 'engine.performanceProfile',
  })
  const performanceProfileOptions = ENGINE_PERFORMANCE_PROFILE_IDS.map(
    (value) => ({
      value,
      label: t(`settings.downloads.performance.profiles.${value}.label`),
    })
  )
  const selectedPerformanceValues =
    getEnginePerformanceProfileValues(performanceProfile)
  const performanceMetrics: PerformanceMetric[] | null =
    selectedPerformanceValues
      ? [
          {
            icon: SplitIcon,
            label: t('settings.downloads.performance.metrics.segments'),
            value: selectedPerformanceValues.split,
          },
          {
            icon: ServerIcon,
            label: t('settings.downloads.performance.metrics.perServer'),
            value: selectedPerformanceValues.maxConnectionPerServer,
          },
          {
            icon: RulerIcon,
            label: t('settings.downloads.performance.metrics.minimum'),
            value: `${Math.round(selectedPerformanceValues.minSplitSize / MB)} MB`,
          },
          {
            icon: DatabaseIcon,
            label: t('settings.downloads.performance.metrics.cache'),
            value: `${Math.round(selectedPerformanceValues.diskCache / MB)} MB`,
          },
        ]
      : null

  const applyPerformanceProfile = (profile: EnginePerformanceProfile) => {
    const values = getEnginePerformanceProfileValues(profile)
    if (!values) return
    form.setValue(
      'engine.maxConnectionPerServer',
      values.maxConnectionPerServer,
      { shouldDirty: true, shouldValidate: true }
    )
    form.setValue('engine.split', values.split, {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.setValue('engine.minSplitSize', values.minSplitSize, {
      shouldDirty: true,
      shouldValidate: true,
    })
    form.setValue('engine.diskCache', values.diskCache, {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  return (
    <>
      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.downloads.performance.title')}
      </h3>
      <FormField
        control={form.control}
        name="engine.performanceProfile"
        render={({ field }) => (
          <FormItem className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FormLabel>
                  {t('settings.downloads.performance.profile')}
                </FormLabel>
                <FormDescription className="text-xs">
                  {t('settings.downloads.performance.profileDesc')}
                </FormDescription>
              </div>
              <FormControl>
                <Select
                  items={performanceProfileOptions}
                  value={field.value}
                  onValueChange={(value) => {
                    if (value === null) return
                    const profile = value as EnginePerformanceProfile
                    field.onChange(profile)
                    applyPerformanceProfile(profile)
                  }}
                >
                  <SettingsSelectTrigger className="min-w-40">
                    <SelectValue />
                  </SettingsSelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {performanceProfileOptions.map(({ label, value }) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FormControl>
            </div>

            <div
              className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
              aria-live="polite"
              aria-atomic="true"
            >
              <div className="flex min-h-5 items-start justify-between gap-3">
                <p className="min-w-0 py-0.5">
                  {t(
                    `settings.downloads.performance.profiles.${performanceProfile}.desc`
                  )}
                </p>
                {performanceProfile === 'auto' && (
                  <Badge
                    className="h-5 bg-transparent px-1.5 text-[10px] text-muted-foreground"
                    variant="outline"
                  >
                    {t('settings.downloads.performance.baseline')}
                  </Badge>
                )}
              </div>
              {performanceMetrics && (
                <div className="mt-2">
                  <div className="grid grid-cols-4 overflow-hidden rounded-md border border-border bg-background/70">
                    {performanceMetrics.map(({ icon: Icon, label, value }) => (
                      <div
                        className="flex min-w-0 items-center gap-2 px-2.5 py-2 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-border"
                        key={label}
                      >
                        <Icon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0 leading-tight">
                          <p className="truncate font-semibold tabular-nums text-foreground">
                            {value}
                          </p>
                          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {label}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </FormItem>
        )}
      />

      {performanceProfile === 'custom' && (
        <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3">
          <h4 className="text-xs font-semibold text-foreground">
            {t('settings.downloads.performance.customParameters')}
          </h4>
          <EngineNumberSettingRow
            form={form}
            name="maxConnectionPerServer"
            labelKey="settings.downloads.performance.maxConnectionPerServer"
            descKey="settings.downloads.performance.maxConnectionPerServerDesc"
            bounds={{ min: 1, max: MAX_CONNECTIONS_PER_SERVER }}
            presets={[
              { label: '1', value: 1 },
              { label: '8', value: 8 },
              { label: '16', value: 16 },
              { label: '32', value: 32 },
              {
                label: String(MAX_CONNECTIONS_PER_SERVER),
                value: MAX_CONNECTIONS_PER_SERVER,
              },
            ]}
          />
          <EngineNumberSettingRow
            form={form}
            name="split"
            labelKey="settings.downloads.performance.split"
            descKey="settings.downloads.performance.splitDesc"
            bounds={{ min: 1, max: 128 }}
            presets={[
              { label: '4', value: 4 },
              { label: '16', value: 16 },
              { label: '32', value: 32 },
              { label: '64', value: 64 },
            ]}
          />
          <EngineNumberSettingRow
            form={form}
            name="minSplitSize"
            labelKey="settings.downloads.performance.minSplitSize"
            descKey="settings.downloads.performance.minSplitSizeDesc"
            bounds={{ min: 1, scale: MB }}
            presets={[
              { label: '1 MB', value: 1 },
              { label: '4 MB', value: 4 },
              { label: '10 MB', value: 10 },
              { label: '20 MB', value: 20 },
            ]}
          />
          <EngineNumberSettingRow
            form={form}
            name="diskCache"
            labelKey="settings.downloads.disk.diskCache"
            descKey="settings.downloads.disk.diskCacheDesc"
            bounds={{ min: 0, max: 128, scale: MB }}
            presets={[
              { label: '16 MB', value: 16 },
              { label: '32 MB', value: 32 },
              { label: '64 MB', value: 64 },
            ]}
          />
        </div>
      )}

      <EngineNumberSettingRow
        form={form}
        name="maxConcurrentDownloads"
        labelKey="settings.downloads.performance.maxConcurrentDownloads"
        descKey="settings.downloads.performance.maxConcurrentDownloadsDesc"
        bounds={{ min: 1, max: 100 }}
        presets={[
          { label: '1', value: 1 },
          { label: '3', value: 3 },
          { label: '5', value: 5 },
          { label: '10', value: 10 },
        ]}
      />
    </>
  )
}
