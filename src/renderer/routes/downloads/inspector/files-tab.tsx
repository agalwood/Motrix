import { FileList } from '@renderer/components/file-list/file-list'
import { Button } from '@renderer/components/ui/button'
import { useTaskFiles } from '@renderer/hooks/use-task-files'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

const ACTIVE_DOWNLOAD = new Set<TaskStatus>([
  TaskStatus.Downloading,
  TaskStatus.Seeding,
  TaskStatus.FetchingMetadata,
])

const READ_ONLY_STATES = new Set<TaskStatus>([
  TaskStatus.Completed,
  TaskStatus.Removed,
])

function arraysEqualSorted(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

export function FilesTab({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const isActive = ACTIVE_DOWNLOAD.has(task.status)
  const { files } = useTaskFiles(task.id, isActive)
  const initial = task.bt?.selectedFiles ?? []
  const [draft, setDraft] = useState<number[]>(initial)
  // Single-file tasks (HTTP/FTP always; single-file BT/Magnet/Metalink) have
  // no meaningful selection to make — there's only one file. Treat them as
  // read-only so the select-all checkbox + Save/Cancel footer disappear.
  const isStructurallyImmutable =
    task.type === TaskType.Http ||
    task.type === TaskType.Ftp ||
    files.length <= 1
  const isReadOnly =
    READ_ONLY_STATES.has(task.status) || isStructurallyImmutable
  const dirty = !arraysEqualSorted(draft, initial)
  const canSave = dirty && draft.length > 0

  async function onSave() {
    await transport.invoke(Commands.SetSelectedFiles, {
      taskId: task.id,
      indices: draft,
    })
  }

  return (
    <div className="flex min-h-[105px] flex-1 flex-col gap-2 border border-border rounded-md">
      <FileList<TaskFile>
        files={files}
        selectedIndices={isReadOnly ? initial : draft}
        onSelectionChange={isReadOnly ? undefined : setDraft}
        readOnly={isReadOnly}
        renderRowTrailing={(f) =>
          isActive ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {files.length === 1
                ? Math.round(task.progress * 100)
                : Math.floor((f.completedBytes / Math.max(f.size, 1)) * 100)}
              %
            </span>
          ) : null
        }
        headerClassName="rounded-t-md"
        headerSlot={
          !isReadOnly && (
            <div className="flex shrink-0 justify-end gap-2">
              <Button
                variant="ghost"
                disabled={!dirty}
                onClick={() => setDraft(initial)}
                size="xs"
              >
                {t('common.cancel')}
              </Button>
              <Button disabled={!canSave} onClick={onSave} size="xs">
                {t('common.save')}
              </Button>
            </div>
          )
        }
      />
    </div>
  )
}
