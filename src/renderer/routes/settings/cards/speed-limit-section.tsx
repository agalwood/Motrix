import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { toast } from '@renderer/components/ui/toast'
import { Toggle } from '@renderer/components/ui/toggle'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@renderer/components/ui/toggle-group'
import { useByteFormat } from '@renderer/hooks/use-byte-format'

import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type { SpeedLimitSettings } from '@shared/types/settings'
import type { SpeedPoint } from '@shared/types/stats'
import { type ComponentProps, forwardRef } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { CompactLimitInput } from './compact-limit-input'
import { type DownloadsFields, MBPS } from './downloads-form'

const TIME_INPUT_CLS = 'h-8 w-24 bg-background font-mono tabular-nums'
const TIME_24_PATTERN = '(?:[01]\\d|2[0-3]):[0-5]\\d'

const TURTLE_STATES = ['off', 'on', 'auto'] as const
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

type Translate = ReturnType<typeof useTranslation>['t']
type KbLimitName =
  | 'speedLimit.base.download'
  | 'speedLimit.base.upload'
  | 'speedLimit.alt.download'
  | 'speedLimit.alt.upload'
type MbpsLimitName =
  | 'speedLimit.auto.adaptive.linkDown'
  | 'speedLimit.auto.adaptive.linkUp'

function sanitizeTimeDraft(rawValue: string): string {
  const sanitized = rawValue.replaceAll('：', ':').replace(/[^\d:]/g, '')
  if (!sanitized.includes(':')) {
    const digits = sanitized.slice(0, 4)
    return digits.length === 4
      ? `${digits.slice(0, 2)}:${digits.slice(2)}`
      : digits
  }

  const [hours = '', ...minuteParts] = sanitized.split(':')
  return `${hours.slice(0, 2)}:${minuteParts.join('').slice(0, 2)}`
}

function normalizeTime24(rawValue: string): string | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(rawValue)
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

type Time24InputProps = Omit<
  ComponentProps<typeof Input>,
  'type' | 'value' | 'onChange'
> & {
  value: string
  onValueChange: (value: string) => void
}

const Time24Input = forwardRef<HTMLInputElement, Time24InputProps>(
  function Time24Input(
    { value, onValueChange, onBlur, className, ...props },
    ref
  ) {
    return (
      <Input
        {...props}
        ref={ref}
        type="text"
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        maxLength={5}
        pattern={TIME_24_PATTERN}
        placeholder="HH:mm"
        className={`${TIME_INPUT_CLS} ${className ?? ''}`}
        value={value}
        onChange={(event) =>
          onValueChange(sanitizeTimeDraft(event.target.value))
        }
        onBlur={(event) => {
          const normalized = normalizeTime24(value)
          if (normalized) onValueChange(normalized)
          onBlur?.(event)
        }}
      />
    )
  }
)

function minCap(values: number[]): number {
  let min = 0
  for (const value of values) {
    if (value <= 0) continue
    if (min === 0 || value < min) min = value
  }
  return min
}

function crossesMidnight(from: string, to: string): boolean {
  return to < from
}

function effectSummary(
  settings: SpeedLimitSettings,
  t: Translate,
  formatSpeed: (value: number) => string
): { primary: string; secondary?: string } {
  function formatLimit(value: number, t: Translate): string {
    return value <= 0
      ? t('settings.downloads.speedLimit.unlimited')
      : formatSpeed(value)
  }
  const regularValues = {
    download: formatLimit(settings.base.download, t),
    upload: formatLimit(settings.base.upload, t),
  }

  if (settings.turtle === 'off') {
    return {
      primary: t(
        'settings.downloads.speedLimit.effect.standard',
        regularValues
      ),
    }
  }

  if (settings.turtle === 'on') {
    return {
      primary: t('settings.downloads.speedLimit.effect.lowSpeed', {
        download: formatLimit(
          minCap([settings.base.download, settings.alt.download]),
          t
        ),
        upload: formatLimit(
          minCap([settings.base.upload, settings.alt.upload]),
          t
        ),
      }),
    }
  }

  const rules: string[] = []
  if (settings.auto.schedule.enabled) {
    rules.push(
      t('settings.downloads.speedLimit.effect.scheduleRule', {
        from: settings.auto.schedule.from,
        to: settings.auto.schedule.to,
        nextDay: crossesMidnight(
          settings.auto.schedule.from,
          settings.auto.schedule.to
        )
          ? t('settings.downloads.speedLimit.effect.nextDay')
          : '',
      })
    )
  }
  if (settings.auto.adaptive.enabled) {
    const bandwidthReady =
      settings.auto.adaptive.linkDown > 0 && settings.auto.adaptive.linkUp > 0
    rules.push(
      t(
        bandwidthReady
          ? 'settings.downloads.speedLimit.effect.adaptiveRule'
          : 'settings.downloads.speedLimit.effect.adaptiveRulePending',
        {
          reserved: 100 - settings.auto.adaptive.headroomPercent,
        }
      )
    )
  }

  if (rules.length === 0) {
    return {
      primary: t('settings.downloads.speedLimit.effect.noAutoRules'),
      secondary: t(
        'settings.downloads.speedLimit.effect.standardValues',
        regularValues
      ),
    }
  }

  return {
    primary: t('settings.downloads.speedLimit.effect.autoRules', {
      rules: rules.join(
        t('settings.downloads.speedLimit.effect.ruleSeparator')
      ),
    }),
    secondary: t('settings.downloads.speedLimit.effect.lowerWins'),
  }
}

