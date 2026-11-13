import type { EngineAdapter } from '@core/engine/engine-adapter'
import { torrentSelectionSchema } from '@shared/schemas/torrent-selection'
import { type DownloadTask, TaskStatus } from '@shared/types/task'

export function hasPendingTorrentSelection(
  task: Pick<DownloadTask, 'instances'>
): boolean {
  return task.instances.some(
    (instance) => instance.payload.pendingTorrentSelection !== undefined
  )
}

/** The intent is already durable. Replaying the same confirmation never adds a task. */
export async function confirmPendingTorrentSelection(
  task: DownloadTask,
  adapter: EngineAdapter
): Promise<DownloadTask> {
  const instance = task.instances.find(
    (item) => item.payload.pendingTorrentSelection !== undefined
  )
  if (!instance) return task
  const selection = torrentSelectionSchema.parse(
    instance.payload.pendingTorrentSelection
  )
  await adapter.confirmTorrentSelection(task.engineTaskId, selection)
  return {
    ...task,
    status: TaskStatus.Downloading,
    updatedAt: Date.now(),
    instances: task.instances.map((item) => {
      if (item !== instance) return item
      const { pendingTorrentSelection: _, ...payload } = item.payload
      return { ...item, status: TaskStatus.Downloading, payload }
    }),
  }
}
