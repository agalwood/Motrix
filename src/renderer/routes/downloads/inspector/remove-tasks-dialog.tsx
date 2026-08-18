import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { formatBytes } from '@renderer/lib/format'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface RemoveTasksDialogProps {
  open: boolean
  selected: readonly DownloadTask[]
  preCheckDeleteFiles: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (deleteFiles: boolean) => void
}

const HAS_OUTPUT_STATES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.Completed,
  TaskStatus.Seeding,
  TaskStatus.Paused,
  TaskStatus.Downloading,
])

// Middle ellipsis: keep the head and the tail (so the file extension stays
// visible) and collapse the middle. A plain end-cut silently dropped the
// extension, e.g. "...x265-NeoNoir.mkv" became "...x265-NeoNoir.mk".
function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s
  const ellipsis = '…'
  const head = Math.ceil((max - ellipsis.length) / 2)
  const tail = Math.floor((max - ellipsis.length) / 2)
  return s.slice(0, head) + ellipsis + s.slice(s.length - tail)
}

function buildTitle(
  selected: readonly DownloadTask[],
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (selected.length === 1) {
    return t('panel.downloads.action.removeSingleTitle', {
      name: middleEllipsis(selected[0].name, 60),
    })
  }
  const statuses = new Set(selected.map((task) => task.status))
  if (statuses.size === 1) {
    const key = `panel.downloads.action.removeAll_${selected[0].status}_Title`
    const fallback = t('panel.downloads.action.removeMixedTitle', {
      count: selected.length,
    })
    // i18next returns the key itself when no translation is registered;
    // we treat that as a missing entry and fall back to the mixed title.
    const translated = t(key, { count: selected.length })
    return translated === key ? fallback : translated
  }
  return t('panel.downloads.action.removeMixedTitle', {
    count: selected.length,
  })
}

function hasOutput(selected: readonly DownloadTask[]): boolean {
  return selected.some(
    (task) => task.downloadedBytes > 0 || HAS_OUTPUT_STATES.has(task.status)
  )
}

function estimateDiskUsage(selected: readonly DownloadTask[]): number {
  return selected.reduce(
    (sum, task) => sum + Math.max(task.downloadedBytes, task.sizeWhenDone),
    0
  )
}

export function RemoveTasksDialog({
  open,
  selected,
  preCheckDeleteFiles,
  onOpenChange,
  onConfirm,
}: RemoveTasksDialogProps) {
  const { t } = useTranslation()
  const checkboxId = useId()
  // Deleting files is always an explicit opt-in (or the Shift shortcut via
  // preCheckDeleteFiles) — even Error/Queued selections may hold partial
  // data on disk, so no task status ever pre-checks the box.
  const [deleteFiles, setDeleteFiles] = useState(preCheckDeleteFiles)

  useEffect(() => {
    if (open) {
      setDeleteFiles(preCheckDeleteFiles)
    }
  }, [open, preCheckDeleteFiles])

  const showEstimate = deleteFiles && hasOutput(selected)
  const title = buildTitle(selected, t)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id={checkboxId}
            checked={deleteFiles}
            onCheckedChange={(v) => setDeleteFiles(Boolean(v))}
          />
          <label htmlFor={checkboxId} className="cursor-pointer">
            {t('panel.downloads.action.removeConfirmWithFiles')}
          </label>
        </div>
        {showEstimate && (
          <div className="flex items-center gap-2 rounded-md bg-yellow-100 px-3 py-2 text-xs text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200">
            <AlertTriangle className="size-3.5" />
            <span>
              {t('panel.downloads.action.removeFilesEstimate', {
                bytes: formatBytes(estimateDiskUsage(selected)),
              })}
            </span>
          </div>
        )}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('panel.downloads.action.cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onConfirm(deleteFiles)}
          >
            {t('panel.downloads.action.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
