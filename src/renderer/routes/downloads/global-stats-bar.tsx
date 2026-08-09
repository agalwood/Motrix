import { useGlobalStats } from '@renderer/hooks/use-global-stats'
import { formatBytes } from '@renderer/lib/format'
import { useTranslation } from 'react-i18next'
import { EngineBadge } from './engine-badge'
import { NatBadge } from './nat-badge'

export function GlobalStatsBar() {
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
            active: stats?.activeTasks ?? 0,
            completed: stats?.stoppedTasks ?? 0,
            error: 0,
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
