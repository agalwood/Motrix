import type { SpeedPoint } from '@shared/types/stats'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

export const TASK_SPEED_HISTORY_MAX_POINTS = 60

const RECORDING_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])

export class TaskSpeedHistoryStore {
  private readonly buffers = new Map<string, SpeedPoint[]>()
  private readonly recording = new Set<string>()

  append(tasks: readonly DownloadTask[]): void {
    const presentIds = new Set(tasks.map((task) => task.id))

    for (const task of tasks) {
      if (RECORDING_STATUSES.has(task.status)) {
        this.appendPoint(task.id, {
          t: Date.now(),
          down: task.downloadSpeed,
          up: task.uploadSpeed,
        })
        this.recording.add(task.id)
        continue
      }

      if (this.recording.delete(task.id)) {
        this.appendPoint(task.id, { t: Date.now(), down: 0, up: 0 })
      }
    }

    for (const taskId of this.buffers.keys()) {
      if (!presentIds.has(taskId)) {
        this.buffers.delete(taskId)
        this.recording.delete(taskId)
      }
    }
  }

  snapshot(
    taskId: string,
    limit = TASK_SPEED_HISTORY_MAX_POINTS
  ): readonly SpeedPoint[] {
    const buffer = this.buffers.get(taskId) ?? []
    const count = Math.max(0, Math.floor(limit))
    if (count === 0) return []
    const points = count >= buffer.length ? buffer : buffer.slice(-count)
    return points.map((point) => ({ ...point }))
  }

  clear(): void {
    this.buffers.clear()
    this.recording.clear()
  }

  private appendPoint(taskId: string, point: SpeedPoint): void {
    const buffer = this.buffers.get(taskId) ?? []
    buffer.push(point)
    if (buffer.length > TASK_SPEED_HISTORY_MAX_POINTS) {
      buffer.splice(0, buffer.length - TASK_SPEED_HISTORY_MAX_POINTS)
    }
    this.buffers.set(taskId, buffer)
  }
}
