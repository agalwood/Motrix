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

function SectionIntro({ title }: { title: string }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
    </div>
  )
}

export function SpeedLimitSection({
  form,
}: {
  form: UseFormReturn<DownloadsFields>
}) {
  const { unitSystem } = useByteFormat()
  const kiloByte = unitSystem === 'binary' ? 1024 : 1000

  const { t } = useTranslation()
  const settings = form.watch('speedLimit')
  const turtle = settings.turtle
  const scheduleEnabled = settings.auto.schedule.enabled
  const adaptiveEnabled = settings.auto.adaptive.enabled

  const kbLimitRow = (
    name: KbLimitName,
    labelKey: string,
    zeroAction: 'unlimited' | 'inherit'
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <FormLabel>
              {t(labelKey)}
              <span className="sr-only">
                {' '}
                —{' '}
                {t(
                  name.includes('.base.')
                    ? 'settings.downloads.speedLimit.baseSection'
                    : 'settings.downloads.speedLimit.altSection'
                )}
              </span>
            </FormLabel>
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

  const mbpsLimitRow = (name: MbpsLimitName, labelKey: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <FormLabel>{t(labelKey)}</FormLabel>
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
      </div>

      <FormField
        control={form.control}
        name="speedLimit.turtle"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="min-w-0 space-y-1">
              <FormLabel>{t('settings.downloads.speedLimit.turtle')}</FormLabel>
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

      <SectionIntro title={t('settings.downloads.speedLimit.baseSection')} />
      {kbLimitRow(
        'speedLimit.base.upload',
        'settings.downloads.speedLimit.baseUpload',
        'unlimited'
      )}
      {kbLimitRow(
        'speedLimit.base.download',
        'settings.downloads.speedLimit.baseDownload',
        'unlimited'
      )}

      <Separator className="my-2" />

      <SectionIntro title={t('settings.downloads.speedLimit.altSection')} />
      {kbLimitRow(
        'speedLimit.alt.upload',
        'settings.downloads.speedLimit.altUpload',
        'inherit'
      )}
      {kbLimitRow(
        'speedLimit.alt.download',
        'settings.downloads.speedLimit.altDownload',
        'inherit'
      )}

      {(turtle === 'auto' || form.formState.errors.speedLimit?.auto) && (
        <>
          <Separator className="my-2" />

          <SectionIntro
            title={t('settings.downloads.speedLimit.autoSection')}
          />

          <FormField
            control={form.control}
            name="speedLimit.auto.schedule.enabled"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="min-w-0 space-y-1">
                  <FormLabel>
                    {t('settings.downloads.speedLimit.scheduleEnabled')}
                  </FormLabel>
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
                      <FormDescription className="text-xs">
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
                'speedLimit.auto.adaptive.linkUp',
                'settings.downloads.speedLimit.linkUp'
              )}
              {mbpsLimitRow(
                'speedLimit.auto.adaptive.linkDown',
                'settings.downloads.speedLimit.linkDown'
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
                            settings.auto.adaptive.linkDown > 0 &&
                              settings.auto.adaptive.linkUp > 0
                              ? 'settings.downloads.speedLimit.bandwidthUsed'
                              : 'settings.downloads.speedLimit.bandwidthPending',
                            { motrix: motrixPercent }
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

      <p className="text-xs text-muted-foreground">
        {t('settings.downloads.speedLimit.effect.lowerWins')}
      </p>
    </>
  )
}
