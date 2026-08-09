import { Notifications } from '@motrix/mdxp'
import { Events } from '@shared/protocol/events'
import type { GlobalStats } from '@shared/types/stats'
import type { DownloadTask } from '@shared/types/task'
import type { BridgeErrorCode } from './errors'
import {
  dispatchTaskUpdates,
  type TaskNotificationSink,
  taskToCompletedParams,
  taskToErrorParams,
  taskToProgressParams,
  toStatsResult,
} from './progress-mapping'

/** A sink for SSE notifications (the `WebSocketBridgeServer` implements it). */
export interface StreamBroadcaster {
  broadcastStreamEvent(event: string, data: unknown): void
}

/** The subset of the core `EventBus` this source subscribes to. */
export interface CoreEventSubscriber {
  on(event: string, listener: (payload: unknown) => void): unknown
  off(event: string, listener: (payload: unknown) => void): unknown
}

/**
 * Derives the SSE firehose ($/task/progress|completed|error + $/stats) from the
 * GLOBAL core `EventBus`.
 *
 * The bus's only reliable per-task signal is `Events.TaskUpdated`, which carries
 * the FULL task list (`taskManager.getAll()`) on every poll tick — and
 * `TaskCompleted`/`TaskFailed` are never emitted on the core bus. So the shared
 * `dispatchTaskUpdates` harness emits `$/task/progress` for each non-terminal
 * task and DERIVES `$/task/completed`/`$/task/error` from terminal status,
 * deduped. This is a client-filtered firehose (every active task each tick);
 * unlike the per-session WS push, it applies no `source` filter (watch sees ALL
 * tasks).
 */
export class BridgeStreamSource {
  private readonly terminalEmitted = new Map<string, string>()

  constructor(
    private readonly target: StreamBroadcaster,
    private readonly localize: (code: BridgeErrorCode) => string = (c) => c
  ) {}

  private readonly sink: TaskNotificationSink = {
    onProgress: (task) =>
      this.target.broadcastStreamEvent(
        Notifications.TaskProgress,
        taskToProgressParams(task)
      ),
    onCompleted: (task) =>
      this.target.broadcastStreamEvent(
        Notifications.TaskCompleted,
        taskToCompletedParams(task)
      ),
    onError: (task, code) =>
      this.target.broadcastStreamEvent(
        Notifications.TaskError,
        taskToErrorParams(task, code, this.localize(code))
      ),
  }

  private readonly handleTasks = (payload: unknown): void => {
    if (!Array.isArray(payload)) return // defensive: TaskUpdated is DownloadTask[]
    dispatchTaskUpdates(
      payload as DownloadTask[],
      this.terminalEmitted,
      this.sink
    )
  }

  private readonly handleStats = (payload: unknown): void => {
    this.target.broadcastStreamEvent(
      Notifications.StatsUpdate,
      toStatsResult(payload as GlobalStats)
    )
  }

  attach(bus: CoreEventSubscriber): void {
    bus.on(Events.TaskUpdated, this.handleTasks)
    bus.on(Events.StatsUpdated, this.handleStats)
  }

  detach(bus: CoreEventSubscriber): void {
    bus.off(Events.TaskUpdated, this.handleTasks)
    bus.off(Events.StatsUpdated, this.handleStats)
  }
}
