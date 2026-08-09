import { getStatusTone } from '@renderer/lib/task-status-ui'
import { cn } from '@renderer/lib/utils'
import { TaskStatus } from '@shared/types/task'
import { useTranslation } from 'react-i18next'

const LABEL_KEY: Record<TaskStatus, string> = {
  [TaskStatus.Queued]: 'panel.downloads.status.queued',
  [TaskStatus.FetchingMetadata]: 'panel.downloads.status.fetchingMetadata',
  [TaskStatus.MetadataReady]: 'panel.downloads.status.metadataReady',
  [TaskStatus.Downloading]: 'panel.downloads.status.downloading',
  [TaskStatus.Finalizing]: 'panel.downloads.status.finalizing',
  [TaskStatus.Seeding]: 'panel.downloads.status.seeding',
  [TaskStatus.Paused]: 'panel.downloads.status.paused',
  [TaskStatus.Completed]: 'panel.downloads.status.completed',
  [TaskStatus.Error]: 'panel.downloads.status.error',
  [TaskStatus.Removed]: 'panel.downloads.status.error',
}

export function StatusPill({ status }: { status: TaskStatus }) {
  const { t } = useTranslation()
  const tone = getStatusTone(status)
  return (
    <span
      data-testid="task-status-pill"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone.bg,
        tone.text
      )}
    >
      {t(LABEL_KEY[status])}
    </span>
  )
}
