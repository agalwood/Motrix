import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@renderer/components/ui/chart'
import { formatTime24Hour } from '@renderer/lib/format'
import { formatSpeed } from '@renderer/lib/speed-chart'
import { TileSegmentedControl } from '@renderer/routes/dashboard/components/tile-segmented-control'
import type {
  TaskInspectorActivitySnapshot,
  TaskTransferSample,
} from '@shared/types/task-inspector-activity'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  Rectangle,
  type RectangleProps,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  ActivityChartModel,
  ActivityChartRange,
} from './activity-chart-model'

export interface LifetimeTransferCardProps {
  model: ActivityChartModel
  range: ActivityChartRange
  sampleCount: number
  lifetimeSummary?: TaskInspectorActivitySnapshot['lifetime'] | null
  stale?: boolean
  coverageGap?: boolean
  truncatedCount?: number
  lifetimeAvailable?: boolean
  emptyMessage?: string | null
  summary?: ReactNode
  onRangeChange: (range: ActivityChartRange) => void
  onSelectMarker: (markerId: string) => void
}

function formatAxisSpeed(bytesPerSecond: number): string {
  return formatSpeed(bytesPerSecond).replace(' ', '\u00a0')
}

const TRANSFER_BAR_SIZE = 5
const TRANSFER_BAR_RADIUS = TRANSFER_BAR_SIZE / 2
const TRANSFER_BAR_EDGE_PADDING = TRANSFER_BAR_SIZE
const TRANSFER_POINT_PITCH = 16

interface TransferBarShapeProps extends BarShapeProps {
  kind: 'down' | 'up'
}

function TransferBarShape({
  height,
  kind,
  parentViewBox,
  payload,
  width,
  x,
  y,
  ...props
}: TransferBarShapeProps) {
  const point = payload as TaskTransferSample | undefined
  const otherValue = kind === 'down' ? point?.up : point?.down
  const radius: RectangleProps['radius'] =
    Number(otherValue) > 0
      ? kind === 'down'
        ? [0, 0, TRANSFER_BAR_RADIUS, TRANSFER_BAR_RADIUS]
        : [TRANSFER_BAR_RADIUS, TRANSFER_BAR_RADIUS, 0, 0]
      : TRANSFER_BAR_RADIUS

  const centeredX = x + (width - TRANSFER_BAR_SIZE) / 2
  const minX = Math.ceil(parentViewBox.x)
  const maxX = Math.floor(
    parentViewBox.x + parentViewBox.width - TRANSFER_BAR_SIZE
  )
  const visualX = Math.min(Math.max(Math.round(centeredX), minX), maxX)

  return (
    <Rectangle
      {...props}
      x={visualX}
      y={y}
      width={TRANSFER_BAR_SIZE}
      height={height}
      radius={radius}
    />
  )
}

