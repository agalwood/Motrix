import {
  ArrowRightIcon,
  MoreIcon,
  RouterIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { NatStatusMenu } from '@renderer/features/nat/nat-status-menu'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { useNatStatus } from '@renderer/hooks/use-nat-status'
import { NAT_STATUS_TEXT_KEY, natBucket } from '@renderer/lib/nat-status'
import { formatRelativeTime } from '@renderer/lib/relative-time'
import { cn } from '@renderer/lib/utils'
import { type NatMapping, NatProtocol } from '@shared/types/nat'
import { useTranslation } from 'react-i18next'
import { StatusDot } from '../components/status-dot'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

const MAPPING_METHOD_LABELS: Record<NatProtocol, string> = {
  [NatProtocol.Pcp]: 'PCP',
  [NatProtocol.NatPmp]: 'NAT-PMP',
  [NatProtocol.Upnp]: 'UPnP',
}

export interface NatTileProps {
  viewport: DashboardTileViewport
  className?: string
}

export function NatTile({ viewport, className }: NatTileProps) {
  return __MOTRIX_TARGET__ === 'electron' ? (
    <ElectronNatTile viewport={viewport} className={className} />
  ) : null
}

function ElectronNatTile({ viewport, className }: NatTileProps) {
  const { t, i18n } = useTranslation()
  const status = useNatStatus()
  const now = useMinuteClock()
  const compact = viewport.contentLevel === 'compact'
  const summary = viewport.contentLevel === 'summary'
  const narrow = viewport.span.w === 1
  const focus = viewport.contentLevel === 'focus'
  const detailed = !compact && !summary
  const { bucket } = natBucket(status)
  const stateLabel = t(
    narrow
      ? `panel.dashboard.nat.compact.state.${bucket}`
      : NAT_STATUS_TEXT_KEY[bucket]
  )
  const diagnostic = status?.lastDiagnostic
  const gateway = status?.gatewayInfo ?? diagnostic?.gatewayInfo
  const mappings = status?.activeMappings ?? []
  const hasDetails =
    bucket !== 'off' &&
    (bucket === 'active' || gateway || diagnostic || mappings.length > 0)
  const none = t('panel.dashboard.nat.none')
  const typeLabel = diagnostic?.natType
    ? t(`panel.dashboard.nat.natType.${diagnostic.natType}`)
    : none
  const healthLabel = t(
    `panel.dashboard.nat.healthScore.${diagnostic?.healthScore ?? 'unknown'}`
  )
  const lastCheck = diagnostic?.runAt
    ? formatRelativeTime(diagnostic.runAt, now, i18n.language)
    : t('panel.dashboard.nat.lastCheckNever')
  const caption = compact
    ? t(`panel.dashboard.nat.compact.caption.${status ? bucket : 'waiting'}`, {
        count: mappings.length,
      })
    : status
      ? bucket === 'active'
        ? t('panel.dashboard.nat.mappingsValue', { count: mappings.length })
        : t(`panel.dashboard.nat.caption.${bucket}`)
      : t('panel.dashboard.nat.caption.waiting')
  const statusDot = (
    <StatusDot
      data-bucket={bucket}
      pulse={bucket === 'active' || bucket === 'settingUp'}
      className={cn(
        bucket === 'active'
          ? 'bg-emerald-500'
          : bucket === 'settingUp'
            ? 'bg-amber-500'
            : 'bg-muted-foreground/40'
      )}
    />
  )

  return (
    <TileShell
      label={t('panel.dashboard.nat.title')}
      className={className}
      bodyClassName="@container/nat"
      action={
        <NatStatusMenu status={status}>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t('panel.dashboard.nat.actions.group')}
              />
            }
          >
            <MoreIcon className="size-3.5 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
        </NatStatusMenu>
      }
    >
      <div
        data-testid="nat-hero"
        className="flex min-h-8 shrink-0 items-center"
      >
        <TileTitle variant="text" title={stateLabel}>
          {stateLabel}
        </TileTitle>
      </div>

      {compact ? (
        <div className="mt-auto flex items-end justify-between gap-3 pt-2">
          <p className="text-[11px] leading-snug text-muted-foreground">
            {caption}
          </p>
          {statusDot}
        </div>
      ) : !hasDetails ? (
        <div
          data-testid="nat-empty"
          className={cn(
            'flex min-h-0 flex-1 text-muted-foreground',
            summary
              ? 'items-end justify-between gap-3 pt-2'
              : 'flex-col items-center justify-center gap-3'
          )}
        >
          {detailed ? (
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted/50">
              <RouterIcon className="size-6 stroke-[1.5]" aria-hidden />
            </div>
          ) : null}
          <p
            className={cn(
              'max-w-60 text-xs leading-relaxed',
              detailed && 'text-center'
            )}
          >
            {caption}
          </p>
          {summary ? statusDot : null}
        </div>
      ) : summary ? (
        <div className="mt-auto flex items-end gap-3 pt-2">
          <dl
            data-testid="nat-summary"
            className="grid min-w-0 flex-1 grid-cols-3 gap-3"
          >
            <Metric
              label={t('panel.dashboard.nat.health')}
              value={healthLabel}
              dense
            />
            <Metric
              label={t('panel.dashboard.nat.type')}
              value={typeLabel}
              dense
            />
            <Metric
              label={t('panel.dashboard.nat.mappings')}
              value={t('panel.dashboard.nat.mappingsValue', {
                count: mappings.length,
              })}
              dense
            />
          </dl>
          {statusDot}
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <dl
            data-testid="nat-details"
            data-content-level={viewport.contentLevel}
            data-orientation={viewport.orientation}
            className={cn(
              'grid min-w-0',
              narrow
                ? 'shrink-0 grid-cols-1 gap-0'
                : 'grid-cols-2 gap-x-5 gap-y-4',
              !narrow && (focus ? 'shrink-0' : 'flex-1 content-between')
            )}
          >
            <Metric
              testId="nat-metric-external-ip"
              label={t('panel.dashboard.nat.externalIp')}
              value={gateway?.externalIp ?? none}
              featured
              className={cn('col-span-full', narrow && 'mb-3')}
            />
            {focus ? (
              <>
                <Metric
                  label={t('panel.dashboard.nat.internalIp')}
                  value={gateway?.internalIp ?? none}
                />
                <Metric
                  label={t('panel.dashboard.nat.gatewayIp')}
                  value={gateway?.gatewayIp ?? none}
                />
              </>
            ) : null}
            <Metric
              label={t('panel.dashboard.nat.health')}
              value={healthLabel}
              inline={narrow}
            />
            <Metric
              label={t('panel.dashboard.nat.type')}
              value={typeLabel}
              inline={narrow}
            />
            <Metric
              label={t('panel.dashboard.nat.mappings')}
              value={t('panel.dashboard.nat.mappingsValue', {
                count: mappings.length,
              })}
              inline={narrow}
            />
            <Metric
              label={t('panel.dashboard.nat.lastCheck')}
              value={lastCheck}
              inline={narrow}
            />
          </dl>
          {focus ? <MappingList mappings={mappings} /> : null}
        </div>
      )}
      {detailed ? (
        <div className="flex shrink-0 justify-end pt-3">{statusDot}</div>
      ) : null}
    </TileShell>
  )
}

