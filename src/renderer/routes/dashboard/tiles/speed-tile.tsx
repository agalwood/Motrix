// src/renderer/routes/dashboard/tiles/speed-tile.tsx
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { chartCeiling, SPEED_CHART_MIN_POINTS } from '@renderer/lib/speed-chart'
import { cn } from '@renderer/lib/utils'
import type { SpeedPoint } from '@shared/types/stats'
import { useTranslation } from 'react-i18next'
import { SpeedSparkline } from '../components/speed-sparkline'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

export interface SpeedTileProps {
  kind: 'up' | 'down'
  history: readonly SpeedPoint[]
  viewport: DashboardTileViewport
  className?: string
}

export function SpeedTile({
  kind,
  history,
  viewport,
  className,
}: SpeedTileProps) {
  const { formatSpeed } = useByteFormat()

  const { t } = useTranslation()
  const dataKey = kind
  const current = history.at(-1)?.[dataKey] ?? 0
  const peak = history.reduce((m, p) => Math.max(m, p[dataKey]), 0)
  const compact = viewport.contentLevel === 'compact'
  const showPeak =
    viewport.contentLevel === 'detailed' || viewport.contentLevel === 'focus'
  const focus = viewport.contentLevel === 'focus'
  // Keep the scale anchored to retained history while recent samples roll by.
  const visibleMax = Math.max(peak, current)
  const chartMax = chartCeiling(visibleMax)
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
            'pointer-events-none absolute top-0 right-0 z-10 flex flex-col items-end justify-between text-right text-[11px] leading-none text-muted-foreground/45',
            showPeak ? 'bottom-10' : 'bottom-4'
          )}
        >
          {scaleValues.map(({ key, value }) => (
            <span key={key}>{formatSpeed(value)}</span>
          ))}
        </div>
      )}
      {showPeak ? (
        <span className="pointer-events-none absolute right-0 bottom-3 z-10 text-[11px] leading-none text-muted-foreground/55">
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
        <SpeedSparkline
          history={history}
          kind={kind}
          ceiling={chartMax}
          pointCount={Math.max(SPEED_CHART_MIN_POINTS, viewport.span.w * 16)}
        />
      </div>
    </TileShell>
  )
}