export function LifetimeTransferCard({
  model,
  range,
  sampleCount,
  lifetimeSummary,
  stale = false,
  coverageGap = false,
  truncatedCount = 0,
  lifetimeAvailable = true,
  emptyMessage,
  summary,
  onRangeChange,
  onSelectMarker,
}: LifetimeTransferCardProps) {
  const { t, i18n } = useTranslation()
  const latest = model.points.at(-1)
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      down: {
        label: t('panel.downloads.inspector.activity.download'),
        color: 'hsl(var(--chart-1))',
      },
      up: {
        label: t('panel.downloads.inspector.activity.upload'),
        color: 'hsl(var(--chart-2))',
      },
    }),
    [t]
  )
  const rangeOptions = useMemo(
    () => [
      {
        value: 'session' as const,
        label: t('panel.downloads.inspector.activity.range.session'),
      },
      {
        value: 'lifetime' as const,
        label: t('panel.downloads.inspector.activity.range.lifetime'),
        disabled: !lifetimeAvailable,
      },
    ],
    [lifetimeAvailable, t]
  )
  const derivedEmptyMessage =
    emptyMessage ??
    (model.emptyState === 'all-zero'
      ? t('panel.downloads.inspector.activity.noTraffic')
      : model.emptyState === 'empty'
        ? range === 'lifetime'
          ? t('panel.downloads.inspector.activity.lifetimeEmpty')
          : t('panel.downloads.inspector.activity.collecting')
        : null)
  const domain = model.domain
    ? model.points.length > 1
      ? ([model.domain[0] - 500, model.domain[1] + 500] as const)
      : model.domain
    : ([0, 1] as const)
  const accessibilityState = [
    stale ? t('panel.downloads.inspector.activity.stale.short') : null,
    coverageGap ? t('panel.downloads.inspector.activity.coverageGap') : null,
    truncatedCount > 0
      ? t('panel.downloads.inspector.activity.timeline.truncated', {
          count: truncatedCount,
        })
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' ')
  const activeSeconds = Math.round((lifetimeSummary?.activeMs ?? 0) / 1_000)
  const activeDuration = t(
    'panel.downloads.inspector.activity.chart.activeSeconds',
    { count: activeSeconds }
  )
  const sampleLabel = t(
    'panel.downloads.inspector.activity.chart.sampleCount',
    { count: sampleCount }
  )
  const alternative = t(
    'panel.downloads.inspector.activity.chart.accessibleSummary',
    {
      range: t(`panel.downloads.inspector.activity.range.${range}` as const),
      start: model.domain
        ? formatTime24Hour(model.domain[0], i18n.language)
        : t('panel.downloads.inspector.activity.notAvailable'),
      end: model.domain
        ? formatTime24Hour(model.domain[1], i18n.language)
        : t('panel.downloads.inspector.activity.notAvailable'),
      download: formatSpeed(latest?.down ?? 0),
      upload: formatSpeed(latest?.up ?? 0),
      average: formatSpeed(lifetimeSummary?.averageDownloadSpeed ?? 0),
      peak: formatSpeed(lifetimeSummary?.peakDownloadSpeed ?? 0),
      activeDuration,
      sampleLabel,
      state:
        accessibilityState ||
        t('panel.downloads.inspector.activity.chart.noDataQualityIssues'),
    }
  )

  const surface = (
    <section
      data-testid="task-inspector-activity-transfer-surface"
      className="h-full min-w-0 rounded-md border border-border p-3"
    >
      <div className="flex flex-col gap-2 @[420px]/transfer:flex-row @[420px]/transfer:items-center @[420px]/transfer:justify-between">
        <h4 className="text-xs font-semibold text-foreground">
          {t(
            `panel.downloads.inspector.activity.transferTitle.${range}` as const
          )}
        </h4>
        <TileSegmentedControl
          ariaLabel={t('panel.downloads.inspector.activity.range.label')}
          value={range}
          options={rangeOptions}
          onValueChange={onRangeChange}
        />
      </div>

      {summary}

      <div className="mt-3 flex flex-col gap-2 text-[11px] text-muted-foreground @[420px]/transfer:flex-row @[420px]/transfer:items-center @[420px]/transfer:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-[2px] bg-chart-1"
            />
            {t('panel.downloads.inspector.activity.download')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-[2px] bg-chart-2"
            />
            {t('panel.downloads.inspector.activity.upload')}
          </span>
        </div>
        <span className="tabular-nums">
          {range === 'lifetime'
            ? t('panel.downloads.inspector.activity.range.adaptive', {
                count: sampleCount,
              })
            : t('panel.downloads.inspector.activity.range.latest')}
        </span>
      </div>

      {coverageGap && (
        <p
          data-testid="task-inspector-activity-coverage-gap"
          className="mt-2 text-[11px] text-amber-700 dark:text-amber-300"
        >
          {t('panel.downloads.inspector.activity.coverageGap')}
        </p>
      )}

      <div
        data-testid="activity-transfer-chart-frame"
        className="relative -mx-3 mt-2"
      >
        <div
          data-testid="activity-transfer-chart-scroller"
          className="overflow-x-auto overflow-y-hidden overscroll-x-contain"
        >
          <div
            data-testid="activity-transfer-chart-canvas"
            className="relative h-48 min-w-full"
            style={{ minWidth: model.points.length * TRANSFER_POINT_PITCH }}
          >
            <ChartContainer
              config={chartConfig}
              className="aspect-auto h-full w-full"
              initialDimension={{ width: 520, height: 192 }}
              role="img"
              aria-label={alternative}
            >
              <BarChart
                data={model.points}
                margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  vertical={false}
                  syncWithTicks
                  stroke="var(--muted-foreground)"
                  strokeDasharray="3 5"
                  strokeOpacity={0.3}
                />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={domain}
                  allowDataOverflow
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                  padding={{
                    left: TRANSFER_BAR_EDGE_PADDING,
                    right: TRANSFER_BAR_EDGE_PADDING,
                  }}
                  tickFormatter={(value) =>
                    formatTime24Hour(Number(value), i18n.language)
                  }
                />
                <YAxis
                  className="text-[10px] tabular-nums"
                  domain={[0, model.axisCeiling]}
                  mirror
                  orientation="right"
                  width={1}
                  tick={() => null}
                  tickLine={false}
                  ticks={[model.axisCeiling / 2, model.axisCeiling]}
                  axisLine={false}
                />
                {model.pauseBands.map((band) => (
                  <ReferenceArea
                    key={`${band.startAt}-${band.endAt}`}
                    x1={band.startAt}
                    x2={band.endAt}
                    fill="hsl(var(--chart-3))"
                    fillOpacity={0.07}
                    strokeOpacity={0}
                  />
                ))}
                {model.markers.map((marker) => (
                  <ReferenceLine
                    key={marker.id}
                    className={
                      marker.selected
                        ? 'activity-chart-marker-selected'
                        : 'activity-chart-marker'
                    }
                    x={marker.occurredAt}
                    stroke={
                      marker.selected
                        ? 'hsl(var(--primary))'
                        : 'hsl(var(--muted-foreground))'
                    }
                    strokeDasharray="3 3"
                    strokeOpacity={marker.selected ? 0.8 : 0.38}
                    onClick={() => onSelectMarker(marker.id)}
                  />
                ))}
                {model.points.length > 0 && (
                  <ChartTooltip
                    cursor={{
                      stroke: 'var(--border)',
                      strokeDasharray: '3 3',
                    }}
                    wrapperStyle={{ zIndex: 20 }}
                    content={
                      <ChartTooltipContent
                        className="min-w-40 bg-popover opacity-100"
                        labelFormatter={(_label, payload) => {
                          const point = payload[0]?.payload as
                            | { t?: number }
                            | undefined
                          return point?.t
                            ? formatTime24Hour(point.t, i18n.language)
                            : ''
                        }}
                        formatter={(value, name, item) => (
                          <div className="flex min-w-36 flex-1 items-center justify-between gap-3">
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              <span
                                aria-hidden="true"
                                className="size-2 rounded-[2px]"
                                style={{ backgroundColor: item.color }}
                              />
                              {chartConfig[String(name)]?.label ?? String(name)}
                            </span>
                            <span className="font-mono font-medium text-foreground tabular-nums">
                              {formatSpeed(Number(value))}
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                )}
                <Bar
                  className="activity-transfer-bar activity-transfer-bar-down"
                  dataKey="down"
                  stackId="transfer"
                  barSize={TRANSFER_BAR_SIZE}
                  fill="var(--color-down)"
                  minPointSize={(value, index) =>
                    value === 0 && model.points[index]?.up === 0
                      ? TRANSFER_BAR_SIZE
                      : 0
                  }
                  shape={(props) => <TransferBarShape {...props} kind="down" />}
                  isAnimationActive={false}
                />
                <Bar
                  className="activity-transfer-bar activity-transfer-bar-up"
                  dataKey="up"
                  stackId="transfer"
                  barSize={TRANSFER_BAR_SIZE}
                  fill="var(--color-up)"
                  shape={(props) => <TransferBarShape {...props} kind="up" />}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
            {derivedEmptyMessage && (
              <p className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 text-center text-[11px] text-muted-foreground">
                {derivedEmptyMessage}
              </p>
            )}
          </div>
        </div>
        <div
          data-testid="activity-transfer-speed-scale"
          className="pointer-events-none absolute top-2 right-3 bottom-8 z-10 text-right text-[10px] leading-none text-muted-foreground/45 tabular-nums"
        >
          <span className="absolute top-0 right-0 translate-y-1">
            {formatAxisSpeed(model.axisCeiling)}
          </span>
          <span className="absolute top-1/2 right-0 translate-y-1">
            {formatAxisSpeed(model.axisCeiling / 2)}
          </span>
        </div>
      </div>
    </section>
  )

  return (
    <div
      data-testid="task-inspector-activity-transfer-card"
      className="@container/transfer h-full min-w-0"
    >
      {surface}
    </div>
  )
}
