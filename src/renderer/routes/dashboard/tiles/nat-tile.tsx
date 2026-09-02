// src/renderer/routes/dashboard/tiles/nat-tile.tsx

import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useNatStatus } from '@renderer/hooks/use-nat-status'
import {
  isNatRetrying,
  isNatRunning,
  type NatBucket,
  natBucket,
} from '@renderer/lib/nat-status'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { ErrorCode } from '@shared/errors'
import { getNatTroubleshootingUrl } from '@shared/external-urls'
import { type CommandChannel, Commands } from '@shared/protocol/commands'
import { Activity, BookOpen, Power, RefreshCw, Settings2 } from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { StatusDot } from '../components/status-dot'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

const STATE_TEXT_KEY: Record<NatBucket, string> = {
  active: 'panel.dashboard.nat.state.active',
  settingUp: 'panel.dashboard.nat.state.settingUp',
  failed: 'panel.dashboard.nat.state.failed',
  off: 'panel.dashboard.nat.state.off',
}

function formatRelative(ms: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const deltaMs = ms - Date.now()
  const absSec = Math.abs(deltaMs) / 1000
  if (absSec < 60) return rtf.format(Math.round(deltaMs / 1000), 'seconds')
  if (absSec < 3600) return rtf.format(Math.round(deltaMs / 60_000), 'minutes')
  if (absSec < 86_400)
    return rtf.format(Math.round(deltaMs / 3_600_000), 'hours')
  return rtf.format(Math.round(deltaMs / 86_400_000), 'days')
}

export interface NatTileProps {
  viewport: DashboardTileViewport
  className?: string
}

interface NatAction {
  key: string
  Icon: ComponentType<{ className?: string }>
  label: string
  shortLabel: string
  run: () => void
}

export function NatTile({ viewport, className }: NatTileProps) {
  return __MOTRIX_TARGET__ === 'electron' ? (
    <ElectronNatTile viewport={viewport} className={className} />
  ) : null
}

