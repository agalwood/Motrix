import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { useModifierKeys } from '@renderer/hooks/use-modifier-keys'
import { fetchTaskBtDetail } from '@renderer/hooks/use-task-bt-detail'
import { infoHashToMagnetUri } from '@renderer/lib/magnet'
import { rtlMirror } from '@renderer/lib/task-status-ui'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { isTorrentLike } from '@shared/types/task-actions'
import {
  ChevronDown,
  FolderOpen,
  ListChecks,
  Pause,
  Play,
  RadioTower,
  Repeat2,
  Square,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { canRevealTaskFolder } from './can-reveal-task-folder'
import { RemoveTasksDialog } from './remove-tasks-dialog'
import { useTaskActions } from './use-task-actions'

export interface TaskInspectorActionBarProps {
  selected: readonly DownloadTask[]
  onClose: () => void
}

/**
 * Click-time copy with an explicit failure path: a failed detail fetch must
 * abort the copy and tell the user, never silently write a tracker-less
 * magnet and report success. Re-throw so CopyButton keeps its idle state.
 */
async function copyTaskUrl(
  task: DownloadTask,
  onFailure: () => void
): Promise<void> {
  let url: string
  try {
    url = await getCopyUrl(task)
  } catch (error) {
    onFailure()
    throw error
  }
  await navigator.clipboard.writeText(url)
}

async function getCopyUrl(task: DownloadTask): Promise<string> {
  if (isTorrentLike(task)) {
    // magnetUri/announceList are projected out of the broadcast (option E);
    // fetch the full per-task detail at click time.
    const detail = await fetchTaskBtDetail(task.id)
    if (detail.magnetUri) return detail.magnetUri
    if (task.infoHash) {
      return infoHashToMagnetUri(task.infoHash, {
        name: task.name,
        trackers: detail.announceList.flat(),
      })
    }
  }
  return task.uris[0] ?? ''
}

interface CountedButtonProps {
  label: string
  total: number
  count: number
  tooltipSingle: string
  tooltipBatch: string
  icon: React.ReactNode
  variant?: 'outline' | 'destructive'
  destructive?: boolean
  disabled?: boolean
  onClick: (e: React.MouseEvent) => void
}

function CountedButton({
  label,
  total,
  count,
  tooltipSingle,
  tooltipBatch,
  icon,
  variant = 'outline',
  destructive,
  disabled,
  onClick,
}: CountedButtonProps) {
  const tooltip = total === 1 ? tooltipSingle : tooltipBatch
  return (
    <Button
      size="xs"
      variant={variant}
      className={cn(destructive && 'text-destructive')}
      disabled={disabled}
      title={tooltip}
      onClick={onClick}
    >
      {icon}
      {label}
      {total > 1 && count > 0 && (
        <span className="tabular-nums ml-0.5">({count})</span>
      )}
    </Button>
  )
}

function FinalizingActionBar({
  task,
  onClose,
}: {
  task: DownloadTask
  onClose: () => void
}) {
  const { t } = useTranslation()
  const reason = t('panel.downloads.action.finalizingTooltip')
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
      <Button size="xs" variant="outline" disabled title={reason}>
        <Pause />
        {t('panel.downloads.action.pause')}
      </Button>
      {__MOTRIX_TARGET__ === 'electron' && canRevealTaskFolder(task) && (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            transport.invoke(Commands.RevealInFolder, { taskId: task.id })
          }
        >
          <FolderOpen />
          {t('panel.downloads.action.openFolder')}
        </Button>
      )}
      <CopyButton
        size="xs"
        variant="outline"
        onClick={() =>
          copyTaskUrl(task, () =>
            toast.add({
              title: t('panel.downloads.action.copyUrlFailed'),
              type: 'error',
            })
          )
        }
      >
        {t('panel.downloads.action.copyUrl')}
      </CopyButton>
      <Button
        size="xs"
        variant="outline"
        className="ms-auto text-destructive"
        disabled
        title={reason}
      >
        <Trash2 />
        {t('panel.downloads.action.remove')}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('common.close')}
        onClick={onClose}
      >
        <ChevronDown />
      </Button>
    </div>
  )
}

