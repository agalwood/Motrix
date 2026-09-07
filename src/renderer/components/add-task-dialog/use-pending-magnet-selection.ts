import { toast } from '@renderer/components/ui/toast'
import { useTaskList } from '@renderer/hooks/use-task-list'
import { openMagnetFileSelection } from '@renderer/lib/open-magnet-file-selection'
import { TaskStatus } from '@shared/types/task'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'

/** Recover one-shot selection events from the task snapshot, including after
 *  refresh/reconnect. Wait for the current form to close and offer each task
 *  once per page session; dismissed selections remain available in the inspector header. */
export function usePendingMagnetSelection(
  onSelectionSettled?: (taskId: string) => void
) {
  const { tasks, hasReadySnapshot } = useTaskList()
  const { t } = useTranslation()
  const open = useAddTaskDialogStore((state) => state.open)
  const revision = useAddTaskDialogStore((state) => state.revision)
  const prefill = useAddTaskDialogStore((state) => state.prefill)
  const [handled, setHandled] = useState(() => new Set<string>())
  const latestTasks = useRef(tasks)
  const taskId = tasks.find(
    (task) => task.status === TaskStatus.MetadataReady && !handled.has(task.id)
  )?.id

  useEffect(() => {
    latestTasks.current = tasks
  }, [tasks])

  useEffect(() => {
    const displayedTaskId =
      open && prefill?.tab === 'torrent' ? prefill.existingTaskId : undefined
    if (!displayedTaskId) return
    setHandled((previous) =>
      previous.has(displayedTaskId)
        ? previous
        : new Set(previous).add(displayedTaskId)
    )
  }, [open, prefill])

  useEffect(() => {
    if (
      !hasReadySnapshot ||
      !open ||
      prefill?.tab !== 'torrent' ||
      !prefill.existingTaskId
    )
      return
    const task = tasks.find((entry) => entry.id === prefill.existingTaskId)
    if (task && task.status !== TaskStatus.MetadataReady) {
      if (onSelectionSettled) onSelectionSettled(task.id)
      else useAddTaskDialogStore.getState().close()
    }
  }, [hasReadySnapshot, open, prefill, tasks, onSelectionSettled])

  useEffect(() => {
    if (open || !taskId) return
    let active = true
    const taskName = latestTasks.current.find(
      (task) => task.id === taskId
    )?.name
    const remember = () =>
      setHandled((previous) => new Set(previous).add(taskId))
    void openMagnetFileSelection(taskId, () => {
      const dialog = useAddTaskDialogStore.getState()
      return (
        active &&
        !dialog.open &&
        dialog.revision === revision &&
        latestTasks.current.some(
          (task) =>
            task.id === taskId && task.status === TaskStatus.MetadataReady
        )
      )
    })
      .then(() => {
        if (active) remember()
      })
      .catch((error: unknown) => {
        if (!active) return
        remember()
        toast.add({
          title: t('panel.downloads.action.singleTaskFailed', {
            name: taskName ?? taskId,
            reason: error instanceof Error ? error.message : String(error),
          }),
          type: 'error',
        })
      })
    return () => {
      active = false
    }
  }, [open, revision, taskId, t])
}
