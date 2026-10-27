import { toast } from '@renderer/components/ui/toast'
import { taskWritesAvailable } from '@renderer/features/application-menu/task-context'
import {
  getTaskListSnapshot,
  invalidateTaskList,
} from '@renderer/hooks/use-task-list'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { transport } from '@renderer/lib/transport'
import { type CommandChannel, Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type AddTaskFormValues,
  formValuesToTaskCreateRequests,
} from '@shared/schemas/add-task'
import { isUriOnlyDirectReplay } from '@shared/schemas/direct-replay-recipe'
import {
  type MoveTasksPayload,
  moveTasksResultSchema,
} from '@shared/schemas/move-tasks'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import { type DownloadTask, TaskInstancePhase } from '@shared/types/task'
import type { BulkTaskCommandResult } from '@shared/types/task-actions'
import {
  canAttemptRetry,
  canMoveInQueue,
  canOfferRetry,
  canPause,
  canRedownload,
  canRemove,
  canReseed,
  canResume,
  canRetryWithParameters,
  canStopSeeding,
  getTaskRetryKind,
} from '@shared/types/task-actions'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRedownloadOverwriteStore } from './redownload-overwrite-store'
import { useRemoveTasksStore } from './remove-tasks-store'
import { useRetryParametersStore } from './retry-parameters-store'

export interface RemoveDialogState {
  open: boolean
  preCheckDeleteFiles: boolean
}

type ActionResult =
  | { ok: true; task: DownloadTask }
  | { ok: false; task: DownloadTask; reason: string }

function errMsg(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  try {
    return String(reason)
  } catch {
    return 'unknown'
  }
}

/**
 * Map a plural command's wire result back onto the selection so the
 * partial-failure toast keeps naming the affected task.
 */
function toActionResults(
  targets: readonly DownloadTask[],
  result: BulkTaskCommandResult
): ActionResult[] {
  const reasonById = new Map(
    (result.failed ?? []).map((entry) => [entry.taskId, entry.reason])
  )
  return targets.map((task): ActionResult => {
    const reason = reasonById.get(task.id)
    return reason === undefined
      ? { ok: true, task }
      : { ok: false, task, reason }
  })
}

/**
 * Invoke one plural task command for the whole selection. A whole-command
 * rejection (transport/validation) is reported as every target failing —
 * the same visibility the per-task fan-out used to provide.
 */
async function invokeBulk(
  cmd: CommandChannel,
  targets: readonly DownloadTask[],
  payload: unknown
): Promise<ActionResult[]> {
  try {
    const result = (await transport.invoke(
      cmd,
      payload
    )) as BulkTaskCommandResult
    return toActionResults(targets, result)
  } catch (err) {
    const reason = errMsg(err)
    return targets.map((task) => ({ ok: false, task, reason }))
  }
}

function buildPrefillFromTask(
  task: DownloadTask,
  opts: EngineTaskOptions | null
): Record<string, unknown> {
  const headers = Array.isArray(opts?.header)
    ? opts.header
    : opts?.header
      ? [opts.header]
      : []
  return {
    tab: 'links' as const,
    urls: task.uris.join('\n'),
    saveDir: (opts?.dir as string | undefined) || task.saveDir,
    filename: task.finalName,
    split:
      opts?.split && typeof opts.split === 'string'
        ? Number.parseInt(opts.split, 10) || undefined
        : undefined,
    userAgent:
      headers
        .find((h) => /^user-agent:/i.test(h))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim() ?? undefined,
    referer:
      headers
        .find((h) => /^referer:/i.test(h))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim() ?? undefined,
    cookie:
      headers
        .find((h) => /^cookie:/i.test(h))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim() ?? undefined,
    authorization:
      headers
        .find((h) => /^authorization:/i.test(h))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim() ?? undefined,
    allProxy: (opts?.['all-proxy'] as string | undefined) ?? undefined,
  }
}

export interface TaskActionsState {
  moveCount: number
  moving: boolean
  onMove: (direction: MoveTasksPayload['direction']) => Promise<void>
  pauseCount: number
  resumeCount: number
  stopSeedingCount: number
  reseedCount: number
  retryCount: number
  redownloadCount: number
  removeCount: number
  total: number

