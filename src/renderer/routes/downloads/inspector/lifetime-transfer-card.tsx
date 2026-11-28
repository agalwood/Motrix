import { ChevronLeftIcon, ChevronRightIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@renderer/components/ui/chart'
import { DirectionProvider } from '@renderer/components/ui/direction'
import { Slider } from '@renderer/components/ui/slider'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { formatTime24Hour } from '@renderer/lib/format'
import { TileSegmentedControl } from '@renderer/routes/dashboard/components/tile-segmented-control'
import type { TaskInspectorActivitySnapshot } from '@shared/types/task-inspector-activity'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Area,
  AreaChart,
  CartesianGrid,
  matchByDataKey,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  ActivityChartModel,
  ActivityChartPoint,
  ActivityChartRange,
} from './activity-chart-model'
import { useActivityChartMotion } from './use-activity-chart-motion'
import {
  MIN_ACTIVITY_WINDOW_MS,
  useActivityChartViewport,
} from './use-activity-chart-viewport'

const KEY = 'panel.downloads.inspector.activity'
const MATCH_SAMPLE_TIME = matchByDataKey('t')
const CHART_CONTROL_CLASS =
  'text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:text-foreground active:scale-95 motion-reduce:active:scale-100'

export interface LifetimeTransferCardProps {
  model: ActivityChartModel
  range: ActivityChartRange
  sampleCount: number
  lifetimeSummary?: TaskInspectorActivitySnapshot['lifetime'] | null
  stale?: boolean
  truncatedCount?: number
  lifetimeAvailable?: boolean
  live?: boolean
  emptyMessage?: string | null
  summary?: ReactNode
  onRangeChange: (range: ActivityChartRange) => void
  onSelectMarker: (markerId: string) => void
}