function SectionIntro({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

export function SpeedLimitSection({
  form,
}: {
  form: UseFormReturn<DownloadsFields>
}) {
  const { formatSpeed, unitSystem } = useByteFormat()
  const kiloByte = unitSystem === 'binary' ? 1024 : 1000

  const { t } = useTranslation()
  const settings = form.watch('speedLimit')
  const turtle = settings.turtle
  const scheduleEnabled = settings.auto.schedule.enabled
  const adaptiveEnabled = settings.auto.adaptive.enabled
  const summary = effectSummary(settings, t, formatSpeed)

  const kbLimitRow = (
    name: KbLimitName,
    labelKey: string,
    descKey: string,
    zeroAction: 'unlimited' | 'inherit'
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <FormLabel>{t(labelKey)}</FormLabel>
            <FormDescription className="text-xs">{t(descKey)}</FormDescription>
            <FormMessage className="text-xs" />
          </div>
          <FormControl>
            <CompactLimitInput
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={(field.value as number) / kiloByte}
              onValueChange={(value) =>
                field.onChange(Math.round(value * kiloByte))
              }
              unit={unitSystem === 'binary' ? 'KiB/s' : 'KB/s'}
              zeroAction={zeroAction}
              zeroLabel={t(
                zeroAction === 'inherit'
                  ? 'settings.downloads.speedLimit.standardLimit'
                  : 'settings.downloads.speedLimit.unlimited'
              )}
              resetLabel={t(
                zeroAction === 'inherit'
                  ? 'settings.downloads.speedLimit.useStandardLimit'
                  : 'settings.downloads.speedLimit.setUnlimited'
              )}
            />
          </FormControl>
        </FormItem>
      )}
    />
  )

  const mbpsLimitRow = (
    name: MbpsLimitName,
    labelKey: string,
    descKey: string
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <FormLabel>{t(labelKey)}</FormLabel>
            <FormDescription className="text-xs">{t(descKey)}</FormDescription>
            <FormMessage className="text-xs" />
          </div>
          <div className="relative shrink-0">
            <FormControl>
              <Input
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                type="number"
                min={0}
                step="any"
                className="h-8 w-32 pr-14"
                value={Number.isFinite(field.value) ? field.value / MBPS : ''}
                onChange={(event) => {
                  field.onChange(Math.round(event.target.valueAsNumber * MBPS))
                }}
              />
            </FormControl>
            <span
              className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground"
              aria-hidden
            >
              Mbps
            </span>
          </div>
        </FormItem>
      )}
    />
  )

  const fillFromPeak = async () => {
    try {
      const data = await transport.invoke(Queries.GetSpeedHistory, {
        limit: 300,
      })
      const points = data as SpeedPoint[]
      if (!points?.length) {
        toast.add({
          title: t('settings.downloads.speedLimit.estimateEmpty'),
          type: 'info',
        })
        return
      }

      const peakDown = Math.max(...points.map((point) => point.down))
      const peakUp = Math.max(...points.map((point) => point.up))
      if (peakDown <= 0 && peakUp <= 0) {
        toast.add({
          title: t('settings.downloads.speedLimit.estimateEmpty'),
          type: 'info',
        })
        return
      }

      if (peakDown > 0) {
        form.setValue('speedLimit.auto.adaptive.linkDown', peakDown, {
          shouldDirty: true,
        })
      }
      if (peakUp > 0) {
        form.setValue('speedLimit.auto.adaptive.linkUp', peakUp, {
          shouldDirty: true,
        })
      }
      toast.add({
        title: t('settings.downloads.speedLimit.estimateSuccess'),
        type: 'success',
      })
    } catch {
      toast.add({
        title: t('settings.downloads.speedLimit.estimateError'),
        type: 'error',
      })
    }
  }

  return (
    <>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">
          {t('settings.downloads.speedLimit.title')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.downloads.speedLimit.titleDesc')}
        </p>
      </div>

      <SectionIntro
        title={t('settings.downloads.speedLimit.modeSection')}
        description={t('settings.downloads.speedLimit.modeSectionDesc')}
      />

      <FormField
        control={form.control}
        name="speedLimit.turtle"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="min-w-0 space-y-1">
              <FormLabel>{t('settings.downloads.speedLimit.turtle')}</FormLabel>
              <FormDescription className="text-xs">
                {t(
                  `settings.downloads.speedLimit.turtleDesc_${field.value as (typeof TURTLE_STATES)[number]}`
                )}
              </FormDescription>
            </div>
            <FormControl>
              <ToggleGroup
                className="shrink-0"
                aria-label={t('settings.downloads.speedLimit.turtle')}
                value={[field.value]}
                onValueChange={(values) => {
                  const value = values[0]
                  if (value) field.onChange(value)
                }}
              >
                {TURTLE_STATES.map((state) => (
                  <ToggleGroupItem key={state} value={state} type="button">
                    {t(`settings.downloads.speedLimit.turtle_${state}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FormControl>
          </SettingsFormRow>
        )}
      />

      <Separator className="my-2" />

      <SectionIntro
        title={t('settings.downloads.speedLimit.baseSection')}
        description={t('settings.downloads.speedLimit.baseSectionDesc')}
      />
      {kbLimitRow(
        'speedLimit.base.download',
        'settings.downloads.speedLimit.baseDownload',
        'settings.downloads.speedLimit.baseDownloadDesc',
        'unlimited'
      )}
      {kbLimitRow(
        'speedLimit.base.upload',
        'settings.downloads.speedLimit.baseUpload',
        'settings.downloads.speedLimit.baseUploadDesc',
        'unlimited'
      )}

      <Separator className="my-2" />

      <SectionIntro
        title={t('settings.downloads.speedLimit.altSection')}
        description={t('settings.downloads.speedLimit.altSectionDesc')}
      />
      {kbLimitRow(
        'speedLimit.alt.download',
        'settings.downloads.speedLimit.altDownload',
        'settings.downloads.speedLimit.altDownloadDesc',
        'inherit'
      )}
      {kbLimitRow(
        'speedLimit.alt.upload',
        'settings.downloads.speedLimit.altUpload',
        'settings.downloads.speedLimit.altUploadDesc',
        'inherit'
      )}

      {(turtle === 'auto' || form.formState.errors.speedLimit?.auto) && (
        <>
          <Separator className="my-2" />

          <SectionIntro
            title={t('settings.downloads.speedLimit.autoSection')}
            description={t('settings.downloads.speedLimit.autoSectionDesc')}
          />

          <h5 className="text-xs font-medium text-foreground">
            {t('settings.downloads.speedLimit.autoSchedule')}
          </h5>

          <FormField
            control={form.control}
            name="speedLimit.auto.schedule.enabled"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="min-w-0 space-y-1">
                  <FormLabel>
                    {t('settings.downloads.speedLimit.scheduleEnabled')}
                  </FormLabel>
                  <FormDescription className="text-xs">
                    {t('settings.downloads.speedLimit.scheduleEnabledDesc')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value as boolean}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </SettingsFormRow>
            )}
          />

          {(scheduleEnabled ||
            form.formState.errors.speedLimit?.auto?.schedule) && (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-1">
                <FormField
                  control={form.control}
                  name="speedLimit.auto.schedule.from"
                  render={({ field }) => (
                    <SettingsFormRow className="flex items-center gap-2">
                      <FormLabel className="shrink-0 text-sm">
                        {t('settings.downloads.speedLimit.scheduleFrom')}
                      </FormLabel>
                      <FormControl>
                        <Time24Input
                          ref={field.ref}
                          name={field.name}
                          onBlur={field.onBlur}
                          value={field.value as string}
                          onValueChange={field.onChange}
                          title={t(
                            'settings.downloads.speedLimit.scheduleTimeFormat'
                          )}
                        />
                      </FormControl>
                    </SettingsFormRow>
                  )}
                />
                <FormField
                  control={form.control}
                  name="speedLimit.auto.schedule.to"
                  render={({ field }) => (
                    <SettingsFormRow className="flex items-center gap-2">
                      <FormLabel className="shrink-0 text-sm">
                        {t('settings.downloads.speedLimit.scheduleTo')}
                      </FormLabel>
                      <FormControl>
                        <Time24Input
                          ref={field.ref}
                          name={field.name}
                          onBlur={field.onBlur}
                          value={field.value as string}
                          onValueChange={field.onChange}
                          title={t(
                            'settings.downloads.speedLimit.scheduleTimeFormat'
                          )}
                        />
                      </FormControl>
                    </SettingsFormRow>
                  )}
                />
                <span className="text-xs text-muted-foreground">
                  {t('settings.downloads.speedLimit.scheduleTimeFormat')}
                </span>
              </div>

              <FormField
                control={form.control}
                name="speedLimit.auto.schedule.days"
                render={({ field }) => {
                  const days = (field.value as number[]) ?? []
                  const toggle = (day: number) => {
                    const selectedDays =
                      days.length === 0
                        ? WEEKDAYS.map((_, index) => index)
                        : days
                    const next = selectedDays.includes(day)
                      ? selectedDays.filter((value) => value !== day)
                      : [...selectedDays, day].sort((a, b) => a - b)
                    field.onChange(next.length === WEEKDAYS.length ? [] : next)
                  }
                  return (
                    <FormItem className="space-y-1">
                      <FormDescription className="text-xs">
                        {t('settings.downloads.speedLimit.scheduleDays')}
                      </FormDescription>
                      <div className="flex gap-1">
                        {WEEKDAYS.map((day, index) => (
                          <Toggle
                            key={day}
                            size="sm"
                            variant="outline"
                            aria-label={t(
                              `settings.downloads.speedLimit.weekdays.${day}.long`
                            )}
                            pressed={days.length === 0 || days.includes(index)}
                            onPressedChange={() => toggle(index)}
                            className="text-xs"
                          >
                            {t(
                              `settings.downloads.speedLimit.weekdays.${day}.short`
                            )}
                          </Toggle>
                        ))}
                      </div>
                      <FormDescription className="text-xs text-muted-foreground">
                        {t('settings.downloads.speedLimit.scheduleDaysHint')}
                      </FormDescription>
                      <FormMessage className="basis-full text-xs" />
                    </FormItem>
                  )
                }}
              />
            </>
          )}

          <Separator className="my-2" />

          <h5 className="text-xs font-medium text-foreground">
            {t('settings.downloads.speedLimit.autoAdaptive')}
          </h5>

          <FormField
            control={form.control}
            name="speedLimit.auto.adaptive.enabled"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="min-w-0 space-y-1">
                  <FormLabel>
                    {t('settings.downloads.speedLimit.adaptiveEnabled')}
                  </FormLabel>
                  <FormDescription className="text-xs">
                    {t('settings.downloads.speedLimit.adaptiveEnabledDesc')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value as boolean}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </SettingsFormRow>
            )}
          />

          {(adaptiveEnabled ||
            form.formState.errors.speedLimit?.auto?.adaptive) && (
            <>
              {mbpsLimitRow(
                'speedLimit.auto.adaptive.linkDown',
                'settings.downloads.speedLimit.linkDown',
                'settings.downloads.speedLimit.linkDownDesc'
              )}
              {mbpsLimitRow(
                'speedLimit.auto.adaptive.linkUp',
                'settings.downloads.speedLimit.linkUp',
                'settings.downloads.speedLimit.linkUpDesc'
              )}

              <div className="flex items-center gap-2 pl-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fillFromPeak()}
                >
                  {t('settings.downloads.speedLimit.fillFromPeak')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('settings.downloads.speedLimit.fillFromPeakHint')}
                </span>
              </div>

              <FormField
                control={form.control}
                name="speedLimit.auto.adaptive.headroomPercent"
                render={({ field }) => {
                  const motrixPercent = field.value as number
                  const reservedPercent = 100 - motrixPercent
                  return (
                    <FormItem className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <FormLabel>
                          {t('settings.downloads.speedLimit.headroomPercent')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t(
                            'settings.downloads.speedLimit.headroomPercentDesc',
                            {
                              reserved: reservedPercent,
                              motrix: motrixPercent,
                            }
                          )}
                        </FormDescription>
                        <FormMessage className="text-xs" />
                      </div>
                      <div className="relative shrink-0">
                        <FormControl>
                          <Input
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            type="number"
                            min={0}
                            max={99}
                            className="h-8 w-32 pr-8"
                            value={
                              Number.isFinite(reservedPercent)
                                ? reservedPercent
                                : ''
                            }
                            onChange={(event) => {
                              field.onChange(100 - event.target.valueAsNumber)
                            }}
                          />
                        </FormControl>
                        <span
                          className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground"
                          aria-hidden
                        >
                          %
                        </span>
                      </div>
                    </FormItem>
                  )
                }}
              />
            </>
          )}
        </>
      )}

      <div
        className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2.5"
        aria-live="polite"
        aria-atomic="true"
      >
        <p className="text-xs font-medium text-foreground">
          {t('settings.downloads.speedLimit.effect.title')}
        </p>
        <p className="text-xs text-muted-foreground">{summary.primary}</p>
        {summary.secondary ? (
          <p className="text-[11px] text-muted-foreground/80">
            {summary.secondary}
          </p>
        ) : null}
      </div>
    </>
  )
}
