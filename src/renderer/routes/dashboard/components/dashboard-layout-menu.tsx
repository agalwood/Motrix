import { InfoIcon } from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROWS,
} from '@shared/schemas/dashboard-layout'
import type {
  DashboardTileLayout,
  DashboardTileSpan,
} from '@shared/types/settings'
import { useTranslation } from 'react-i18next'
import type { DashboardLayoutFailureReason } from '../layout/dashboard-layout'

export const DASHBOARD_LAYOUT_MENU_CLASS =
  'flex w-52 flex-col overflow-hidden rounded-xl border-border/70 p-1 shadow-lg'

export const DASHBOARD_LAYOUT_OPTION_CLASS =
  'group/layout-option min-h-10 gap-2 rounded-lg px-2 py-1 data-disabled:pointer-events-auto data-disabled:opacity-100 data-disabled:text-muted-foreground data-disabled:data-highlighted:bg-muted/40 data-disabled:data-highlighted:text-muted-foreground'

const PREVIEW_CELLS = Array.from(
  { length: DASHBOARD_COLUMNS * DASHBOARD_ROWS },
  (_, index) => ({
    x: (index % DASHBOARD_COLUMNS) * 14 + 1,
    y: Math.floor(index / DASHBOARD_COLUMNS) * 14 + 1,
  })
)

/** A miniature of the fixed canvas, with the chosen footprint drawn to scale. */
export function DashboardLayoutPreview({
  span,
  className,
}: {
  span: DashboardTileSpan
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 56 42"
      aria-hidden="true"
      className={cn('size-auto h-6 w-8 shrink-0', className)}
    >
      {PREVIEW_CELLS.map(({ x, y }) => (
        <rect
          key={`${x}:${y}`}
          x={x}
          y={y}
          width="11"
          height="11"
          rx="2.5"
          fill="currentColor"
          opacity="0.08"
        />
      ))}
      <rect
        x="1"
        y="1"
        width={span.w * 14 - 3}
        height={span.h * 14 - 3}
        rx="2.5"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeOpacity="0.65"
      />
    </svg>
  )
}

/** The preset's actual tile arrangement, sharing the size menu's canvas scale. */
export function DashboardPresetPreview({
  tiles,
}: {
  tiles: readonly DashboardTileLayout[]
}) {
  return (
    <svg
      viewBox="0 0 56 42"
      aria-hidden="true"
      className="size-auto h-6 w-8 shrink-0 text-foreground/80"
    >
      {tiles
        .filter((tile) => tile.enabled)
        .map((tile) => (
          <rect
            key={tile.id}
            x={tile.x * 14 + 1}
            y={tile.y * 14 + 1}
            width={tile.w * 14 - 3}
            height={tile.h * 14 - 3}
            rx="2.5"
            fill="currentColor"
            fillOpacity={tile.w * tile.h > 1 ? 0.24 : 0.12}
            stroke="currentColor"
            strokeOpacity="0.3"
          />
        ))}
    </svg>
  )
}

const HINT_KEYS = {
  'insufficient-space': 'panel.dashboard.configure.availabilityHints.space',
  'out-of-bounds': 'panel.dashboard.configure.availabilityHints.bounds',
  'unsupported-span': 'panel.dashboard.configure.availabilityHints.unsupported',
} as const

export function DashboardLayoutHint({
  id,
  reason,
}: {
  id: string
  reason: DashboardLayoutFailureReason
}) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 flex shrink-0 items-start gap-1.5 border-t border-border/60 px-2 pt-2 pb-1.5 text-muted-foreground">
      <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <p id={id} className="text-[11px] leading-4">
        {t(HINT_KEYS[reason])}
      </p>
    </div>
  )
}
