import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface TaskBtDetail {
  announceList: string[][]
  magnetUri: string | null
}

export interface UseTaskBtDetailResult extends TaskBtDetail {
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
}

const EMPTY: TaskBtDetail = { announceList: [], magnetUri: null }

/**
 * One-shot fetch of the static BT detail (announce list + magnet URI) for
 * one task. These fields are projected OUT of the TaskUpdated broadcast and
 * ListTasks (option E of the emit-coalescing design — they are half the
 * bytes of a realistic full-list payload and never change between polls),
 * so single-task consumers read them on demand through the full-fat
 * GetTaskDetail query.
 *
 * REJECTS on transport failure — callers that act on the result (copy a
 * magnet link) must abort and surface the failure instead of silently
 * producing tracker-less output. A missing task resolves to the empty
 * detail: absence is data, not an error.
 */
export async function fetchTaskBtDetail(taskId: string): Promise<TaskBtDetail> {
  const task = (await transport.invoke(
    Queries.GetTaskDetail,
    taskId
  )) as DownloadTask | null
  return {
    announceList: task?.bt?.announceList ?? [],
    magnetUri: task?.bt?.magnetUri ?? null,
  }
}

/**
 * Render-time variant of {@link fetchTaskBtDetail} with an explicit
 * loading / error / data model — an unready or failed query must not be
 * indistinguishable from a genuinely tracker-less task. Re-queries when
 * `taskId` OR `engineTaskId` changes (re-add and the magnet→BT metadata
 * swap keep the public id but replace the engine generation, which is when
 * the seed announce list appears). Pass a null taskId to skip fetching.
 */
export function useTaskBtDetail(
  taskId: string | null,
  engineTaskId?: string
): UseTaskBtDetailResult {
  const [detail, setDetail] = useState<TaskBtDetail>(EMPTY)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // Monotonic token: only the LATEST request may commit any state. A shared
  // boolean cancel flag is not enough — the next effect run resets it, so a
  // stale in-flight response for the previous task/generation could still
  // land and overwrite the current detail (or clear its loading early).
  const requestIdRef = useRef(0)
  // The task/generation this hook is CURRENTLY keyed on. The token alone
  // cannot stop a stale `refresh` closure (captured across an await or a
  // setTimeout, then invoked after a task switch): calling it would mint a
  // NEWER token and commit the old task's detail into the current one.
  const currentKeyRef = useRef({ taskId, engineTaskId })

  // engineTaskId is deliberately part of the dependency key: same public
  // id, new engine generation → the static detail may have just
  // materialized (re-add, magnet→BT swap).
  const load = useCallback(async () => {
    if (
      taskId !== currentKeyRef.current.taskId ||
      engineTaskId !== currentKeyRef.current.engineTaskId
    ) {
      return
    }
    const requestId = ++requestIdRef.current
    if (!taskId) {
      setDetail(EMPTY)
      setIsLoading(false)
      setError(null)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const next = await fetchTaskBtDetail(taskId)
      if (requestIdRef.current === requestId) setDetail(next)
    } catch (e) {
      if (requestIdRef.current === requestId) {
        setError(e instanceof Error ? e : new Error(String(e)))
        setDetail(EMPTY)
      }
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false)
    }
  }, [taskId, engineTaskId])

  useEffect(() => {
    const key = currentKeyRef.current
    if (key.taskId !== taskId || key.engineTaskId !== engineTaskId) {
      currentKeyRef.current = { taskId, engineTaskId }
      // Key changed: the previous task's announce baseline must not stay
      // around to classify the new task's effective trackers while its
      // request is in flight.
      setDetail(EMPTY)
      setError(null)
    }
    void load()
    return () => {
      // Invalidate any in-flight request on key change or unmount.
      requestIdRef.current += 1
    }
  }, [load, taskId, engineTaskId])

  return { ...detail, isLoading, error, refresh: load }
}
