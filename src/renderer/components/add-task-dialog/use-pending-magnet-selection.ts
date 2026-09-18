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
  const { tasks, hasReadySnapshot, realtimeConnected, status } = useTaskList()
  const { t } = useTranslation()
  const open = useAddTaskDialogStore((state) => state.open)
  const revision = useAddTaskDialogStore((state) => state.revision)
  const prefill = useAddTaskDialogStore((state) => state.prefill)
  const tasksAtOpen = useAddTaskDialogStore((state) => state.tasksAtOpen)
  const [handled, setHandled] = useState(() => new Set<string>())
  const [retryTick, setRetryTick] = useState(0)
  const attempts = useRef(new Map<string, number>())
  const notified = useRef(new Set<string>())
  const previousHealth = useRef({ realtimeConnected, status })
  const latestTasks = useRef(tasks)

  useEffect(() => {
    const previous = previousHealth.current
    previousHealth.current = { realtimeConnected, status }
    if (
      (!previous.realtimeConnected && realtimeConnected) ||
      (previous.status === 'error' && status === 'ready')
    ) {
      attempts.current.clear()
      setRetryTick((tick) => tick + 1)
    }
  }, [realtimeConnected, status])
  const taskId = tasks.find(
    (task) =>
      task.status === TaskStatus.MetadataReady &&
      !handled.has(task.id) &&
      (attempts.current.get(task.id) ?? 0) < 3
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
      tasks === tasksAtOpen ||
      prefill?.tab !== 'torrent' ||
      !prefill.existingTaskId
    )
      return
    const task = tasks.find((entry) => entry.id === prefill.existingTaskId)
    // Opening a picker records the cached list and invalidates older queries.
    // A later snapshot can settle it without trusting any pre-open status.
    if (task && task.status !== TaskStatus.MetadataReady) {
      if (onSelectionSettled) onSelectionSettled(task.id)
      else useAddTaskDialogStore.getState().close()
    }
  }, [hasReadySnapshot, open, prefill, tasks, tasksAtOpen, onSelectionSettled])

  useEffect(() => {
    if (open || !taskId) return
    let active = true
    const taskName = latestTasks.current.find(
      (task) => task.id === taskId
    )?.name
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const retry = () => {
      const count = (attempts.current.get(taskId) ?? 0) + 1
      attempts.current.set(taskId, count)
      if (count >= 3) setRetryTick(retryTick + 1)
      else
        retryTimer = setTimeout(
          () => setRetryTick(retryTick + 1),
          1_000 * 2 ** (count - 1)
        )
    }
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
      .then((opened) => {
        if (!active) return
        if (opened) remember()
        else retry()
      })
      .catch((error: unknown) => {
        if (!active) return
        retry()
        if (notified.current.has(taskId)) return
        notified.current.add(taskId)
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
      clearTimeout(retryTimer)
    }
  }, [open, revision, taskId, retryTick, t])
}
