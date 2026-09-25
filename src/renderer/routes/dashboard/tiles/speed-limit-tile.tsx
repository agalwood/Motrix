import { useByteFormat } from '@renderer/hooks/use-byte-format'

// src/renderer/routes/dashboard/tiles/speed-limit-tile.tsx

import { SpeedControlIcon, UnlimitedIcon } from '@renderer/components/icons'
import { SPEED_LIMIT_MODES } from '@renderer/components/speed-limit-modes'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import type { SpeedLimitStateView } from '@renderer/hooks/use-speed-limit-state'
import { cn } from '@renderer/lib/utils'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { TileShell } from '../components/tile-shell'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

type TurtleState = SpeedLimitStateView['turtle']

const SPEED_MODE_IMAGES = {
  off: {
    src: new URL('../icons/speed-standard@1x.webp', import.meta.url).href,
    src2x: new URL('../icons/speed-standard@2x.webp', import.meta.url).href,
  },
  on: {
    src: new URL('../icons/speed-limited@1x.webp', import.meta.url).href,
    src2x: new URL('../icons/speed-limited@2x.webp', import.meta.url).href,
  },
  auto: {
    src: new URL('../icons/speed-auto@1x.webp', import.meta.url).href,
    src2x: new URL('../icons/speed-auto@2x.webp', import.meta.url).href,
  },
} satisfies Record<TurtleState, { src: string; src2x: string }>

export interface SpeedLimitTileProps {
  state: SpeedLimitStateView
  viewport: DashboardTileViewport
  onSelectTurtle: (turtle: TurtleState) => void
  className?: string
}

export function SpeedLimitTile({
  state,
  viewport,
  onSelectTurtle,
  className,
}: SpeedLimitTileProps) {
  const { formatSpeedLimit } = useByteFormat()

  function fmt(v: number): string | ReactElement {
    return v <= 0 ? <UnlimitedIcon className="size-4" /> : formatSpeedLimit(v)
  }
  const { t } = useTranslation()
  const compact = viewport.contentLevel === 'compact'
  const detailed =
    viewport.contentLevel === 'detailed' || viewport.contentLevel === 'focus'
  const tall = viewport.orientation === 'tall'

  return (
    <TileShell
      label={t('panel.dashboard.speedLimit.title')}
      className={className}
      action={
        <Button
          size="icon-xs"
          variant="ghost"
          className="cursor-default"
          render={
            <Link
              to="/settings/downloads"
              role="link"
              aria-label={t('panel.dashboard.speedLimit.settings')}
            />
          }
          nativeButton={false}
        >
          <SpeedControlIcon
            className="size-3.5 text-muted-foreground"
            aria-hidden
          />
        </Button>
      }
    >
      {/* Turtle-state selector row */}
      <TooltipProvider delay={300}>
        <div
          data-testid="speed-limit-selector"
          className={cn(
            'grid shrink-0 pt-2',
            compact
              ? 'grid-cols-[repeat(3,36px)] justify-between gap-2.5'
              : tall
                ? 'grid-cols-1 gap-2'
                : 'grid-cols-3 gap-2'
          )}
        >
          {SPEED_LIMIT_MODES.map(({ id }) => {
            const active = state.turtle === id
            const image = SPEED_MODE_IMAGES[id]
            return (
              <Tooltip key={id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t(`panel.dashboard.speedLimit.turtle.${id}`)}
                      aria-pressed={active}
                      onClick={() => onSelectTurtle(id)}
                      className={cn(
                        'flex items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        compact ? 'size-9' : 'h-12 w-full',
                        active
                          ? 'bg-black/80 ring-1 ring-inset ring-black/80 dark:bg-white/10 dark:ring-white/35'
                          : 'hover:bg-muted'
                      )}
                    />
                  }
                >
                  <img
                    src={image.src}
                    srcSet={`${image.src} 1x, ${image.src2x} 2x`}
                    width={52}
                    height={52}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className={cn(
                      'pointer-events-none max-w-full select-none object-contain dark:filter-none',
                      !active && 'brightness-90 contrast-[1.12] saturate-[1.2]',
                      compact ? 'size-7' : 'size-9'
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {t(`panel.dashboard.speedLimit.tooltip.${id}`)}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </TooltipProvider>

      <div
        data-testid="speed-limit-effective"
        className={cn(
          'mt-auto flex gap-2',
          tall ? 'flex-col items-stretch' : 'flex-row items-end justify-between'
        )}
      >
        <span
          data-testid="speed-limit-mode"
          className={cn(
            'font-medium text-foreground',
            compact ? 'text-[11px]' : 'text-[12px]'
          )}
        >
          {t(`panel.dashboard.speedLimit.turtle.${state.turtle}`)}
        </span>
        {!compact ? (
          <div
            data-testid="speed-limit-rates"
            className="flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground"
          >
            <span className="flex gap-0.5 items-center">
              <span className="mr-0.5 text-xs">↓</span>
              {fmt(state.effective.download)}
            </span>
            <span className="flex gap-0.5 items-center">
              <span className="mr-0.5 text-xs">↑</span>
              {fmt(state.effective.upload)}
            </span>
          </div>
        ) : null}
      </div>

      {/* Detailed presentations explain why the effective profile is active. */}
      {detailed && state.activeReason !== 'none' ? (
        <div
          data-testid="speed-limit-reason"
          className="mt-1 shrink-0 text-[11px] text-muted-foreground/70"
        >
          {t(`panel.dashboard.speedLimit.reason.${state.activeReason}`)}
        </div>
      ) : null}
    </TileShell>
  )
}
