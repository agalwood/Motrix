// src/renderer/routes/dashboard/tiles/speed-limit-tile.tsx

import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import type { SpeedLimitStateView } from '@renderer/hooks/use-speed-limit-state'
import { formatBytes } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { Bolt, InfinityIcon, Rabbit, Squirrel, Turtle } from 'lucide-react'
import type { ComponentType, ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { TileShell } from '../components/tile-shell'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

type TurtleState = SpeedLimitStateView['turtle']

const TURTLES: {
  id: TurtleState
  Icon: ComponentType<{ className?: string }>
}[] = [
  { id: 'off', Icon: Rabbit },
  { id: 'on', Icon: Turtle },
  { id: 'auto', Icon: Squirrel },
]

function fmt(v: number): string | ReactElement {
  return v <= 0 ? <InfinityIcon className="size-4" /> : `${formatBytes(v)}/s`
}

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
          <Bolt className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      }
    >
      {/* Turtle-state selector row */}
      <TooltipProvider delay={300}>
        <div
          data-testid="speed-limit-selector"
          className={cn(
            'grid shrink-0 gap-2 pt-2',
            tall ? 'grid-cols-1' : 'grid-cols-3'
          )}
        >
          {TURTLES.map(({ id, Icon }) => {
            const active = state.turtle === id
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
                        'flex items-center justify-center rounded-md transition-colors',
                        tall ? 'h-9 w-full' : 'aspect-square max-h-10 w-full',
                        active
                          ? 'bg-blue-500 text-primary-foreground dark:text-primary'
                          : 'text-muted-foreground hover:bg-muted'
                      )}
                    />
                  }
                >
                  <Icon className="size-4 lg:size-5 xl:size-6" />
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
            className="flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground tabular-nums"
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