function Metric({
  label,
  value,
  testId,
  featured = false,
  inline = false,
  dense = false,
  className,
}: {
  label: string
  value: string
  testId?: string
  featured?: boolean
  inline?: boolean
  dense?: boolean
  className?: string
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'min-w-0',
        featured && 'rounded-xl bg-muted/40 px-3 py-2.5',
        inline &&
          'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-baseline gap-2 border-b border-border/50 py-2.5 last:border-0',
        className
      )}
    >
      <dt
        className={cn(
          'text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase',
          dense ? 'leading-3' : 'leading-4'
        )}
      >
        {label}
      </dt>
      <dd
        title={value}
        className={cn(
          'min-w-0 font-medium text-foreground',
          featured
            ? 'mt-1 break-all font-mono text-[clamp(0.75rem,8cqi,1rem)] leading-5'
            : inline
              ? 'break-words text-end text-xs leading-4'
              : dense
                ? 'mt-1 break-words text-xs leading-4'
                : 'mt-1 break-words text-sm leading-5'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function MappingList({ mappings }: { mappings: readonly NatMapping[] }) {
  const { t } = useTranslation()
  return (
    <section
      data-testid="nat-mapping-list"
      aria-label={t('panel.dashboard.nat.mappingDetails')}
      className="min-w-0 border-t border-border/60 pt-3"
    >
      <h3 className="text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        {t('panel.dashboard.nat.mappingDetails')}
      </h3>
      {mappings.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {mappings.map((mapping) => (
            <li
              key={`${mapping.purpose}:${mapping.protocol}:${mapping.internalPort}:${mapping.externalPort}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-muted/35 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {t(`panel.dashboard.nat.mappingPurpose.${mapping.purpose}`)}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {mapping.protocol} / {MAPPING_METHOD_LABELS[mapping.method]}
                </p>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
                <span className="sr-only">
                  {t('panel.dashboard.nat.portMapping', {
                    internal: mapping.internalPort,
                    external: mapping.externalPort,
                  })}
                </span>
                <span aria-hidden>{mapping.internalPort}</span>
                <ArrowRightIcon
                  className="size-3 text-muted-foreground"
                  aria-hidden
                />
                <span aria-hidden>{mapping.externalPort}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('panel.dashboard.nat.noMappings')}
        </p>
      )}
    </section>
  )
}
