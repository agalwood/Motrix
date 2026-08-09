import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import type {
  DashboardTileId,
  DashboardTileLayout,
  DashboardTileSpan,
} from '@shared/types/settings'
import {
  GripVertical,
  MoveDiagonal2,
  PanelTop,
  Square,
  StretchHorizontal,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import type {
  DashboardLayoutFailureReason,
  DashboardTileSizeOption,
} from '../layout/dashboard-layout'
import {
  type DashboardTilePresentationDefinition,
  type DashboardTileSpanKey,
  dashboardTileOrientation,
  dashboardTileSpanKey,
} from '../layout/dashboard-registry'

export interface DashboardTileFrameLabels {
  drag: string
  remove: string
  resize?: string
  sizeGroup: string
  size: (
    size: DashboardTileSpanKey,
    presentation: DashboardTilePresentationDefinition
  ) => string
  unavailable: (reason: DashboardLayoutFailureReason) => string
}

export interface DashboardTileFrameProps {
  tile: DashboardTileLayout
  sizeOptions: readonly DashboardTileSizeOption[]
  editing?: boolean
  dragging?: boolean
  labels: DashboardTileFrameLabels
  className?: string
  children: React.ReactNode
  onDragHandlePointerDown?: (
    id: DashboardTileId,
    event: React.PointerEvent<HTMLButtonElement>
  ) => void
  onResizeHandlePointerDown?: (
    id: DashboardTileId,
    event: React.PointerEvent<HTMLButtonElement>
  ) => void
  onResize?: (id: DashboardTileId, span: DashboardTileSpan) => void
  onRemove?: (id: DashboardTileId) => void
}

function ControlTooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function DashboardTileFrame({
  tile,
  sizeOptions,
  editing = false,
  dragging = false,
  labels,
  className,
  children,
  onDragHandlePointerDown,
  onResizeHandlePointerDown,
  onResize,
  onRemove,
}: DashboardTileFrameProps) {
  const currentSize = dashboardTileSpanKey(tile)
  const gridStyle = {
    '--dashboard-grid-column': `${tile.x + 1} / span ${tile.w}`,
    '--dashboard-grid-row': `${tile.y + 1} / span ${tile.h}`,
  } as React.CSSProperties

  return (
    <section
      data-testid={`dashboard-tile-${tile.id}`}
      data-dashboard-tile-id={tile.id}
      data-enabled={tile.enabled}
      style={gridStyle}
      className={cn(
        '@container/tile group/tile relative min-h-0 min-w-0 @[560px]:col-(--dashboard-grid-column) @[560px]:row-(--dashboard-grid-row)',
        'transition-[filter,opacity,transform] duration-150 ease-out',
        editing && 'rounded-(--dashboard-tile-radius)',
        dragging && 'z-30 scale-[1.015] opacity-95 drop-shadow-xl',
        className
      )}
    >
      <div
        data-dashboard-tile-body
        inert={editing ? true : undefined}
        className={cn(
          'contents',
          editing && '[&>*]:pointer-events-none [&>*]:select-none'
        )}
      >
        {children}
      </div>
      {editing ? (
        <>
          <div
            className={cn(
              'pointer-events-none absolute inset-0 rounded-[inherit] border border-dashed border-primary/35',
              'transition-colors'
            )}
            aria-hidden
          />
          <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur">
            <ControlTooltip label={labels.drag}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={labels.drag}
                className="cursor-grab"
                onPointerDown={(event) =>
                  onDragHandlePointerDown?.(tile.id, event)
                }
              >
                <GripVertical aria-hidden />
              </Button>
            </ControlTooltip>
            <ControlTooltip label={labels.remove}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={labels.remove}
                onClick={() => onRemove?.(tile.id)}
              >
                <Trash2 aria-hidden />
              </Button>
            </ControlTooltip>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={labels.sizeGroup}
                    title={labels.sizeGroup}
                  />
                }
              >
                <SizeIcon span={tile} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuRadioGroup
                  value={currentSize}
                  onValueChange={(value) => {
                    const option = sizeOptions.find(
                      ({ presentation }) =>
                        dashboardTileSpanKey(presentation.span) === value
                    )
                    if (option?.available) {
                      onResize?.(tile.id, option.presentation.span)
                    }
                  }}
                >
                  {sizeOptions.map(
                    ({ presentation, available, failureReason }) => {
                      const size = dashboardTileSpanKey(presentation.span)
                      return (
                        <DropdownMenuRadioItem
                          key={size}
                          value={size}
                          disabled={!available}
                          aria-label={
                            !available && failureReason
                              ? `${labels.size(size, presentation)} ${labels.unavailable(failureReason)}`
                              : labels.size(size, presentation)
                          }
                          className="gap-2"
                        >
                          <SizeIcon span={presentation.span} />
                          <span>{labels.size(size, presentation)}</span>
                          {!available && failureReason ? (
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              {' · '}
                              {labels.unavailable(failureReason)}
                            </span>
                          ) : null}
                        </DropdownMenuRadioItem>
                      )
                    }
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={labels.resize ?? labels.sizeGroup}
            className="absolute right-0 bottom-0 z-20 size-5 touch-none cursor-nwse-resize rounded-tl-md rounded-tr-none rounded-br-[inherit] rounded-bl-none border border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent/90 hover:text-foreground dark:bg-background/80"
            onPointerDown={(event) =>
              onResizeHandlePointerDown?.(tile.id, event)
            }
          >
            <MoveDiagonal2 aria-hidden className="size-3" />
          </Button>
        </>
      ) : null}
    </section>
  )
}

function SizeIcon({ span }: { span: DashboardTileSpan }) {
  switch (dashboardTileOrientation(span)) {
    case 'wide':
      return <StretchHorizontal aria-hidden />
    case 'tall':
      return <PanelTop aria-hidden className="rotate-90" />
    case 'square':
      return span.w === 1 ? (
        <Square aria-hidden />
      ) : (
        <PanelTop aria-hidden className="rotate-180" />
      )
  }
}