  removeDialog: RemoveDialogState
  removeTargets: readonly DownloadTask[]

  onPause: () => Promise<void>
  onResume: () => Promise<void>
  onStopSeeding: () => Promise<void>
  onReseed: (modifier?: { alt: boolean }) => Promise<void>
  onRetry: (modifier?: { alt: boolean }) => Promise<void>
  onRedownload: (modifier?: { alt: boolean }) => Promise<void>
  closeRedownloadOverwriteDialog: () => void
  confirmRedownloadOverwrite: () => Promise<void>
  onRemove: (modifier?: { shift: boolean }) => void
  closeRemoveDialog: () => void
  confirmRemove: (deleteFiles: boolean) => Promise<void>
}

function resolveLatest(targets: readonly DownloadTask[]) {
  const snapshot = getTaskListSnapshot()
  if (!snapshot.hasReadySnapshot) return targets
  const ids = new Set(targets.map((task) => task.id))
  return snapshot.tasks.filter((task) => ids.has(task.id))
}

export function useTaskActions(
  selected: readonly DownloadTask[]
): TaskActionsState {
  const { t } = useTranslation()
  const [moving, setMoving] = useState(false)
  const removeDialog = useRemoveTasksStore()
  const removeTargets = removeDialog.targets

  const counts = useMemo(() => {
    let pauseCount = 0
    let resumeCount = 0
    let stopSeedingCount = 0
    let reseedCount = 0
    let retryCount = 0
    let redownloadCount = 0
    let removeCount = 0
    for (const task of selected) {
      if (canPause(task)) pauseCount++
      if (canResume(task)) resumeCount++
      if (canStopSeeding(task)) stopSeedingCount++
      if (canReseed(task)) reseedCount++
      if (canOfferRetry(task)) retryCount++
      if (canRedownload(task)) redownloadCount++
      if (canRemove(task)) removeCount++
    }
    return {
      moveCount: selected.filter(canMoveInQueue).length,
      pauseCount,
      resumeCount,
      stopSeedingCount,
      reseedCount,
      retryCount,
      redownloadCount,
      removeCount,
      total: selected.length,
    }
  }, [selected])

  const reportPartial = useCallback(
    (results: ActionResult[]) => {
      const failures = results.filter(
        (r): r is Extract<ActionResult, { ok: false }> => !r.ok
      )
      if (failures.length === 0) return
      if (failures.length === 1) {
        toast.add({
          title: t('panel.downloads.action.singleTaskFailed', {
            name: failures[0].task.name,
            reason: failures[0].reason,
          }),
          type: 'error',
        })
        return
      }
      toast.add({
        title: t('panel.downloads.action.batchPartial', {
          ok: results.length - failures.length,
          failed: failures.length,
        }),
        type: 'warning',
      })
    },
    [t]
  )

  const readyToWrite = useCallback(() => {
    if (transport.platform !== 'web' || taskWritesAvailable()) return true
    toast.add({ title: t('applicationMenu.actionFailed'), type: 'error' })
    return false
  }, [t])

  const dispatchSubset = useCallback(
    async (cmd: CommandChannel, predicate: (task: DownloadTask) => boolean) => {
      if (!readyToWrite()) return
      const targets = resolveLatest(selected).filter(predicate)
      if (targets.length === 0) return
      const results = await invokeBulk(
        cmd,
        targets,
        targets.map((task) => task.id)
      )
      reportPartial(results)
    },
    [selected, reportPartial, readyToWrite]
  )

  const onPause = useCallback(
    () => dispatchSubset(Commands.PauseTasks, canPause),
    [dispatchSubset]
  )

  const onResume = useCallback(
    () => dispatchSubset(Commands.ResumeTasks, canResume),
    [dispatchSubset]
  )

  const onMove = useCallback(
    async (direction: MoveTasksPayload['direction']) => {
      if (!readyToWrite()) return
      const targets = resolveLatest(selected).filter(canMoveInQueue)
      if (moving || !targets.length) return
      setMoving(true)
      try {
        const result = moveTasksResultSchema.parse(
          await transport.invoke(Commands.MoveTasks, {
            taskIds: targets.map((task) => task.id),
            direction,
          })
        )
        if (result.failed.length) {
          reportPartial(
            toActionResults(targets, {
              succeeded: [...result.moved, ...result.unchanged],
              failed: result.failed.map((entry) => ({
                ...entry,
                reason: t(
                  entry.reason === 'not-waiting'
                    ? 'panel.downloads.action.queueTaskStarted'
                    : 'panel.downloads.action.queueMoveFailed'
                ),
              })),
            })
          )
        } else {
          toast.add({
            title: t(
              result.moved.length
                ? 'panel.downloads.action.queueMoved'
                : 'panel.downloads.action.queueBoundary'
            ),
            description: t('panel.downloads.action.queueMoveHint'),
            type: 'info',
          })
        }
      } catch {
        toast.add({
          title: t('panel.downloads.action.queueMoveFailed'),
          type: 'error',
        })
      } finally {
        setMoving(false)
      }
    },
    [selected, moving, reportPartial, t, readyToWrite]
  )

  const onStopSeeding = useCallback(
    () => dispatchSubset(Commands.StopSeedingTasks, canStopSeeding),
    [dispatchSubset]
  )

  const directReAdd = useCallback(
    (predicate: (task: DownloadTask) => boolean) =>
      dispatchSubset(Commands.ReAddTasks, predicate),
    [dispatchSubset]
  )

  const altReAddSingle = useCallback(async (task: DownloadTask) => {
    let opts: EngineTaskOptions | null = null
    try {
      opts = (await transport.invoke(
        Queries.GetEngineTaskOptions,
        task.engineTaskId
      )) as EngineTaskOptions | null
    } catch {
      opts = null
    }
    const prefill = buildPrefillFromTask(task, opts)
    await openAddTaskDialog(prefill)
    // The Alt-click flow leaves cleanup of the old record to a
    // later UX iteration — see spec §3.3 "Alt-click flow".
  }, [])

  const onReseed = useCallback(
    async (modifier?: { alt: boolean }) => {
      if (modifier?.alt && selected.length === 1 && canReseed(selected[0])) {
        await altReAddSingle(selected[0])
        return
      }
      await directReAdd(canReseed)
    },
    [selected, altReAddSingle, directReAdd]
  )

  const onRetry = useCallback(
    async (modifier?: { alt: boolean }) => {
      if (!readyToWrite()) return
      const targets = resolveLatest(selected)
      const parameterTargets = targets.filter(
        (task) =>
          canRetryWithParameters(task) &&
          (!canAttemptRetry(task) || modifier?.alt)
      )
      if (parameterTargets.length) {
        if (!useRetryParametersStore.getState().openWith(parameterTargets))
          return
        const parameterIds = new Set(parameterTargets.map((task) => task.id))
        await dispatchSubset(
          Commands.RetryTasks,
          (task) => canAttemptRetry(task) && !parameterIds.has(task.id)
        )
        return
      }
      const retryKind = targets[0] ? getTaskRetryKind(targets[0]) : null
      if (
        modifier?.alt &&
        targets.length === 1 &&
        (retryKind === 'torrent-readd' || retryKind === 'direct-readd')
      ) {
        await altReAddSingle(targets[0])
        return
      }
      await dispatchSubset(Commands.RetryTasks, canAttemptRetry)
    },
    [selected, altReAddSingle, dispatchSubset, readyToWrite]
  )

  const checkFileExists = useCallback(
    async (task: DownloadTask): Promise<boolean> => {
      try {
        const res = (await transport.invoke(Queries.CheckTaskFileExists, {
          taskId: task.id,
        })) as { exists: boolean }
        return Boolean(res?.exists)
      } catch {
        return false
      }
    },
    []
  )

  const executeRedownload = useCallback(
    async (task: DownloadTask) => {
      // Check whether the original task can be replayed from its URI alone.
      const primary = task.instances.find(
        (instance) => instance.phase === TaskInstancePhase.HttpDownload
      )
      const isUriOnly = primary ? isUriOnlyDirectReplay(primary.payload) : true

      let opts: EngineTaskOptions | null = null
      try {
        opts = (await transport.invoke(
          Queries.GetEngineTaskOptions,
          task.engineTaskId
        )) as EngineTaskOptions | null
      } catch {
        opts = null
      }

      // Let the user restore credentials when the engine no longer has them.
      if (!isUriOnly && !opts) {
        toast.add({
          title: t('panel.downloads.action.redownloadCredentialsExpired'),
          type: 'warning',
        })
        await altReAddSingle(task)
        return
      }

      try {
        const prefill = buildPrefillFromTask(task, opts)
        const requests = formValuesToTaskCreateRequests(
          prefill as AddTaskFormValues
        )
        for (const req of requests) {
          await transport.invoke(Commands.CreateTask, req)
        }
        invalidateTaskList()
        toast.add({
          title: t('panel.downloads.action.redownloadStarted'),
          type: 'success',
        })
      } catch (err) {
        toast.add({
          title: t('panel.downloads.action.singleTaskFailed', {
            name: task.name,
            reason: errMsg(err),
          }),
          type: 'error',
        })
      }
    },
    [altReAddSingle, t]
  )

  const onRedownload = useCallback(
    async (modifier?: { alt: boolean }) => {
      if (!readyToWrite()) return
      const targets = resolveLatest(selected).filter(canRedownload)
      if (!targets.length) return
      const task = targets[0]

      // Alt-click opens the task dialog for editing before re-downloading.
      if (modifier?.alt) {
        await altReAddSingle(task)
        return
      }

      // A regular click first checks whether the destination still exists.
      const exists = await checkFileExists(task)
      if (exists) {
        useRedownloadOverwriteStore.setState({
          open: true,
          target: task,
          busy: false,
        })
        return
      }

      // Start immediately when the output file is missing.
      await executeRedownload(task)
    },
    [selected, readyToWrite, altReAddSingle, checkFileExists, executeRedownload]
  )

  const confirmRedownloadOverwrite = useCallback(async () => {
    const target = useRedownloadOverwriteStore.getState().target
    if (!target) return
    useRedownloadOverwriteStore.setState({ busy: true })
    try {
      await executeRedownload(target)
    } finally {
      useRedownloadOverwriteStore.setState({
        open: false,
        target: null,
        busy: false,
      })
    }
  }, [executeRedownload])

  const closeRedownloadOverwriteDialog = useCallback(() => {
    if (!useRedownloadOverwriteStore.getState().busy) {
      useRedownloadOverwriteStore.setState({
        open: false,
        target: null,
        busy: false,
      })
    }
  }, [])

  const onRemove = useCallback(
    (modifier?: { shift: boolean }) => {
      if (useRemoveTasksStore.getState().busy || !readyToWrite()) return
      const targets = resolveLatest(selected).filter(canRemove)
      if (!targets.length) return
      useRemoveTasksStore.setState({
        targets,
        open: true,
        preCheckDeleteFiles: modifier?.shift ?? false,
      })
    },
    [selected, readyToWrite]
  )

  const closeRemoveDialog = useCallback(() => {
    if (!useRemoveTasksStore.getState().busy)
      useRemoveTasksStore.setState({
        open: false,
        preCheckDeleteFiles: false,
        targets: [],
      })
  }, [])

  const confirmRemove = useCallback(
    async (deleteFiles: boolean) => {
      if (useRemoveTasksStore.getState().busy || !readyToWrite()) return
      useRemoveTasksStore.setState({ busy: true })
      const targets = resolveLatest(removeTargets).filter(canRemove)
      if (targets.length > 0) {
        const results = await invokeBulk(Commands.RemoveTasks, targets, {
          taskIds: targets.map((task) => task.id),
          deleteWithFiles: deleteFiles,
        })
        if (useRemoveTasksStore.getState().targets !== removeTargets) return
        reportPartial(results)
      }
      useRemoveTasksStore.setState({
        open: false,
        preCheckDeleteFiles: false,
        targets: [],
        busy: false,
      })
    },
    [removeTargets, reportPartial, readyToWrite]
  )

  return {
    ...counts,
    moving,
    onMove,
    removeDialog,
    removeTargets,
    onPause,
    onResume,
    onStopSeeding,
    onReseed,
    onRetry,
    onRedownload,
    closeRedownloadOverwriteDialog,
    confirmRedownloadOverwrite,
    onRemove,
    closeRemoveDialog,
    confirmRemove,
  }
}
