import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  parseTaskInspectorActivitySnapshot,
  parseTaskInspectorActivityUpdate,
} from '@shared/schemas/task-inspector-activity'
import type {
  GetTaskInspectorActivityParams,
  TaskInspectorActivitySnapshot,
} from '@shared/types/task-inspector-activity'
import { useEffect, useState } from 'react'

export type TaskInspectorActivityState =
  | { status: 'loading'; snapshot: null }
  | { status: 'ready'; snapshot: TaskInspectorActivitySnapshot }
  | {
      status: 'stale'
      snapshot: TaskInspectorActivitySnapshot
      retry: () => void
    }
  | { status: 'unavailable'; snapshot: null; retry: () => void }

interface InternalState {
  taskId: string | null
  value: TaskInspectorActivityState
}

const LOADING: TaskInspectorActivityState = {
  status: 'loading',
  snapshot: null,
}

export interface TaskInspectorActivitySnapshotCache {
  get(taskId: string): TaskInspectorActivitySnapshot | undefined
  set(taskId: string, snapshot: TaskInspectorActivitySnapshot): void
}

const MAX_CACHED_ACTIVITY_TASKS = 16

export function createTaskInspectorActivitySnapshotCache(): TaskInspectorActivitySnapshotCache {
  const snapshots = new Map<string, TaskInspectorActivitySnapshot>()
  return {
    get(taskId) {
      const snapshot = snapshots.get(taskId)
      if (!snapshot) return undefined
      snapshots.delete(taskId)
      snapshots.set(taskId, snapshot)
      return snapshot
    },
    set(taskId, snapshot) {
      if (snapshot.taskId !== taskId) return
      snapshots.delete(taskId)
      snapshots.set(taskId, snapshot)
      while (snapshots.size > MAX_CACHED_ACTIVITY_TASKS) {
        const oldestTaskId = snapshots.keys().next().value
        if (oldestTaskId === undefined) break
        snapshots.delete(oldestTaskId)
      }
    },
  }
}

export function useTaskInspectorActivity(
  taskId: string | null,
  snapshotCache?: TaskInspectorActivitySnapshotCache
): TaskInspectorActivityState {
  const [state, setState] = useState<InternalState>({
    taskId: null,
    value: LOADING,
  })

  useEffect(() => {
    if (!taskId) {
      setState({ taskId: null, value: LOADING })
      return
    }

    const activeTaskId = taskId
    let disposed = false
    let inFlight: Promise<void> | null = null
    let trailingRefresh = false
    let lastGood =
      parseTaskInspectorActivitySnapshot(
        snapshotCache?.get(activeTaskId),
        activeTaskId
      ) ?? null

    const retry = () => {
      void refresh()
    }

    const publishFailure = () => {
      if (disposed) return
      setState({
        taskId: activeTaskId,
        value: lastGood
          ? { status: 'stale', snapshot: lastGood, retry }
          : { status: 'unavailable', snapshot: null, retry },
      })
    }

    function refresh(): Promise<void> {
      if (disposed) return Promise.resolve()
      if (inFlight) {
        trailingRefresh = true
        return inFlight
      }

      const params: GetTaskInspectorActivityParams = {
        taskId: activeTaskId,
      }
      const request = transport
        .invoke(Queries.GetTaskInspectorActivity, params)
        .then((value) => {
          if (disposed) return
          const snapshot = parseTaskInspectorActivitySnapshot(
            value,
            activeTaskId
          )
          if (!snapshot) {
            throw new Error('task inspector activity response mismatch')
          }
          lastGood = snapshot
          snapshotCache?.set(activeTaskId, snapshot)
          setState({
            taskId: activeTaskId,
            value: { status: 'ready', snapshot },
          })
        })
        .catch(() => {
          publishFailure()
        })
        .finally(() => {
          if (inFlight !== request) return
          inFlight = null
          if (!disposed && trailingRefresh) {
            trailingRefresh = false
            void refresh()
          }
        })

      inFlight = request
      return request
    }

    const onActivityUpdated = (...args: unknown[]) => {
      const payload = parseTaskInspectorActivityUpdate(args[0])
      if (!payload || payload.taskId !== activeTaskId) return
      if (lastGood && payload.revision <= lastGood.revision) return
      void refresh()
    }

    const stopConnectionListener = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') void refresh()
    })

    setState({ taskId: activeTaskId, value: LOADING })
    transport.on(Events.TaskInspectorActivityUpdated, onActivityUpdated)
    void refresh()

    return () => {
      disposed = true
      transport.off(Events.TaskInspectorActivityUpdated, onActivityUpdated)
      stopConnectionListener?.()
    }
  }, [snapshotCache, taskId])

  return state.taskId === taskId ? state.value : LOADING
}