function ElectronNatTile({ viewport, className }: NatTileProps) {
  const { t, i18n } = useTranslation()
  const services = usePlatformServices()
  const status = useNatStatus()
  const compact = viewport.contentLevel === 'compact'
  const summary = viewport.contentLevel === 'summary'
  const showDetails =
    viewport.contentLevel === 'detailed' || viewport.contentLevel === 'focus'
  const focus = viewport.contentLevel === 'focus'

  const { bucket, color } = natBucket(status)
  const failed = bucket === 'failed'
  const stateLabel =
    status && isNatRetrying(status)
      ? t('panel.dashboard.nat.retrying', {
          attempt: status.retryAttempt,
          max: status.maxRetries,
        })
      : t(STATE_TEXT_KEY[bucket])
  const running = isNatRunning(status)

  const runCommand = useCallback(
    async (channel: CommandChannel) => {
      const res = (await transport.invoke(channel)) as
        | { ok?: boolean; error?: string }
        | undefined
      if (res && res.ok === false && res.error === ErrorCode.IpcRateLimited) {
        toast.add({
          title: t('panel.dashboard.nat.rateLimited'),
          type: 'error',
        })
      }
    },
    [t]
  )

  const none = t('panel.dashboard.nat.none')
  const natType = status?.lastDiagnostic?.natType
  const typeLabel = natType ? t(`panel.dashboard.nat.natType.${natType}`) : none
  const externalIp = status?.gatewayInfo?.externalIp ?? none
  const mappingsCount = status?.activeMappings.length ?? 0
  const health = status?.lastDiagnostic?.healthScore
  const healthLabel = t(
    `panel.dashboard.nat.healthScore.${health ?? 'unknown'}`
  )
  const lastCheck = status?.lastDiagnostic?.runAt
    ? formatRelative(status.lastDiagnostic.runAt, i18n.language)
    : t('panel.dashboard.nat.lastCheckNever')

  const toggleLabel = running
    ? t('panel.dashboard.nat.actions.disable')
    : t('panel.dashboard.nat.actions.enable')
  const toggleShortLabel = running
    ? t('panel.dashboard.nat.actions.short.disable')
    : t('panel.dashboard.nat.actions.short.enable')
  const actions: NatAction[] = [
    {
      key: 'toggle',
      Icon: Power,
      label: toggleLabel,
      shortLabel: toggleShortLabel,
      run: () =>
        void runCommand(running ? Commands.DisableNat : Commands.EnableNat),
    },
    {
      key: 'remap',
      Icon: RefreshCw,
      label: t('panel.dashboard.nat.actions.remap'),
      shortLabel: t('panel.dashboard.nat.actions.short.remap'),
      run: () => void runCommand(Commands.ForceRemapNat),
    },
    {
      key: 'diagnose',
      Icon: Activity,
      label: t('panel.dashboard.nat.actions.diagnose'),
      shortLabel: t('panel.dashboard.nat.actions.short.diagnose'),
      run: () => void runCommand(Commands.RunNatDiagnostic),
    },
  ]
  if (failed) {
    actions.push({
      key: 'help',
      Icon: BookOpen,
      label: t('panel.dashboard.nat.actions.troubleshoot'),
      shortLabel: t('panel.dashboard.nat.actions.short.help'),
      run: () =>
        services.openExternal(
          getNatTroubleshootingUrl(i18n.resolvedLanguage ?? i18n.language)
        ),
    })
  }

  return (
    <TileShell
      label={t('panel.dashboard.nat.title')}
      className={className}
      action={
        compact ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="cursor-default"
            aria-label={toggleLabel}
            onClick={actions[0]?.run}
          >
            <Power className="size-3.5" aria-hidden />
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="cursor-default"
            render={
              <Link
                to="/settings/network"
                role="link"
                aria-label={t('panel.dashboard.nat.actions.settings')}
              />
            }
            nativeButton={false}
          >
            <Settings2 className="size-3.5 text-muted-foreground" aria-hidden />
          </Button>
        )
      }
    >
      <div
        data-testid="nat-hero"
        className={cn(
          'flex min-w-0 items-center gap-2.5 pt-0.5',
          compact && 'mt-auto',
          summary && 'justify-between'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <StatusDot
            data-bucket={bucket}
            pulse={bucket === 'settingUp'}
            className={cn(color, compact && 'size-3')}
          />
          <div className="min-w-0 flex-1">
            <TileTitle variant="text" title={stateLabel}>
              {stateLabel}
            </TileTitle>
          </div>
        </div>
        {summary ? (
          <NatActions
            actions={actions}
            label={t('panel.dashboard.nat.actions.group')}
            summary
          />
        ) : null}
      </div>

      {summary ? (
        <dl
          data-testid="nat-summary"
          className="mt-auto grid min-w-0 grid-cols-3 pt-3 tabular-nums"
        >
          <Metric
            label={t('panel.dashboard.nat.health')}
            value={healthLabel}
            compact
          />
          <Metric
            label={t('panel.dashboard.nat.type')}
            value={typeLabel}
            compact
            divided
          />
          <Metric
            label={t('panel.dashboard.nat.mappings')}
            value={t('panel.dashboard.nat.mappingsValue', {
              count: mappingsCount,
            })}
            compact
            divided
          />
        </dl>
      ) : null}

      {showDetails ? (
        <dl
          data-testid="nat-details"
          data-content-level={viewport.contentLevel}
          data-orientation={viewport.orientation}
          className={cn(
            'mt-4 grid min-h-0 flex-1 grid-cols-2 grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-x-5 gap-y-3',
            focus && 'gap-x-8 gap-y-4'
          )}
        >
          <Metric
            testId="nat-metric-external-ip"
            label={t('panel.dashboard.nat.externalIp')}
            value={externalIp}
            featured
            focus={focus}
          />
          <Metric
            label={t('panel.dashboard.nat.health')}
            value={healthLabel}
            focus={focus}
          />
          <Metric
            label={t('panel.dashboard.nat.type')}
            value={typeLabel}
            focus={focus}
            divided
          />
          <Metric
            label={t('panel.dashboard.nat.mappings')}
            value={String(mappingsCount)}
            focus={focus}
          />
          <Metric
            label={t('panel.dashboard.nat.lastCheck')}
            value={lastCheck}
            focus={focus}
            divided
          />
        </dl>
      ) : null}

      {showDetails ? (
        <NatActions
          actions={actions}
          label={t('panel.dashboard.nat.actions.group')}
          focus={focus}
        />
      ) : null}
    </TileShell>
  )
}

function Metric({
  label,
  value,
  testId,
  compact = false,
  featured = false,
  focus = false,
  divided = false,
}: {
  label: string
  value: string
  testId?: string
  compact?: boolean
  featured?: boolean
  focus?: boolean
  divided?: boolean
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'min-w-0',
        featured
          ? 'col-span-2 rounded-xl bg-muted/40 px-3.5 py-3 ring-1 ring-inset ring-foreground/5'
          : 'flex flex-col justify-center py-2',
        featured && focus && 'px-4 py-4',
        divided && !featured && 'border-l border-border/70 pl-4'
      )}
    >
      <dt className="whitespace-nowrap text-[10px] leading-none font-medium tracking-[0.04em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        title={value}
        className={cn(
          'mt-1.5 block min-w-0 font-medium tracking-[-0.01em] text-foreground tabular-nums',
          featured ? 'break-all' : 'break-words',
          compact
            ? 'text-[14px]'
            : featured
              ? focus
                ? 'text-[22px]'
                : 'text-[18px]'
              : focus
                ? 'text-[17px]'
                : 'text-[15px]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function NatActions({
  actions,
  label,
  summary = false,
  focus = false,
}: {
  actions: NatAction[]
  label: string
  summary?: boolean
  focus?: boolean
}) {
  return (
    <TooltipProvider delay={300}>
      <fieldset
        data-testid="nat-actions"
        aria-label={label}
        className={cn(
          'grid min-w-0 shrink-0 gap-0.5 rounded-lg border-0 bg-muted/45 p-1 ring-1 ring-inset ring-foreground/5',
          actions.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
          summary ? 'w-fit' : 'mt-3 w-full'
        )}
      >
        {actions.map((action, index) => (
          <Tooltip key={action.key}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size={summary ? 'icon-xs' : focus ? 'sm' : 'icon-sm'}
                  variant="ghost"
                  aria-label={action.label}
                  onClick={action.run}
                  className={cn(
                    'min-w-0 cursor-default rounded-md text-muted-foreground transition-[background-color,color,transform] duration-100 ease-out hover:bg-background/80 hover:text-foreground active:scale-[0.97] motion-reduce:transform-none motion-reduce:transition-none dark:hover:bg-background/35',
                    summary && 'size-7',
                    !summary && 'w-full',
                    focus && 'h-9 gap-1.5 px-2',
                    index === 0 &&
                      'bg-background/75 text-foreground shadow-xs dark:bg-background/30'
                  )}
                />
              }
            >
              <action.Icon className="size-4" aria-hidden />
              {focus ? (
                <span className="whitespace-nowrap text-xs">
                  {action.shortLabel}
                </span>
              ) : null}
            </TooltipTrigger>
            <TooltipContent>{action.label}</TooltipContent>
          </Tooltip>
        ))}
      </fieldset>
    </TooltipProvider>
  )
}
