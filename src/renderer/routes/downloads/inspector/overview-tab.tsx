import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { resolveFailureReason } from '@renderer/lib/failure-reason'
import { formatBytes, formatDurationHMS } from '@renderer/lib/format'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { canAttemptRetry } from '@shared/types/task-actions'
import { AlertCircleIcon, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTaskActions } from './use-task-actions'

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md bg-muted/60 p-3">
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="flex flex-col gap-1 text-xs text-foreground">
        {children}
      </div>
    </div>
  )
}

function Row({
  label,
  value,
}: {
  label: string
  value: string | number | React.ReactNode
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      {typeof value === 'string' || typeof value === 'number' ? (
        <span className="tabular-nums">{value}</span>
      ) : (
        value
      )}
    </div>
  )
}

function ErrorPanel({ task }: { task: DownloadTask }) {
  const { t, i18n } = useTranslation()
  const { onRetry } = useTaskActions([task])
  const failure = resolveFailureReason(
    {
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,
      errorDetailKey: task.errorDetailKey,
      errorDetailParams: task.errorDetailParams,
    },
    { t, exists: (key) => i18n.exists(key) }
  )
  const showRetry = canAttemptRetry(task)

  return (
    <div className="flex flex-col gap-2">
      <Alert variant="destructive" className="items-start">
        <AlertCircleIcon />
        <AlertTitle>{failure.reason}</AlertTitle>
        {(failure.hint || failure.technicalDetail) && (
          <AlertDescription className="min-w-0">
            {failure.hint && <span className="block">{failure.hint}</span>}
            {failure.technicalDetail && (
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {failure.technicalDetail}
              </pre>
            )}
          </AlertDescription>
        )}
        {showRetry && (
          <AlertAction>
            <Button
              size="xs"
              variant="default"
              className="self-start"
              onClick={() => void onRetry()}
            >
              <RotateCcw data-icon="inline-start" />
              {t('panel.downloads.action.retry')}
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  )
}

export function OverviewTab({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const isBt = task.type === TaskType.Bt || task.type === TaskType.Magnet
  return (
    <div className="flex flex-col gap-3">
      {task.status === TaskStatus.Error && <ErrorPanel task={task} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title={t('panel.downloads.inspector.overview.transfer')}>
          <Row
            label={t('panel.downloads.inspector.overview.downSpeed')}
            value={`${formatBytes(task.downloadSpeed)}/s`}
          />
          <Row
            label={t('panel.downloads.inspector.overview.upSpeed')}
            value={`${formatBytes(task.uploadSpeed)}/s`}
          />
          <Row
            label={t('panel.downloads.inspector.overview.eta')}
            value={formatDurationHMS(task.etaSeconds)}
          />
        </Card>
        <Card title={t('panel.downloads.inspector.overview.progress')}>
          <Row
            label={t('panel.downloads.inspector.overview.downloaded')}
            value={formatBytes(task.downloadedBytes)}
          />
          <Row
            label={t('panel.downloads.inspector.overview.totalSize')}
            value={formatBytes(task.sizeWhenDone)}
          />
          <Row
            label={t('panel.downloads.inspector.overview.percent')}
            value={`${Math.round(task.progress * 100)}%`}
          />
        </Card>
        <Card title={t('panel.downloads.inspector.overview.network')}>
          {isBt && task.bt ? (
            <>
              <Row
                label={t('panel.downloads.inspector.overview.peers')}
                value={task.bt.peers}
              />
              <Row
                label={t('panel.downloads.inspector.overview.seeds')}
                value={task.bt.seeds}
              />
              <Row
                label={t('panel.downloads.inspector.overview.ratio')}
                value={task.bt.ratio.toFixed(2)}
              />
            </>
          ) : (
            <Row
              label={t('panel.downloads.inspector.overview.connections')}
              value={task.connections}
            />
          )}
        </Card>
        <Card title={t('panel.downloads.inspector.overview.metadata')}>
          <Row
            label={t('panel.downloads.inspector.overview.type')}
            value={task.type.toUpperCase()}
          />
          {task.infoHash && (
            <Row
              label={t('panel.downloads.inspector.overview.infoHash')}
              value={
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger render={<span className="tabular-nums" />}>
                      {`${task.infoHash.slice(0, 4)}…${task.infoHash.slice(-4)}`}
                    </TooltipTrigger>
                    <TooltipContent side="left">{task.infoHash}</TooltipContent>
                  </Tooltip>

                  <CopyButton
                    variant="ghost"
                    className="has-[>svg]:px-0 p-0 h-[18px] w-[18px] rounded-md [&_svg:not([class*='size-'])]:size-3"
                    content={task.infoHash}
                  />
                </div>
              }
            />
          )}
          {isBt && task.bt && (
            <Row
              label={t('panel.downloads.inspector.overview.private')}
              value={task.bt.isPrivate ? '✓' : '—'}
            />
          )}
        </Card>
      </div>
    </div>
  )
}
