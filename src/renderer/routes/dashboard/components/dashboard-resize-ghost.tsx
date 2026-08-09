import { cn } from '@renderer/lib/utils'
import type { DashboardTileSpan } from '@shared/types/settings'
import type React from 'react'

export interface DashboardResizeGhostGeometry extends DashboardTileSpan {
  x: number
  y: number
}

export interface DashboardResizeGhostViewportRect {
  left: number
  top: number
  width: number
  height: number
}

export interface DashboardResizeGhostProps {
  geometry: DashboardResizeGhostGeometry
  viewportRect?: DashboardResizeGhostViewportRect
  valid: boolean
  sizeLabel: string
  failure?: string
  className?: string
}

export function DashboardResizeGhost({
  geometry,
  viewportRect,
  valid,
  sizeLabel,
  failure,
  className,
}: DashboardResizeGhostProps) {
  const gridStyle = {
    '--dashboard-grid-column': `${geometry.x + 1} / span ${geometry.w}`,
    '--dashboard-grid-row': `${geometry.y + 1} / span ${geometry.h}`,
    ...(viewportRect
      ? {
          left: viewportRect.left,
          top: viewportRect.top,
          width: viewportRect.width,
          height: viewportRect.height,
        }
      : {}),
  } as React.CSSProperties
  const accessibleLabel = failure ? `${sizeLabel}. ${failure}` : sizeLabel

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={accessibleLabel}
      data-testid="dashboard-resize-ghost"
      data-valid={valid}
      style={gridStyle}
      className={cn(
        'pointer-events-none z-40 hidden min-h-0 min-w-0 items-center justify-center rounded-[var(--dashboard-tile-radius)] border-2 border-dashed',
        viewportRect
          ? 'fixed @[560px]:flex'
          : 'absolute inset-0 @[560px]:flex @[560px]:[grid-column:var(--dashboard-grid-column)] @[560px]:[grid-row:var(--dashboard-grid-row)]',
        valid
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-destructive bg-destructive/10 text-destructive',
        className
      )}
    >
      <div className="flex max-w-[calc(100%_-_1rem)] flex-col items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-center text-[11px] leading-tight font-medium shadow-sm backdrop-blur">
        <span>{sizeLabel}</span>
        {failure ? <span className="text-[10px]">{failure}</span> : null}
      </div>
    </div>
  )
}
