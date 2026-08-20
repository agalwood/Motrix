import { useGlobalStats } from '@renderer/hooks/use-global-stats'
import { formatBytes } from '@renderer/lib/format'
import { useTranslation } from 'react-i18next'
import { EngineBadge } from './engine-badge'
import type { DownloadsTab } from './filter'
import { NatBadge } from './nat-badge'

interface GlobalStatsBarProps {
  counts: Record<DownloadsTab, number>
}

export function GlobalStatsBar({ counts }: GlobalStatsBarProps) {
  const { t } = useTranslation()
  const { stats } = useGlobalStats()

  return (
    <>
      <div className="flex items-center gap-4 text-[11.5px] text-muted-foreground">
        <span className="tabular-nums">
          {t('panel.downloads.stats.downSpeed')}{' '}
          <span className="text-foreground">
            {stats ? `${formatBytes(stats.totalDownloadSpeed)}/s` : '—'}
          </span>
        </span>
        <span className="tabular-nums">
          {t('panel.downloads.stats.upSpeed')}{' '}
          <span className="text-foreground">
            {stats ? `${formatBytes(stats.totalUploadSpeed)}/s` : '—'}
          </span>
        </span>
        <span className="tabular-nums">
          {t('panel.downloads.stats.counts', {
            active: counts.active,
            completed: counts.completed,
            error: counts.error,
          })}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[11.5px]">
        <NatBadge />
        <EngineBadge />
      </div>
    </>
  )
}