export function TaskInspectorActionBar({
  selected,
  onClose,
}: TaskInspectorActionBarProps) {
  const { t } = useTranslation()
  const { shift, alt } = useModifierKeys()
  const single = selected.length === 1 ? selected[0] : null
  const actions = useTaskActions(selected)

  if (single && single.status === TaskStatus.Finalizing) {
    return <FinalizingActionBar task={single} onClose={onClose} />
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
        {actions.pauseCount > 0 && (
          <CountedButton
            label={t('panel.downloads.action.pause')}
            total={actions.total}
            count={actions.pauseCount}
            tooltipSingle={t('panel.downloads.action.pause')}
            tooltipBatch={t('panel.downloads.action.pauseTooltipBatch', {
              n: actions.pauseCount,
              total: actions.total,
            })}
            icon={<Pause />}
            onClick={() => void actions.onPause()}
          />
        )}
        {actions.resumeCount > 0 && (
          <CountedButton
            label={t('panel.downloads.action.resume')}
            total={actions.total}
            count={actions.resumeCount}
            tooltipSingle={t('panel.downloads.action.resume')}
            tooltipBatch={t('panel.downloads.action.resumeTooltipBatch', {
              n: actions.resumeCount,
              total: actions.total,
            })}
            icon={<Play className={rtlMirror} />}
            onClick={() => void actions.onResume()}
          />
        )}
        {actions.retryCount > 0 && (
          <CountedButton
            label={t('panel.downloads.action.retry')}
            total={actions.total}
            count={actions.retryCount}
            tooltipSingle={
              alt && actions.total === 1
                ? t('panel.downloads.action.retryWithDialog')
                : t('panel.downloads.action.retry')
            }
            tooltipBatch={t('panel.downloads.action.retryTooltipBatch', {
              n: actions.retryCount,
              total: actions.total,
            })}
            icon={<Repeat2 />}
            onClick={(e) => void actions.onRetry({ alt: e.altKey })}
          />
        )}
        {actions.reseedCount > 0 && (
          <CountedButton
            label={t('panel.downloads.action.reseed')}
            total={actions.total}
            count={actions.reseedCount}
            tooltipSingle={
              alt && actions.total === 1
                ? t('panel.downloads.action.retryWithDialog')
                : t('panel.downloads.action.reseed')
            }
            tooltipBatch={t('panel.downloads.action.reseedTooltipBatch', {
              n: actions.reseedCount,
              total: actions.total,
            })}
            icon={<RadioTower />}
            onClick={(e) => void actions.onReseed({ alt: e.altKey })}
          />
        )}
        {actions.stopSeedingCount > 0 && (
          <CountedButton
            label={t('panel.downloads.action.stopSeeding')}
            total={actions.total}
            count={actions.stopSeedingCount}
            tooltipSingle={t('panel.downloads.action.stopSeeding')}
            tooltipBatch={t('panel.downloads.action.stopSeedingTooltipBatch', {
              n: actions.stopSeedingCount,
              total: actions.total,
            })}
            icon={<Square />}
            onClick={() => void actions.onStopSeeding()}
          />
        )}

        {single && single.status === TaskStatus.MetadataReady && (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void transport.invoke(
                Commands.ReopenMagnetFileSelection,
                single.id
              )
            }
          >
            <ListChecks />
            {t('panel.downloads.action.selectFiles')}
          </Button>
        )}

        {single &&
          __MOTRIX_TARGET__ === 'electron' &&
          canRevealTaskFolder(single) && (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                transport.invoke(Commands.RevealInFolder, {
                  taskId: single.id,
                })
              }
            >
              <FolderOpen />
              {t('panel.downloads.action.openFolder')}
            </Button>
          )}
        {single && (
          <CopyButton
            size="xs"
            variant="outline"
            onClick={() =>
              copyTaskUrl(single, () =>
                toast.add({
                  title: t('panel.downloads.action.copyUrlFailed'),
                  type: 'error',
                })
              )
            }
          >
            {t('panel.downloads.action.copyUrl')}
          </CopyButton>
        )}

        <CountedButton
          label={t('panel.downloads.action.remove')}
          total={actions.total}
          count={actions.removeCount}
          tooltipSingle={
            shift
              ? t('panel.downloads.action.removeWithFilesShift')
              : t('panel.downloads.action.remove')
          }
          tooltipBatch={t('panel.downloads.action.removeTooltipBatch', {
            n: actions.removeCount,
            total: actions.total,
          })}
          icon={<Trash2 />}
          destructive
          onClick={(e) => actions.onRemove({ shift: e.shiftKey })}
        />

        <Button
          size="icon-xs"
          variant="ghost"
          className="ms-auto"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <ChevronDown />
        </Button>
      </div>

      <RemoveTasksDialog
        open={actions.removeDialog.open}
        selected={selected}
        preCheckDeleteFiles={actions.removeDialog.preCheckDeleteFiles}
        onOpenChange={(open) => {
          if (!open) actions.closeRemoveDialog()
        }}
        onConfirm={(deleteFiles) => void actions.confirmRemove(deleteFiles)}
      />
    </>
  )
}
