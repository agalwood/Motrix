import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  findTaskSpeedUpdate,
  parseTaskSpeedHistory,
  type TaskSpeedUpdate,
} from '@shared/schemas/task-inspector-activity'
import type { SpeedPoint } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import { useEffect, useState } from 'react'

const MAX_POINTS = 60
const RECORDING_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])

interface HistoryState {
  taskId: string | null
  history: readonly SpeedPoint[]
  isLoading: boolean
}

interface PendingSpeedUpdate {
  at: number
  update: TaskSpeedUpdate
}

function cap(points: readonly SpeedPoint[]): readonly SpeedPoint[] {
  return points.length > MAX_POINTS ? points.slice(-MAX_POINTS) : points
}

function capPending(
  updates: readonly PendingSpeedUpdate[]
): PendingSpeedUpdate[] {
  return updates.length > MAX_POINTS ? updates.slice(-MAX_POINTS) : [...updates]
}

export function useTaskSpeedHistory(taskId: string | null) {
  const [state, setState] = useState<HistoryState>({
    taskId: null,
    history: [],
    isLoading: false,
  })

  useEffect(() => {
    if (!taskId) {
      setState({ taskId: null, history: [], isLoading: false })
      return
    }

    let cancelled = false
    let hydrating = true
    let recording = false
    let pending: PendingSpeedUpdate[] = []
    setState({ taskId, history: [], isLoading: true })

    const acceptUpdate = (
      pendingUpdate: PendingSpeedUpdate
    ): SpeedPoint | null => {
      const isRecording = RECORDING_STATUSES.has(pendingUpdate.update.status)
      if (!isRecording && !recording) return null
      recording = isRecording
      return {
        t: pendingUpdate.at,
        down: isRecording ? pendingUpdate.update.downloadSpeed : 0,
        up: isRecording ? pendingUpdate.update.uploadSpeed : 0,
      }
    }

    const onUpdate = (...args: unknown[]) => {
      const update = findTaskSpeedUpdate(args[0], taskId)
      if (!update) return
      const pendingUpdate = { at: Date.now(), update }
      if (hydrating) {
        pending = capPending([...pending, pendingUpdate])
        return
      }
      const point = acceptUpdate(pendingUpdate)
      if (!point) return
      setState((current) => {
        if (current.taskId !== taskId) return current
        return {
          taskId,
          history: cap([...current.history, point]),
          isLoading: false,
        }
      })
    }

    transport.on(Events.TaskUpdated, onUpdate)
    void transport
      .invoke(Queries.GetTaskSpeedHistory, { taskId, limit: MAX_POINTS })
      .then((data) => {
        if (cancelled) return
        const hydratedHistory = parseTaskSpeedHistory(data)
        if (!hydratedHistory) {
          throw new Error('invalid task speed history response')
        }
        hydrating = false
        const lastHydratedPoint = hydratedHistory.at(-1)
        recording =
          lastHydratedPoint !== undefined &&
          (lastHydratedPoint.down > 0 || lastHydratedPoint.up > 0)
        let history: readonly SpeedPoint[] = hydratedHistory
        for (const pendingUpdate of pending) {
          const point = acceptUpdate(pendingUpdate)
          if (point) history = cap([...history, point])
        }
        setState({
          taskId,
          history,
          isLoading: false,
        })
        pending = []
      })
      .catch(() => {
        if (cancelled) return
        hydrating = false
        let history: readonly SpeedPoint[] = []
        for (const pendingUpdate of pending) {
          const point = acceptUpdate(pendingUpdate)
          if (point) history = cap([...history, point])
        }
        setState({ taskId, history, isLoading: false })
        pending = []
      })

    return () => {
      cancelled = true
      transport.off(Events.TaskUpdated, onUpdate)
    }
  }, [taskId])

  if (state.taskId !== taskId) {
    return { history: [], isLoading: taskId !== null }
  }
  return { history: state.history, isLoading: state.isLoading }
}
