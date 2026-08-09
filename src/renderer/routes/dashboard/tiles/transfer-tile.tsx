import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import type { TransferStatsState } from '@renderer/hooks/use-transfer-stats'
import { formatBytes } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type { TransferRangeStats } from '@shared/types/stats'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KpiNumber } from '../components/kpi-number'
import { TileSegmentedControl } from '../components/tile-segmented-control'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

type TransferScope = 'today' | 'allTime'

export interface TransferTileProps {
  state: TransferStatsState
  viewport: DashboardTileViewport
  className?: string
}

interface RangeControlProps {
  scope: TransferScope
  disabled?: boolean
  onScopeChange: (scope: TransferScope) => void
}

function RangeDropdown({ scope, disabled, onScopeChange }: RangeControlProps) {
  const { t } = useTranslation()
  const rangeLabel = t('panel.dashboard.transfer.rangeLabel')
  const selectedLabel = t(`panel.dashboard.transfer.scope.${scope}`)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            aria-label={`${rangeLabel}: ${selectedLabel}`}
            className="w-full min-w-0 justify-between px-2 shadow-none"
          />
        }
      >
        <span>{selectedLabel}</span>
        <ChevronDown aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-32">
        <DropdownMenuRadioGroup
          value={scope}
          aria-label={rangeLabel}
          onValueChange={(value) => onScopeChange(value as TransferScope)}
        >
          {(['today', 'allTime'] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {t(`panel.dashboard.transfer.scope.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function parseByteCount(value: string): bigint {
  try {
    const bytes = BigInt(value)
    return bytes > 0n ? bytes : 0n
  } catch {
    return 0n
  }
}

function TransferBar({ range }: { range: TransferRangeStats }) {
  const upload = parseByteCount(range.uploadBytes)
  const download = parseByteCount(range.downloadBytes)
  const total = upload + download
  if (total === 0n) return null

  const uploadPercent = Number((upload * 10_000n) / total) / 100
  const downloadPercent = 100 - uploadPercent

  return (
    <div
      data-testid="transfer-proportion-bar"
      aria-hidden
      className="flex h-6 w-full gap-1"
    >
      {upload > 0n ? (
        <div
          data-testid="transfer-upload-segment"
          className="h-full rounded-sm"
          style={{
            width: `${uploadPercent}%`,
            background: 'var(--color-up)',
          }}
        />
      ) : null}
      {download > 0n ? (
        <div
          data-testid="transfer-download-segment"
          className="h-full rounded-sm"
          style={{
            width: `${downloadPercent}%`,
            background: 'var(--color-down)',
          }}
        />
      ) : null}
    </div>
  )
}

function DirectionMetric({
  label,
  value,
  align = 'left',
  inline = false,
}: {
  label: string
  value: string
  align?: 'left' | 'right'
  inline?: boolean
}) {
  return (
    <div
      className={cn(
        'min-w-0',
        align === 'right' && 'text-right',
        inline && 'flex items-baseline justify-between gap-2'
      )}
    >
      <span className="block shrink-0 text-[9px] font-medium uppercase leading-none tracking-[0.04em] text-muted-foreground">
        {label}
      </span>
      <KpiNumber
        value={formatBytes(value)}
        variant="compact"
        className={cn('max-w-full', !inline && 'mt-1')}
        unitClassName="text-[10px] text-muted-foreground"
      />
    </div>
  )
}

function DirectionBreakdown({
  range,
  viewport,
}: {
  range: TransferRangeStats
  viewport: DashboardTileViewport
}) {
  const { t } = useTranslation()
  const tall = viewport.span.w === 1

  if (tall) {
    return (
      <div data-testid="transfer-directions" className="grid min-w-0 gap-3">
        <DirectionMetric
          label={t('panel.dashboard.transfer.upload')}
          value={range.uploadBytes}
        />
        <DirectionMetric
          label={t('panel.dashboard.transfer.download')}
          value={range.downloadBytes}
        />
      </div>
    )
  }

  return (
    <div
      data-testid="transfer-directions"
      className="min-w-0 text-muted-foreground"
    >
      <div
        data-testid="transfer-direction-labels"
        className="flex w-full justify-between text-[11px] leading-none"
      >
        <span className="uppercase tracking-wide">
          {t('panel.dashboard.transfer.upload')}
        </span>
        <span className="uppercase tracking-wide">
          {t('panel.dashboard.transfer.download')}
        </span>
      </div>
      <div
        data-testid="transfer-direction-values"
        className="flex w-full justify-between"
      >
        <div className="text-left font-medium tabular-nums text-foreground text-sm">
          <KpiNumber value={formatBytes(range.uploadBytes)} variant="compact" />
        </div>
        <div className="text-right font-medium tabular-nums text-foreground text-sm">
          <KpiNumber
            value={formatBytes(range.downloadBytes)}
            variant="compact"
          />
        </div>
      </div>
    </div>
  )
}

function coverageCaption({
  scope,
  range,
  locale,
  translate,
}: {
  scope: TransferScope
  range: TransferRangeStats
  locale: string
  translate: (key: string, values?: Record<string, string>) => string
}): string | null {
  if (scope === 'today') {
    if (range.coverageStartedAt <= range.startedAt) return null
    const time = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(range.coverageStartedAt)
    return translate('panel.dashboard.transfer.sinceTime', { time })
  }

  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
  }).format(range.coverageStartedAt)
  return translate('panel.dashboard.transfer.sinceDate', { date })
}

function LoadingContent({ viewport }: { viewport: DashboardTileViewport }) {
  const { t } = useTranslation()
  const widthOne = viewport.span.w === 1
  const compact = viewport.contentLevel === 'compact'
  const detailed = viewport.span.h === 2

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between gap-3">
      <span className="sr-only" role="status" aria-live="polite">
        {t('panel.dashboard.transfer.loading')}
      </span>
      {widthOne && !compact ? <Skeleton className="h-6 w-full" /> : null}
      <Skeleton className="h-8 w-24" />
      {compact ? (
        <Skeleton className="h-6 w-full" />
      ) : (
        <>
          <div
            className={cn(
              'grid gap-3',
              widthOne ? 'grid-cols-1' : 'grid-cols-2'
            )}
          >
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
          </div>
          <Skeleton className="h-6 w-full rounded-sm" />
          {detailed ? <Skeleton className="h-3 w-24" /> : null}
        </>
      )}
    </div>
  )
}

export function TransferTile({
  state,
  viewport,
  className,
}: TransferTileProps) {
  const { t, i18n } = useTranslation()
  const [scope, setScope] = useState<TransferScope>('today')
  const widthOne = viewport.span.w === 1
  const compact = viewport.contentLevel === 'compact'
  const detailed = viewport.span.h === 2 && viewport.contentLevel === 'detailed'
  const singleRow = viewport.span.h === 1 && !compact
  const snapshot = 'snapshot' in state ? state.snapshot : null
  const range = snapshot?.[scope]
  const totalIsZero = range ? parseByteCount(range.totalBytes) === 0n : false
  const formattedTotal = range ? formatBytes(range.totalBytes) : null
  const scopeLabel = t(`panel.dashboard.transfer.scope.${scope}`)

  let statusCaption: string | null = null
  let caption: string | null = null
  if (snapshot && state.status === 'stale') {
    if (snapshot.updatedAt === null) {
      statusCaption = t('panel.dashboard.transfer.outOfDate')
    } else {
      const time = new Intl.DateTimeFormat(i18n.language, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(snapshot.updatedAt)
      statusCaption = t('panel.dashboard.transfer.updated', { time })
    }
  } else if (range && detailed) {
    caption = coverageCaption({
      scope,
      range,
      locale: i18n.language,
      translate: t,
    })
  }
  caption = statusCaption ?? caption

  const rangeOptions = (['today', 'allTime'] as const).map((value) => ({
    value,
    label: t(`panel.dashboard.transfer.scope.${value}`),
  }))
  const rangeControl = snapshot ? (
    <TileSegmentedControl
      ariaLabel={t('panel.dashboard.transfer.rangeLabel')}
      value={scope}
      options={rangeOptions}
      onValueChange={setScope}
    />
  ) : null

  return (
    <TileShell
      label={t('panel.dashboard.transfer.title')}
      action={widthOne ? null : rangeControl}
      className={className}
      bodyClassName={cn('min-h-0', singleRow && 'gap-1')}
    >
      {state.status === 'loading' ? (
        <LoadingContent viewport={viewport} />
      ) : state.status === 'unavailable' ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-2">
          <span className="text-xs leading-snug text-muted-foreground">
            {t('panel.dashboard.transfer.unavailable')}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className={cn(widthOne ? 'w-full' : 'self-start')}
            onClick={state.retry}
          >
            {t('panel.dashboard.transfer.retry')}
          </Button>
        </div>
      ) : range ? (
        <div
          data-testid="transfer-content"
          data-presentation={`${viewport.span.w}x${viewport.span.h}`}
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            singleRow ? 'gap-1' : 'gap-2'
          )}
        >
          {widthOne && !compact ? (
            <RangeDropdown scope={scope} onScopeChange={setScope} />
          ) : null}

          <section
            data-testid="transfer-total"
            aria-label={
              formattedTotal
                ? t('panel.dashboard.transfer.totalLabel', {
                    scope: scopeLabel,
                    value: formattedTotal,
                  })
                : undefined
            }
            className="shrink-0"
          >
            <TileTitle value={formattedTotal ?? '0 B'} />
          </section>

          {compact ? (
            <div className="mt-auto grid gap-1.5">
              {caption ? (
                <span
                  role={statusCaption ? 'status' : undefined}
                  aria-live={statusCaption ? 'polite' : undefined}
                  className="text-[9px] leading-none text-muted-foreground"
                >
                  {caption}
                </span>
              ) : null}
              <RangeDropdown scope={scope} onScopeChange={setScope} />
            </div>
          ) : totalIsZero ? (
            <div className="mt-auto grid gap-1 text-xs leading-snug text-muted-foreground">
              <span>{t(`panel.dashboard.transfer.empty.${scope}`)}</span>
              {statusCaption ? (
                <span role="status" aria-live="polite">
                  {statusCaption}
                </span>
              ) : null}
            </div>
          ) : (
            <div
              data-testid="transfer-chart"
              className="mt-auto flex min-w-0 flex-col gap-1"
            >
              <DirectionBreakdown range={range} viewport={viewport} />
              <TransferBar range={range} />
              {caption ? (
                <span
                  role={statusCaption ? 'status' : undefined}
                  aria-live={statusCaption ? 'polite' : undefined}
                  className="text-[10px] leading-snug text-muted-foreground"
                >
                  {caption}
                </span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </TileShell>
  )
}
