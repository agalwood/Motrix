// src/renderer/routes/dashboard/tiles/engine-tile.tsx
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import type { EngineFailureReason } from '@shared/types/engine'
import { Bug } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatusDot } from '../components/status-dot'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

export type EngineDisplayState =
  | 'ready'
  | 'starting'
  | 'reconnecting'
  | 'failed'
  | 'disconnected'
  | 'stopped'

export interface EngineDisplayStatus {
  state: EngineDisplayState
  version: string
  rpcPort: number
  listenPort: number
  failureReason: EngineFailureReason | null
}

export interface EngineTileProps {
  status: EngineDisplayStatus
  viewport: DashboardTileViewport
  className?: string
  onManage?: () => void
}

const DOT: Record<EngineDisplayState, string> = {
  ready: 'bg-emerald-500',
  starting: 'bg-amber-500',
  reconnecting: 'bg-amber-500',
  failed: 'bg-red-500',
  disconnected: 'bg-red-500',
  stopped: 'bg-muted-foreground/40',
}

export function EngineTile({
  status,
  viewport,
  className,
  onManage,
}: EngineTileProps) {
  const { t } = useTranslation()
  const compact = viewport.contentLevel === 'compact'
  const detailed =
    viewport.contentLevel === 'detailed' || viewport.contentLevel === 'focus'
  const tall = viewport.orientation === 'tall'
  const pulse =
    status.state === 'ready' ||
    status.state === 'starting' ||
    status.state === 'reconnecting'
  const stateLabel = t(`panel.dashboard.engine.state.${status.state}`)

  // 'aria2c 1.37.0-motrix.1' only show '1.37.0'
  const shortVersion = String(status.version).split('-')[0]
  const subItems = [
    {
      label: t('panel.dashboard.engine.name'),
      value: shortVersion,
    },
    {
      label: t('panel.dashboard.engine.listenPort'),
      value: String(status.listenPort),
    },
    {
      label: t('panel.dashboard.engine.rpcPort'),
      value: String(status.rpcPort),
    },
  ]

  return (
    <TileShell
      label={t('panel.dashboard.engine.title')}
      className={className}
      action={
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size={compact ? 'icon-xs' : 'xs'}
          aria-label={t('panel.dashboard.engine.diagnostics.open')}
          onClick={onManage}
        >
          {compact ? (
            <Bug
              className={cn(
                'size-3.5 text-muted-foreground',
                status.state === 'failed' ? 'text-destructive' : null
              )}
            />
          ) : (
            t('panel.dashboard.engine.diagnostics.open')
          )}
        </Button>
      }
    >
      <TileTitle variant="text" title={stateLabel}>
        {stateLabel}
      </TileTitle>
      {detailed && status.state === 'failed' && (
        <div
          data-testid="engine-failure"
          className="mt-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {t(
            `panel.dashboard.engine.diagnostics.reason.${status.failureReason ?? 'unknown'}`
          )}
        </div>
      )}
      {!compact ? (
        <div
          data-testid="engine-footer"
          className={cn(
            'mt-auto flex gap-3',
            tall
              ? 'flex-col items-stretch'
              : 'flex-row items-end justify-between'
          )}
        >
          <div
            data-testid="engine-subs"
            className={cn(
              'grid min-w-0 flex-1 text-[12px] text-muted-foreground',
              tall ? 'grid-cols-1 gap-2' : 'grid-cols-3'
            )}
          >
            {subItems.map((item) => (
              <Sub
                key={item.label}
                label={item.label}
                value={item.value}
                stacked={tall}
              />
            ))}
          </div>
          <StatusDot
            pulse={pulse}
            className={cn(DOT[status.state], tall && 'self-end')}
          />
        </div>
      ) : (
        <div
          data-testid="engine-footer"
          className="mt-auto flex items-center justify-between"
        >
          <div className="flex shrink-0 items-center gap-3 text-muted-foreground tabular-nums text-[11px]">
            {`aria2 v${shortVersion}`}
          </div>
          <StatusDot pulse={pulse} className={cn(DOT[status.state])} />
        </div>
      )}
    </TileShell>
  )
}

function Sub({
  label,
  value,
  stacked,
}: {
  label: string
  value: string
  stacked: boolean
}) {
  return (
    <div
      className={cn(
        'min-w-0 border-border/70',
        stacked
          ? 'border-t pt-2 first:border-t-0 first:pt-0'
          : 'border-l px-3 first:border-l-0 first:pl-0 last:pr-0'
      )}
    >
      <span className="text-[11px] leading-none block truncate uppercase">
        {label}
      </span>
      <span
        title={value}
        className="mt-1 block truncate text-[15px] font-medium text-foreground tabular-nums"
      >
        {value}
      </span>
    </div>
  )
}
