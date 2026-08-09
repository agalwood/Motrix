// src/renderer/routes/dashboard/tiles/speed-tile.tsx
import { type ChartConfig, ChartContainer } from '@renderer/components/ui/chart'
import {
  chartCeiling,
  formatSpeed,
  normalizeSpeedHistory,
} from '@renderer/lib/speed-chart'
import { cn } from '@renderer/lib/utils'
import type { SpeedPoint } from '@shared/types/stats'
import { useTranslation } from 'react-i18next'
import { Area, AreaChart, YAxis } from 'recharts'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

export interface SpeedTileProps {
  kind: 'up' | 'down'
  history: readonly SpeedPoint[]
  viewport: DashboardTileViewport
  className?: string
}

const CHART_CONFIG: ChartConfig = {
  up: { label: 'Up', color: 'hsl(var(--chart-2))' },
  down: { label: 'Down', color: 'hsl(var(--chart-1))' },
}

export function SpeedTile({
  kind,
  history,
  viewport,
  className,
}: SpeedTileProps) {
  const { t } = useTranslation()
  const dataKey = kind
  const current = history.at(-1)?.[dataKey] ?? 0
  const peak = history.reduce((m, p) => Math.max(m, p[dataKey]), 0)
  const compact = viewport.contentLevel === 'compact'
  const showPeak =
    viewport.contentLevel === 'detailed' || viewport.contentLevel === 'focus'
  const focus = viewport.contentLevel === 'focus'
  const chartData = normalizeSpeedHistory(history)
  const visibleMax = Math.max(peak, current)
  const chartMax = chartCeiling(visibleMax)
  const chartMin = -chartMax / 7
  const scaleMax = visibleMax > 0 ? chartMax : 0
  const scaleValues = focus
    ? [
        { key: 'maximum', value: scaleMax },
        { key: 'upper-middle', value: (scaleMax * 2) / 3 },
        { key: 'lower-middle', value: scaleMax / 3 },
      ]
    : [
        { key: 'maximum', value: scaleMax },
        { key: 'middle', value: scaleMax / 2 },
      ]

  return (
    <TileShell
      label={t(
        kind === 'up'
          ? 'panel.dashboard.speed.up'
          : 'panel.dashboard.speed.down'
      )}
      className={cn('relative pb-0', className)}
      bodyClassName="relative z-0"
    >
      <div className="relative z-10">
        <TileTitle value={formatSpeed(current)} />
      </div>

      {!compact && (
        <div
          data-testid="speed-scale"
          className={cn(
            'pointer-events-none absolute top-0 right-0 z-10 flex flex-col items-end justify-between text-right text-[11px] leading-none text-muted-foreground/45 tabular-nums',
            showPeak ? 'bottom-10' : 'bottom-4'
          )}
        >
          {scaleValues.map(({ key, value }) => (
            <span key={key}>{formatSpeed(value)}</span>
          ))}
        </div>
      )}
      {showPeak ? (
        <span className="pointer-events-none absolute right-0 bottom-3 z-10 text-[11px] leading-none text-muted-foreground/55 tabular-nums">
          {t('panel.dashboard.speed.peak', { value: formatSpeed(peak) })}
        </span>
      ) : null}
      <div
        data-testid="speed-chart"
        data-content-level={viewport.contentLevel}
        data-orientation={viewport.orientation}
        className={cn(
          'pointer-events-none absolute right-[-1rem] bottom-0 left-[-1rem] z-0 overflow-hidden',
          compact
            ? '-top-6'
            : viewport.orientation === 'square'
              ? 'top-8'
              : '-top-10'
        )}
      >
        <ChartContainer
          config={CHART_CONFIG}
          className="aspect-auto h-full w-full"
          initialDimension={{ width: 240, height: 112 }}
        >
          <AreaChart
            data={chartData}
            margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
          >
            <YAxis dataKey={dataKey} domain={[chartMin, chartMax]} hide />
            <Area
              type="linear"
              dataKey={dataKey}
              stroke={`var(--color-${kind})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              baseValue={chartMin}
              fill={`var(--color-${kind})`}
              fillOpacity={0.12}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </TileShell>
  )
}
