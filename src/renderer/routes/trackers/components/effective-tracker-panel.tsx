import { Switch } from '@renderer/components/ui/switch'
import { useTrackerList } from '@renderer/hooks/use-tracker-list'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import type { TrackerHealth, TrackerSource } from '@shared/types/tracker'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TrackerSourceCombobox } from './tracker-source-combobox'

const HEALTH_DOT_COLOR: Record<TrackerHealth['status'], string> = {
  healthy: 'bg-green-500',
  slow: 'bg-yellow-500',
  unreachable: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
}

function HealthDot({ status }: { status: TrackerHealth['status'] }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        HEALTH_DOT_COLOR[status]
      )}
      aria-hidden="true"
    />
  )
}

interface EffectiveTrackerPanelProps {
  filter?: string
}

export function EffectiveTrackerPanel({
  filter,
}: EffectiveTrackerPanelProps = {}) {
  const { t } = useTranslation()
  const { list } = useTrackerList()
  const [enabled, setEnabled] = useState(true)
  const [sources, setSources] = useState<TrackerSource[]>([])

  useEffect(() => {
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        const all = data as AppSettings
        if (all?.tracker) {
          setEnabled(all.tracker.sourcesEnabled)
          setSources(all.tracker.sources)
        }
      })
      .catch(() => {})
  }, [])

  const handleEnabledChange = async (next: boolean) => {
    setEnabled(next)
    await transport.invoke(Commands.UpdateSettings, {
      tracker: { sourcesEnabled: next },
    })
  }

  const handleSourcesChange = async (next: TrackerSource[]) => {
    setSources(next)
    await transport.invoke(Commands.UpdateSettings, {
      tracker: { sources: next },
    })
  }

  const visibleRows = useMemo(() => {
    const sourcesById = new Map(sources.map((s) => [s.id, s.label]))
    const needle = filter?.trim().toLowerCase()
    return list.effective
      .map((url) => {
        const health = list.healthMap[url]
        const sourceLabels = (list.sourceMap[url] ?? [])
          .map((id) => sourcesById.get(id))
          .filter(Boolean)
          .join(', ')
        return {
          url,
          health: health?.status ?? 'unknown',
          responseTimeMs: health?.lastProbeMs ?? null,
          lastProbedAt: health?.lastProbeAt
            ? new Date(health.lastProbeAt).toLocaleString()
            : null,
          sourceLabels,
        }
      })
      .filter((row) =>
        needle
          ? row.url.toLowerCase().includes(needle) ||
            row.sourceLabels.toLowerCase().includes(needle)
          : true
      )
  }, [list, sources, filter])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="space-y-1">
          <span className="text-sm font-medium">
            {t('trackers.effective.enabled')}
          </span>
          <p className="text-xs text-muted-foreground">
            {t('trackers.effective.enabledDesc')}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={handleEnabledChange} />
      </div>

      <TrackerSourceCombobox sources={sources} onChange={handleSourcesChange} />

      {!enabled ? (
        <div className="flex min-h-0 flex-1 items-start rounded-md border border-border p-4 text-sm text-muted-foreground">
          {t('trackers.effective.disabled')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border">
          <div className="sticky top-0 z-10 grid grid-cols-[1fr_80px_140px_140px] items-center gap-4 border-b border-border bg-background px-3 py-2 text-[11px] uppercase text-muted-foreground">
            <div>{t('trackers.effective.column.url')}</div>
            <div className="text-right">
              {t('trackers.effective.column.health')}
            </div>
            <div className="text-right">
              {t('trackers.effective.column.lastProbedAt')}
            </div>
            <div>{t('trackers.effective.column.source')}</div>
          </div>
          {list.effective.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('trackers.effective.empty')}
            </div>
          ) : (
            visibleRows.map((row) => (
              <div
                key={row.url}
                className="grid grid-cols-[1fr_80px_140px_140px] items-center gap-4 border-b border-border px-3 py-2 text-sm last:border-b-0"
              >
                <span className="truncate text-xs" title={row.url}>
                  {row.url}
                </span>
                <span className="flex items-center justify-end gap-1.5">
                  <span className="text-xs text-right">
                    {row.responseTimeMs ? `${row.responseTimeMs} ms` : '—'}
                  </span>
                  <HealthDot status={row.health} />
                </span>
                <span className="text-xs text-right text-muted-foreground">
                  {row.lastProbedAt ?? '—'}
                </span>
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={row.sourceLabels}
                >
                  {row.sourceLabels || '—'}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
