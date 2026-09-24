import { Button } from '@renderer/components/ui/button'
import { useTranslation } from 'react-i18next'

interface FooterActionsProps {
  submitting: boolean
  canSubmit: boolean
  torrentQueue?: { current: number; total: number }
  onCancel: () => void
  onDownloadAll: () => void
  onSubmit: () => void
}

export function FooterActions({
  submitting,
  canSubmit,
  torrentQueue,
  onCancel,
  onDownloadAll,
  onSubmit,
}: FooterActionsProps) {
  const { t } = useTranslation()
  const queuedCount = torrentQueue
    ? torrentQueue.total - torrentQueue.current + 1
    : 0
  const hasQueuedTorrents = queuedCount > 1

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {torrentQueue ? t('task.add.torrentQueueProgress', torrentQueue) : null}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          {hasQueuedTorrents ? t('task.add.skipTorrent') : t('common.cancel')}
        </Button>
        {hasQueuedTorrents && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDownloadAll}
            disabled={!canSubmit || submitting}
          >
            {t('task.add.downloadAllTorrents', { count: queuedCount })}
          </Button>
        )}
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onSubmit}
          disabled={!canSubmit || submitting}
          className="gap-2"
        >
          <span>
            {submitting
              ? t('task.add.adding')
              : torrentQueue && torrentQueue.current < torrentQueue.total
                ? t('task.add.downloadAndContinue')
                : t('common.download')}
          </span>
        </Button>
      </div>
    </div>
  )
}
