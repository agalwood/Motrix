import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { DownloadTask } from '@shared/types/task'
import type { BridgeErrorCode } from './errors'
import {
  taskToCompletedParams,
  taskToErrorParams,
  taskToProgressParams,
} from './progress-mapping'

/**
 * Translates Motrix-domain DownloadTask events into wire-shape
 * BridgeEventBus emissions. Only bridge-sourced tasks are forwarded;
 * user/plugin-sourced tasks are ignored at the publisher level so the
 * filter is centralized. The pure field mapping lives in `progress-mapping.ts`
 * (shared with the SSE firehose); this class adds the source filter +
 * per-session routing.
 *
 * `localize(code)` provides the i18n'd message for TaskError.
 */
export class ProgressPublisher {
  constructor(
    private readonly bus: BridgeEventBus,
    private readonly localize: (code: BridgeErrorCode) => string = (c) => c
  ) {}

  onTaskUpdated(task: DownloadTask): void {
    if (task.source !== 'bridge' || !task.sourceMeta) return
    this.bus.emitTaskProgress({
      sessionKey: task.sourceMeta.sessionKey,
      params: taskToProgressParams(task),
    })
  }

  onTaskCompleted(task: DownloadTask): void {
    if (task.source !== 'bridge' || !task.sourceMeta) return
    this.bus.emitTaskCompleted({
      sessionKey: task.sourceMeta.sessionKey,
      params: taskToCompletedParams(task),
    })
  }

  onTaskFailed(task: DownloadTask, code: BridgeErrorCode): void {
    if (task.source !== 'bridge' || !task.sourceMeta) return
    this.bus.emitTaskError({
      sessionKey: task.sourceMeta.sessionKey,
      params: taskToErrorParams(task, code, this.localize(code)),
    })
  }
}