export function LifetimeTransferCard({
  model,
  range,
  sampleCount,
  lifetimeSummary,
  stale = false,
  truncatedCount = 0,
  lifetimeAvailable = true,
  live = true,
  emptyMessage,
  summary,
  onRangeChange,
  onSelectMarker,
}: LifetimeTransferCardProps) {
  const { formatSpeed } = useByteFormat()
  const { t, i18n } = useTranslation()
  // Browsing or zooming also makes the current range an explicit user choice.
  const viewport = useActivityChartViewport(model.domain, range, () =>
    onRangeChange(range)
  )
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const frameRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    id: number
    x: number
    startX: number
    startY: number
    captured: boolean
  } | null>(null)
  const latest = model.points.findLast((point) => point.state !== 'missing')
  const motion = useActivityChartMotion(
    latest?.t,
    range,
    live && viewport.following
  )
  const [start, end] = viewport.window
  const span = end - start
  const detailsIncludeDate =
    new Date(viewport.bounds[0]).toDateString() !==
    new Date(viewport.bounds[1]).toDateString()
  const axisIncludesDate =
    new Date(start).toDateString() !== new Date(end).toDateString()
  const axisIncludesYear =
    new Date(start).getFullYear() !== new Date(end).getFullYear()
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    [i18n.language]
  )
  const dateTickFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: axisIncludesYear ? 'numeric' : undefined,
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    [axisIncludesYear, i18n.language]
  )
  const formatChartTime = (timestamp: number, axis = false) =>
    (axis ? axisIncludesDate : detailsIncludeDate)
      ? (axis ? dateTickFormatter : dateTimeFormatter).format(timestamp)
      : formatTime24Hour(timestamp, i18n.language)
  const tickCount = Math.min(4, Math.floor(span / 1000) + 1)
  const visiblePauses = model.pauseBands.filter(
    (band) => band.endAt > start && band.startAt < end
  )
  const visibleGaps = model.gapBands.filter(
    (band) => band.endAt > start && band.startAt < end
  )
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      down: { label: t(`${KEY}.download`), color: 'hsl(var(--chart-1))' },
      up: { label: t(`${KEY}.upload`), color: 'hsl(var(--chart-2))' },
    }),
    [t]
  )
  const rangeOptions = useMemo(
    () => [
      { value: 'session' as const, label: t(`${KEY}.range.session`) },
      {
        value: 'lifetime' as const,
        label: t(`${KEY}.range.lifetime`),
        disabled: !lifetimeAvailable,
      },
    ],
    [lifetimeAvailable, t]
  )

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const onWheel = (event: WheelEvent) => {
      const delta =
        event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
      if (
        !delta ||
        (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX))
      )
        return
      const view = viewportRef.current
      if (view.window[1] - view.window[0] >= view.bounds[1] - view.bounds[0])
        return
      event.preventDefault()
      const pixels =
        delta *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? frame.clientWidth
            : 1)
      view.pan(
        (pixels / Math.max(1, frame.clientWidth)) *
          (view.window[1] - view.window[0])
      )
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => frame.removeEventListener('wheel', onWheel)
  }, [])

  const derivedEmptyMessage =
    emptyMessage ??
    (model.emptyState === 'all-zero'
      ? t(`${KEY}.noTraffic`)
      : model.emptyState === 'empty'
        ? t(range === 'lifetime' ? `${KEY}.lifetimeEmpty` : `${KEY}.collecting`)
        : null)
  const accessibilityState = [
    stale ? t(`${KEY}.stale.short`) : null,
    visibleGaps.length > 0 ? t(`${KEY}.chart.noSamples`) : null,
    truncatedCount > 0
      ? t(`${KEY}.timeline.truncated`, { count: truncatedCount })
      : null,
  ]
    .filter(Boolean)
    .join(' ')
  const alternative = t(`${KEY}.chart.accessibleSummary`, {
    range: t(`${KEY}.range.${range}`),
    start: formatChartTime(start),
    end: formatChartTime(end),
    download: formatSpeed(latest?.down ?? 0),
    upload: formatSpeed(latest?.up ?? 0),
    average: formatSpeed(lifetimeSummary?.averageDownloadSpeed ?? 0),
    peak: formatSpeed(lifetimeSummary?.peakDownloadSpeed ?? 0),
    activeDuration: t(`${KEY}.chart.activeSeconds`, {
      count: Math.round((lifetimeSummary?.activeMs ?? 0) / 1000),
    }),
    sampleLabel: t(`${KEY}.chart.sampleCount`, { count: sampleCount }),
    state: accessibilityState || t(`${KEY}.chart.noDataQualityIssues`),
  })
  const series = (overview = false) =>
    (['down', 'up'] as const).map((kind) => (
      <Area
        // A new range must not reuse the previous scale on the next live tick.
        key={`${range}-${kind}`}
        className={`activity-transfer-line-${kind}`}
        dataKey={kind}
        type="monotoneX"
        stroke={`var(--color-${kind})`}
        fill={`var(--color-${kind})`}
        fillOpacity={0.12}
        strokeWidth={overview ? 1 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={kind === 'up' ? '5 3' : undefined}
        connectNulls={false}
        dot={
          !overview && model.observationCount === 1
            ? { r: 2, strokeWidth: 0 }
            : false
        }
        activeDot={overview ? false : { r: 3 }}
        isAnimationActive={!overview && motion.active}
        animationDuration={motion.duration}
        animationEasing="linear"
        animationMatchBy={MATCH_SAMPLE_TIME}
        animationInterpolateFn={motion.interpolate}
      />
    ))

  return (
    <div
      data-testid="task-inspector-activity-transfer-card"
      className="@container/transfer h-full min-w-0"
    >
      <section
        data-testid="task-inspector-activity-transfer-surface"
        className="h-full min-w-0 rounded-lg border border-border/70 p-3"
      >
        <div className="flex flex-col gap-2 @[420px]/transfer:flex-row @[420px]/transfer:items-center @[420px]/transfer:justify-between">
          <h4 className="text-xs font-medium tracking-[0.01em] text-foreground">
            {t(`${KEY}.transferTitle.${range}`)}
          </h4>
          <TileSegmentedControl
            ariaLabel={t(`${KEY}.range.label`)}
            value={range}
            options={rangeOptions}
            onValueChange={onRangeChange}
          />
        </div>
        {summary}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 rounded-full bg-chart-1"
              />
              {t(`${KEY}.download`)}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="w-4 border-t-2 border-dashed border-chart-2"
              />
              {t(`${KEY}.upload`)}
            </span>
            {visiblePauses.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-sm bg-muted-foreground/20"
                />
                {t(`${KEY}.timeline.status.paused`)}
              </span>
            )}
            {visibleGaps.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-3 rounded-sm border border-dashed border-muted-foreground/50"
                />
                {t(`${KEY}.chart.noSamples`)}
              </span>
            )}
          </div>
          <span className="tabular-nums">
            {range === 'lifetime'
              ? t(`${KEY}.range.adaptive`, { count: sampleCount })
              : t(`${KEY}.range.latest`)}
          </span>
        </div>
        <DirectionProvider direction="ltr">
          <div
            dir="ltr"
            data-testid="activity-transfer-chart-frame"
            className="relative -mx-3 mt-3"
          >
            <div
              ref={frameRef}
              data-testid="activity-transfer-chart-viewport"
              data-start={start}
              data-end={end}
              data-following={viewport.following}
              data-animating={motion.active}
              data-pannable={span < viewport.bounds[1] - viewport.bounds[0]}
              className="relative h-48 w-full touch-pan-y select-none outline-none focus-visible:ring-2 focus-visible:ring-ring data-[pannable=true]:cursor-grab data-[pannable=true]:active:cursor-grabbing"
              role="slider"
              aria-label={t(`${KEY}.range.label`)}
              aria-description={alternative}
              aria-orientation="horizontal"
              aria-valuemin={viewport.bounds[0]}
              aria-valuemax={Math.max(
                viewport.bounds[0],
                viewport.bounds[1] - span
              )}
              aria-valuenow={start}
              aria-valuetext={`${formatChartTime(start)}–${formatChartTime(end)}`}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  viewport.pan(
                    span * (event.key === 'ArrowLeft' ? -0.25 : 0.25)
                  )
                }
                if (event.key === 'End') {
                  event.preventDefault()
                  viewport.followLatest()
                }
                if (event.key === 'Home') {
                  event.preventDefault()
                  viewport.select([
                    viewport.bounds[0],
                    viewport.bounds[0] + span,
                  ])
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || dragRef.current) return
                dragRef.current = {
                  id: event.pointerId,
                  x: event.clientX,
                  startX: event.clientX,
                  startY: event.clientY,
                  captured: false,
                }
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current
                if (!drag || drag.id !== event.pointerId) return
                if (!drag.captured) {
                  const distance = Math.abs(event.clientX - drag.startX)
                  if (
                    distance < 4 ||
                    distance <= Math.abs(event.clientY - drag.startY)
                  )
                    return
                  event.currentTarget.setPointerCapture(event.pointerId)
                  drag.captured = true
                }
                const delta = event.clientX - drag.x
                viewport.pan(
                  (-delta / Math.max(1, event.currentTarget.clientWidth)) * span
                )
                drag.x = event.clientX
              }}
              onPointerUp={() => {
                dragRef.current = null
              }}
              onPointerCancel={() => {
                dragRef.current = null
              }}
              onLostPointerCapture={() => {
                dragRef.current = null
              }}
              onPointerLeave={() => {
                if (!dragRef.current?.captured) dragRef.current = null
              }}
            >
              <ChartContainer
                config={chartConfig}
                className="aspect-auto h-full w-full"
                initialDimension={{ width: 520, height: 192 }}
                role="img"
                aria-label={alternative}
              >
                <AreaChart
                  data={model.points}
                  accessibilityLayer={false}
                  role="presentation"
                  margin={{ top: 12, right: 8, bottom: 0, left: 8 }}
                >
                  <CartesianGrid
                    vertical={false}
                    syncWithTicks
                    stroke="var(--muted-foreground)"
                    strokeDasharray="2 6"
                    strokeOpacity={0.14}
                  />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={[start, end]}
                    allowDataOverflow
                    tickLine={false}
                    axisLine={false}
                    tick={{
                      fontSize: 10,
                      style: { fontVariantNumeric: 'tabular-nums' },
                    }}
                    tickMargin={10}
                    minTickGap={32}
                    ticks={Array.from(
                      { length: tickCount },
                      (_, index) => start + (span * index) / (tickCount - 1)
                    )}
                    interval="preserveStartEnd"
                    tickFormatter={(value) =>
                      formatChartTime(Number(value), true)
                    }
                  />
                  <YAxis
                    mirror
                    orientation="right"
                    width={1}
                    domain={[0, model.axisCeiling]}
                    ticks={[model.axisCeiling / 2, model.axisCeiling]}
                    tick={() => null}
                    tickLine={false}
                    axisLine={false}
                  />
                  {model.pauseBands
                    .filter((band) => band.endAt > start && band.startAt < end)
                    .map((band) => (
                      <ReferenceArea
                        key={`pause-${band.startAt}`}
                        className="activity-chart-pause"
                        x1={Math.max(start, band.startAt)}
                        x2={Math.min(end, band.endAt)}
                        fill="var(--muted-foreground)"
                        fillOpacity={0.12}
                        strokeOpacity={0}
                      />
                    ))}
                  {model.gapBands
                    .filter((band) => band.endAt > start && band.startAt < end)
                    .map((band) => (
                      <ReferenceArea
                        key={`gap-${band.startAt}`}
                        className="activity-chart-gap"
                        x1={Math.max(start, band.startAt)}
                        x2={Math.min(end, band.endAt)}
                        fillOpacity={0}
                        stroke="var(--muted-foreground)"
                        strokeOpacity={0.3}
                        strokeDasharray="3 4"
                      />
                    ))}
                  {model.markers
                    .filter(
                      (marker) =>
                        marker.occurredAt >= start && marker.occurredAt <= end
                    )
                    .map((marker) => (
                      <ReferenceLine
                        key={marker.id}
                        className={
                          marker.selected
                            ? 'activity-chart-marker-selected'
                            : 'activity-chart-marker'
                        }
                        x={marker.occurredAt}
                        stroke="var(--muted-foreground)"
                        strokeDasharray="3 3"
                        strokeOpacity={marker.selected ? 0.8 : 0.25}
                        onClick={() => onSelectMarker(marker.id)}
                      />
                    ))}
                  {model.points.length > 0 && (
                    <ChartTooltip
                      filterNull={false}
                      cursor={{
                        stroke: 'var(--border)',
                        strokeDasharray: '3 3',
                      }}
                      wrapperStyle={{ zIndex: 20 }}
                      content={
                        <ChartTooltipContent
                          className="min-w-40 rounded-lg border-border/60 bg-popover px-3 py-2.5 opacity-100 shadow-lg"
                          labelFormatter={(_label, payload) => {
                            const point = payload[0]?.payload as
                              | ActivityChartPoint
                              | undefined
                            if (!point) return ''
                            return `${formatChartTime(point.t)}${point.state === 'paused' ? ` · ${t(`${KEY}.timeline.status.paused`)}` : ''}`
                          }}
                          formatter={(value, name, item) => (
                            <div className="flex min-w-36 flex-1 items-center justify-between gap-3">
                              <span className="flex items-center gap-1.5 text-muted-foreground">
                                <span
                                  aria-hidden="true"
                                  className="size-2 rounded-full"
                                  style={{ backgroundColor: item.color }}
                                />
                                {chartConfig[String(name)]?.label ??
                                  String(name)}
                              </span>
                              <span className="font-medium text-foreground tabular-nums">
                                {value == null
                                  ? t(`${KEY}.chart.noSamples`)
                                  : formatSpeed(Number(value))}
                              </span>
                            </div>
                          )}
                        />
                      }
                    />
                  )}
                  {series()}
                </AreaChart>
              </ChartContainer>
              {derivedEmptyMessage && (
                <p className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 text-center text-[11px] text-muted-foreground">
                  {derivedEmptyMessage}
                </p>
              )}
            </div>
            <div
              data-testid="activity-transfer-speed-scale"
              className="pointer-events-none absolute top-3 right-3 bottom-8 z-10 text-right text-[10px] font-medium leading-none text-muted-foreground/80 tabular-nums"
            >
              <span className="absolute top-0 right-0 translate-y-1 rounded-sm bg-background/80 px-1">
                {formatSpeed(model.axisCeiling).replace(' ', '\u00a0')}
              </span>
              <span className="absolute top-1/2 right-0 translate-y-1 rounded-sm bg-background/80 px-1">
                {formatSpeed(model.axisCeiling / 2).replace(' ', '\u00a0')}
              </span>
            </div>
          </div>
          {range === 'lifetime' && model.domain && (
            <div
              dir="ltr"
              data-testid="activity-chart-overview"
              className="mt-3 space-y-1.5"
            >
              <div className="text-[11px] font-medium tracking-[0.01em] text-muted-foreground">
                {t(`${KEY}.chart.overview`)}
              </div>
              <ChartContainer
                config={chartConfig}
                className="pointer-events-none h-12 w-full aspect-auto overflow-hidden rounded-md bg-muted/20"
                initialDimension={{ width: 520, height: 48 }}
                aria-hidden="true"
              >
                <AreaChart
                  data={model.points}
                  margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                  accessibilityLayer={false}
                  role="presentation"
                >
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[...viewport.bounds]}
                    hide
                    allowDataOverflow
                  />
                  <YAxis domain={[0, model.axisCeiling]} hide />
                  {series(true)}
                  <ReferenceArea
                    x1={start}
                    x2={end}
                    fill="var(--muted-foreground)"
                    fillOpacity={0.06}
                    stroke="var(--muted-foreground)"
                    strokeOpacity={0.35}
                  />
                </AreaChart>
              </ChartContainer>
              <Slider
                className="[&_[data-slot=slider-range]]:bg-foreground/20 [&_[data-slot=slider-thumb]]:border-foreground/20 [&_[data-slot=slider-track]]:bg-muted/70 dark:[&_[data-slot=slider-thumb]]:border-foreground/60 dark:[&_[data-slot=slider-thumb]]:bg-foreground"
                value={[start, end]}
                min={viewport.bounds[0]}
                max={viewport.bounds[1]}
                step={1000}
                largeStep={Math.max(
                  1000,
                  Math.round((viewport.bounds[1] - viewport.bounds[0]) / 20)
                )}
                minStepsBetweenValues={1}
                thumbCollisionBehavior="none"
                getAriaLabel={(index) =>
                  t(
                    index === 0
                      ? `${KEY}.chart.rangeStart`
                      : `${KEY}.chart.rangeEnd`
                  )
                }
                getAriaValueText={(_formatted, value) => formatChartTime(value)}
                onValueChange={(values) => {
                  if (Array.isArray(values) && values.length === 2)
                    viewport.select([values[0], values[1]])
                }}
              />
            </div>
          )}
        </DirectionProvider>
        {model.domain && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-0.5 rounded-md bg-muted/30 p-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                className={CHART_CONTROL_CLASS}
                aria-label={t(`${KEY}.chart.earlier`)}
                disabled={start <= viewport.bounds[0]}
                onClick={() => viewport.pan(-span / 2)}
              >
                <ChevronLeftIcon className="rtl:rotate-180" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={CHART_CONTROL_CLASS}
                aria-label={t(`${KEY}.chart.later`)}
                disabled={end >= viewport.bounds[1]}
                onClick={() => viewport.pan(span / 2)}
              >
                <ChevronRightIcon className="rtl:rotate-180" />
              </Button>
              {range === 'lifetime' && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={CHART_CONTROL_CLASS}
                    aria-label={t(`${KEY}.chart.zoomIn`)}
                    disabled={span <= MIN_ACTIVITY_WINDOW_MS}
                    onClick={() => viewport.zoom(0.5)}
                  >
                    +
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={CHART_CONTROL_CLASS}
                    aria-label={t(`${KEY}.chart.zoomOut`)}
                    disabled={span >= viewport.bounds[1] - viewport.bounds[0]}
                    onClick={() => viewport.zoom(2)}
                  >
                    −
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={CHART_CONTROL_CLASS}
                    onClick={viewport.showAll}
                  >
                    {t(`${KEY}.chart.showAll`)}
                  </Button>
                </>
              )}
            </div>
            {viewport.following ? (
              live && (
                <span
                  role="status"
                  className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/40 px-2.5 text-[11px] font-medium text-muted-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-chart-1"
                  />
                  {t(`${KEY}.chart.following`)}
                </span>
              )
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className={`${CHART_CONTROL_CLASS} rounded-full bg-muted/40 px-2.5 text-[11px]`}
                onClick={viewport.followLatest}
              >
                {t(`${KEY}.chart.followLatest`)}
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
