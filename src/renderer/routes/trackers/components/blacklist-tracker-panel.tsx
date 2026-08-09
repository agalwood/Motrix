import { Switch } from '@renderer/components/ui/switch'
import { useTrackerList } from '@renderer/hooks/use-tracker-list'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import type { TrackerSource } from '@shared/types/tracker'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TrackerSourceCombobox } from './tracker-source-combobox'

interface BlacklistTrackerPanelProps {
  filter?: string
}

export function BlacklistTrackerPanel({
  filter,
}: BlacklistTrackerPanelProps = {}) {
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
          setEnabled(all.tracker.blacklistEnabled)
          setSources(all.tracker.blacklistSources)
        }
      })
      .catch(() => {})
  }, [])

  const handleEnabledChange = async (next: boolean) => {
    setEnabled(next)
    await transport.invoke(Commands.UpdateSettings, {
      tracker: { blacklistEnabled: next },
    })
  }

  const handleSourcesChange = async (next: TrackerSource[]) => {
    setSources(next)
    await transport.invoke(Commands.UpdateSettings, {
      tracker: { blacklistSources: next },
    })
  }

  const visibleRows = useMemo(() => {
    const sourcesById = new Map(sources.map((s) => [s.id, s.label]))
    const needle = filter?.trim().toLowerCase()
    return list.blacklist
      .map((url) => {
        const sourceLabels = (list.sourceMap[url] ?? [])
          .map((id) => sourcesById.get(id))
          .filter(Boolean)
          .join(', ')
        return { url, sourceLabels }
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
            {t('trackers.blacklist.enabled')}
          </span>
          <p className="text-xs text-muted-foreground">
            {t('trackers.blacklist.enabledDesc')}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={handleEnabledChange} />
      </div>

      <TrackerSourceCombobox sources={sources} onChange={handleSourcesChange} />

      {!enabled ? (
        <div className="flex min-h-0 flex-1 items-start rounded-md border border-border p-4 text-sm text-muted-foreground">
          {t('trackers.blacklist.disabled')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border">
          <div className="sticky top-0 z-10 grid grid-cols-[1fr_140px] items-center gap-4 border-b border-border bg-background px-3 py-2 text-[11px] uppercase text-muted-foreground">
            <div>{t('trackers.blacklist.column.url')}</div>
            <div>{t('trackers.blacklist.column.source')}</div>
          </div>
          {list.blacklist.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('trackers.blacklist.empty')}
            </div>
          ) : (
            visibleRows.map((row) => (
              <div
                key={row.url}
                className="grid grid-cols-[1fr_140px] items-center gap-4 border-b border-border px-3 py-2 text-sm last:border-b-0"
              >
                <span className="truncate text-xs" title={row.url}>
                  {row.url}
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
