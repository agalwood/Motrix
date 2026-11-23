import { FileList } from '@renderer/components/file-list/file-list'
import { EditIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { taskWritesAvailable } from '@renderer/features/application-menu/task-context'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useTaskFiles } from '@renderer/hooks/use-task-files'
import { formatProgressPercent } from '@renderer/lib/format'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import { canRenameTaskFiles } from '@shared/types/task-actions'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TaskFileRenameDialog } from './task-file-rename-dialog'

const ACTIVE_DOWNLOAD = new Set<TaskStatus>([
  TaskStatus.Downloading,
  TaskStatus.Seeding,
  TaskStatus.FetchingMetadata,
])

const READ_ONLY_STATES = new Set<TaskStatus>([
  TaskStatus.Finalizing,
  TaskStatus.Completed,
  TaskStatus.Removed,
])

const EMPTY_SELECTION: number[] = []

function sameSelection(a: number[], b: number[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((index) => set.has(index))
}

export function FilesTab({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const { formatBytes } = useByteFormat()
  const isMedia = task.kind === TaskKind.Hls || task.kind === TaskKind.Mux
  const isActive = ACTIVE_DOWNLOAD.has(task.status)
  const { files, refetch } = useTaskFiles(
    task.id,
    isActive && task.status !== TaskStatus.Seeding,
    task.engineTaskId
  )
  useOperatorSession()
  const writable = transport.platform !== 'web' || taskWritesAvailable()
  const canRename = writable && canRenameTaskFiles(task)
  const [renaming, setRenaming] = useState<{
    taskId: string
    engineTaskId: string
    file: TaskFile
  } | null>(null)
  const initial = task.bt?.selectedFiles ?? EMPTY_SELECTION
  const [draft, setDraft] = useState<number[]>(initial)
  // Direct HTTP/FTP and single-file tasks have no file selection to make.
  // Media tasks require the entire segment plan, so their list is read-only
  // too, with no select-all checkbox or Save/Cancel controls.
  const isStructurallyImmutable =
    isMedia ||
    task.type === TaskType.Http ||
    task.type === TaskType.Ftp ||
    files.length <= 1
  const isReadOnly =
    READ_ONLY_STATES.has(task.status) || isStructurallyImmutable
  const immutableSelection = useMemo(
    () =>
      isStructurallyImmutable
        ? files.filter((file) => !file.padding).map((file) => file.index)
        : EMPTY_SELECTION,
    [files, isStructurallyImmutable]
  )
  const selectedIndices = isStructurallyImmutable
    ? immutableSelection
    : isReadOnly
      ? initial
      : draft
  const dirty = useMemo(() => !sameSelection(draft, initial), [draft, initial])
  const canSave = dirty && draft.length > 0

  async function onSave() {
    await transport.invoke(Commands.SetSelectedFiles, {
      taskId: task.id,
      indices: draft,
    })
  }

  return (
    <div className="flex min-h-26 flex-1 flex-col gap-2 border border-border rounded-md">
      <FileList<TaskFile>
        key={`${task.id}:${task.engineTaskId}`}
        hierarchical={
          !isMedia &&
          (task.type === TaskType.Bt || task.type === TaskType.Magnet)
        }
        scrollbar="custom"
        showColumnHeaders={false}
        className="max-h-60"
        files={files}
        selectedIndices={selectedIndices}
        onSelectionChange={isReadOnly ? undefined : setDraft}
        readOnly={isReadOnly}
        renderRowActions={
          canRename
            ? (file) =>
                !file.padding && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`${t('task.fileRename.title')}: ${file.path}`}
                    onClick={() =>
                      setRenaming({
                        taskId: task.id,
                        engineTaskId: task.engineTaskId,
                        file,
                      })
                    }
                  >
                    <EditIcon />
                  </Button>
                )
            : undefined
        }
        renderRowSize={
          isMedia ? (f) => (f.size > 0 ? formatBytes(f.size) : '—') : undefined
        }
        rowTrailingLabel={t('panel.downloads.column.progress')}
        renderRowTrailing={
          isActive || isMedia
            ? (f) => (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatProgressPercent(
                    f.progress ??
                      (files.length === 1 && !isMedia
                        ? task.progress
                        : f.completedBytes / Math.max(f.size, 1)),
                    1
                  ).toFixed(1)}
                  %
                </span>
              )
            : undefined
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
      {renaming?.taskId === task.id &&
        renaming.engineTaskId === task.engineTaskId && (
          <TaskFileRenameDialog
            task={task}
            file={renaming.file}
            onClose={() => setRenaming(null)}
            onRenamed={refetch}
          />
        )}
    </div>
  )
}
