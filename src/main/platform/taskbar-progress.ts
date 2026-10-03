import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { getDownloadProgress } from '@shared/utils/media-progress'
import type { WindowManager } from '../window/window-manager'

type ProgressBarMode = 'normal' | 'paused' | 'error' | 'indeterminate' | 'none'

/**
 * Windows taskbar progress for the main window — the colored fill/underline
 * under the app's taskbar icon. Driven by the coalesced TaskUpdated snapshot
 * (1 Hz while the engine is active, 10 s idle). The aggregate is the
 * byte-weighted ratio across in-flight downloads; tasks without a known
 * size fall back to their own progress fraction, and an all-unknown mix
 * renders as an indeterminate bar. Cleared when nothing is in flight.
 *
 * No opt-out: the bar mirrors state that the Downloads list already shows,
 * and Windows clears it on its own whenever the main window has no taskbar
 * button (hidden to tray, released in lightweight mode).
 */
export function setupTaskbarProgress(deps: {
  eventBus: EventBus
  windowManager: Pick<WindowManager, 'get'>
}): () => void {
  if (process.platform !== 'win32') return () => {}

  const log = getLogger('taskbar-progress')
  let lastApplied: number | null = null

  const onTaskUpdated = (snapshot: unknown) => {
    const win = deps.windowManager.get('main')
    if (!win || win.isDestroyed()) return
    if (!Array.isArray(snapshot)) return

    let knownTotal = 0
    let knownDone = 0
    let unknownCount = 0
    let unknownProgressSum = 0
    let inFlight = 0

    for (const task of snapshot as DownloadTask[]) {
      if (task.status !== TaskStatus.Downloading) continue
      inFlight++
      if (task.totalBytes > 0) {
        knownTotal += task.totalBytes
        knownDone += Math.min(task.downloadedBytes, task.totalBytes)
      } else {
        const progress = getDownloadProgress(task)
        if (progress !== null) {
          unknownCount++
          unknownProgressSum += progress
        }
      }
    }

    if (inFlight === 0) {
      if (lastApplied !== null) {
        lastApplied = null
        win.setProgressBar(-1)
      }
      return
    }

    let value: number
    let mode: ProgressBarMode = 'normal'
    if (knownTotal > 0) {
      value = Math.min(Math.max(knownDone / knownTotal, 0), 1)
    } else if (unknownCount > 0) {
      value = unknownProgressSum / unknownCount
    } else {
      value = 0
      mode = 'indeterminate'
    }
    if (mode === 'normal' && value === lastApplied) return
    lastApplied = mode === 'normal' ? value : null
    try {
      win.setProgressBar(value, { mode })
    } catch (error) {
      log.warn({ err: error }, 'setProgressBar failed')
    }
  }

  deps.eventBus.on(Events.TaskUpdated, onTaskUpdated)
  return () => deps.eventBus.off(Events.TaskUpdated, onTaskUpdated)
}
