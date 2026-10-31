import type { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import {
  finiteProgress,
  getDownloadProgress,
  getTransferMetrics,
  isMediaTask,
} from '@shared/utils/media-progress'
import { BaseWindow } from 'electron'

/** Progress of current transfers, excluding paused, queued and finished work. */
export function getDockProgress(tasks: readonly DownloadTask[]): number {
  let active = 0
  let totalBytes = 0
  let completedBytes = 0
  let unweightedProgress = 0
  for (const task of tasks) {
    if (
      task.storageOperation ||
      ![
        TaskStatus.Downloading,
        TaskStatus.FetchingMetadata,
        TaskStatus.Finalizing,
      ].includes(task.status)
    )
      continue
    active++
    const size = getTransferMetrics(task).bytesTotal
    const knownSize = size !== null && Number.isFinite(size) && size > 0
    const progress = finiteProgress(
      task.status === TaskStatus.FetchingMetadata
        ? 0
        : isMediaTask(task)
          ? (getDownloadProgress(task) ?? 0)
          : knownSize
            ? task.downloadedBytes / size
            : 0
    )
    unweightedProgress += progress
    if (knownSize && task.status !== TaskStatus.FetchingMetadata) {
      totalBytes += size
      completedBytes += size * progress
    }
  }
  if (!active) return -1
  // Unknown-size transfers cannot contribute byte weights. When no sizes are
  // known, media segment progress still provides a useful transfer fraction.
  const progress =
    totalBytes > 0 ? completedBytes / totalBytes : unweightedProgress / active
  // Finalization/muxing must finish before a task is done. macOS renders the
  // native indeterminate value as a full bar, so never use it for unknown work.
  return Math.min(0.99, Math.floor(finiteProgress(progress) * 1000) / 1000)
}

interface Dependencies {
  eventBus: EventBus
  getTasks(): readonly DownloadTask[]
  isEnabled(): boolean
  platform?: string
}

export function setupDockProgress(deps: Dependencies): () => void {
  if ((deps.platform ?? process.platform) !== 'darwin') return () => {}
  let window: BaseWindow | null = null
  let lastProgress = -1
  let disposed = false

  const clear = () => {
    if (window && !window.isDestroyed()) {
      window.setProgressBar(-1)
      window.destroy()
    }
    window = null
    lastProgress = -1
  }
  const update = () => {
    if (disposed) return
    const progress = deps.isEnabled() ? getDockProgress(deps.getTasks()) : -1
    if (progress < 0) {
      clear()
      return
    }
    if (!window || window.isDestroyed()) {
      // A renderer-free native window keeps the application-wide Dock progress
      // working even when lightweight mode releases every BrowserWindow.
      window = new BaseWindow({
        show: false,
        width: 1,
        height: 1,
        focusable: false,
        skipTaskbar: true,
      })
      window.excludedFromShownWindowsMenu = true
      lastProgress = -1
    }
    if (progress === lastProgress) return
    window.setProgressBar(progress)
    lastProgress = progress
  }
  deps.eventBus.on(Events.TaskUpdated, update)
  deps.eventBus.on(Events.SettingsChanged, update)
  update()
  return () => {
    disposed = true
    deps.eventBus.off(Events.TaskUpdated, update)
    deps.eventBus.off(Events.SettingsChanged, update)
    clear()
  }
}
