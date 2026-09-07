import type { EventBus } from '@core/events/event-bus'
import { AsyncWorkTracker } from '@core/inspector-activity/async-work-tracker'
import type { Logger } from '@core/logger'
import type { NotifyInput } from '@core/notifications/notification-center'
import { Events } from '@shared/protocol/events'
import type {
  MagnetFileSelectionPayload,
  TaskCreateCommandResult,
  TaskCreateRequest,
} from '@shared/schemas/add-task'
import type { MotrixAppSettings } from '@shared/types/settings'
import {
  type DownloadTask,
  TaskInstancePhase,
  TaskStatus,
} from '@shared/types/task'

interface MagnetSelectionTimeoutDeps {
  eventBus: EventBus
  getSettings: () => MotrixAppSettings
  getTasks: () => DownloadTask[]
  isEngineReady: () => boolean
  getSelection: (
    taskId: string
  ) => Promise<MagnetFileSelectionPayload | undefined>
  // Reuse the shell's CreateTask handler, including its path policy,
  // duplicate admission and serialized metadata-to-download mutation.
  createTask: (request: TaskCreateRequest) => Promise<TaskCreateCommandResult>
  notify: (input: NotifyInput) => unknown
  log: Pick<Logger, 'warn'>
  runWork?: (operation: () => Promise<void>) => Promise<void>
}

const watchedEvents = [
  Events.TaskUpdated,
  Events.SettingsChanged,
  Events.EngineStateChanged,
  Events.EngineRecovered,
] as const

function readyAt(task: DownloadTask): number {
  const timestamp = task.instances.find(
    (instance) => instance.phase === TaskInstancePhase.MagnetMetadataResolution
  )?.payload.fileSelectionReadyAt
  // Older persisted tasks predate the explicit timestamp.
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? timestamp
    : task.updatedAt
}

/** Host-owned countdowns keep working without an open renderer. */
export class MagnetSelectionTimeout {
  private readonly work = new AsyncWorkTracker()
  private readonly attempted = new Map<string, number>()
  private readonly running = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private stopped = false

  constructor(private readonly deps: MagnetSelectionTimeoutDeps) {}

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    for (const event of watchedEvents)
      this.deps.eventBus.on(event, this.refresh)
    this.refresh()
  }

  stopAndDrain(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    for (const event of watchedEvents)
      this.deps.eventBus.off(event, this.refresh)
    return this.work.stopAndDrain()
  }

  private delay(task: DownloadTask): number | undefined {
    const settings = this.deps.getSettings()
    if (
      this.stopped ||
      !settings.magnetFileSelection ||
      !settings.magnetFileSelectionAutoDownload ||
      !this.deps.isEngineReady() ||
      task.status !== TaskStatus.MetadataReady
    )
      return undefined
    return (
      readyAt(task) +
      settings.magnetFileSelectionTimeoutSeconds * 1000 -
      Date.now()
    )
  }

  private refresh = (): void => {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped) return
    const settings = this.deps.getSettings()
    if (
      !settings.magnetFileSelection ||
      !settings.magnetFileSelectionAutoDownload ||
      !this.deps.isEngineReady()
    )
      return
    const tasks = this.deps.getTasks()
    for (const [id, timestamp] of this.attempted) {
      if (
        !tasks.some(
          (task) =>
            task.id === id &&
            task.status === TaskStatus.MetadataReady &&
            readyAt(task) === timestamp
        )
      ) {
        this.attempted.delete(id)
      }
    }
    let next: DownloadTask | undefined
    let nextDelay = Infinity
    for (const task of tasks) {
      if (
        this.running.has(task.id) ||
        this.attempted.get(task.id) === readyAt(task)
      )
        continue
      const delay = this.delay(task)
      if (delay !== undefined && delay < nextDelay) {
        next = task
        nextDelay = delay
      }
    }
    if (!next) return
    const taskId = next.id
    const timestamp = readyAt(next)
    this.timer = setTimeout(
      () => {
        this.running.add(taskId)
        void this.work
          .run(() =>
            this.deps.runWork
              ? this.deps.runWork(() => this.advance(taskId, timestamp))
              : this.advance(taskId, timestamp)
          )
          .catch((error: unknown) =>
            this.deps.log.warn(
              { error, taskId },
              'Magnet selection timeout failed'
            )
          )
          .finally(() => {
            this.running.delete(taskId)
            this.refresh()
          })
        this.refresh()
      },
      Math.max(0, nextDelay)
    )
  }

  private eligibleTask(
    taskId: string,
    timestamp: number
  ): DownloadTask | undefined {
    const task = this.deps.getTasks().find((entry) => entry.id === taskId)
    if (!task || readyAt(task) !== timestamp) return undefined
    const delay = this.delay(task)
    return delay !== undefined && delay <= 0 ? task : undefined
  }

  private async advance(taskId: string, timestamp: number): Promise<void> {
    if (!this.eligibleTask(taskId, timestamp)) return
    let outcome: 'started' | 'failed' = 'failed'
    let downloadTaskId = taskId
    try {
      const selection = await this.deps.getSelection(taskId)
      // The user may confirm, remove the task, disable the option, or extend
      // the deadline while the torrent is being read from disk.
      if (!this.eligibleTask(taskId, timestamp)) return
      this.attempted.set(taskId, timestamp)
      if (selection) {
        const result = await this.deps.createTask({
          type: 'bt',
          payload: { kind: 'torrent-base64', base64: selection.torrentBase64 },
          selectedFiles: selection.meta.files.map((file) => file.index),
          saveDir: selection.saveDir,
          displayName: selection.meta.name || undefined,
          existingTaskId: taskId,
        })
        if (result.outcome !== 'conflict') {
          outcome = 'started'
          downloadTaskId = result.taskId
        }
      }
    } catch (error) {
      if (!this.eligibleTask(taskId, timestamp)) return
      this.attempted.set(taskId, timestamp)
      this.deps.log.warn(
        { error, taskId },
        'Could not automatically select magnet files'
      )
    }
    if (this.stopped) return
    if (outcome === 'started') {
      this.deps.eventBus.emit(Events.MagnetFileSelectionSettled, {
        taskId,
        downloadTaskId,
      })
    } else if (!this.eligibleTask(taskId, timestamp)) {
      return
    }
    this.deps.notify({
      sourceKey: `magnet-selection-timeout:${taskId}:${timestamp}:${outcome}`,
      kind: 'magnet-selection-timeout',
      severity: outcome === 'started' ? 'info' : 'warning',
      titleKey: `task.add.selectionTimeout.${outcome}`,
      titleParams: {
        name:
          this.deps.getTasks().find((task) => task.id === downloadTaskId)
            ?.name ?? taskId,
      },
      taskId: downloadTaskId,
    })
  }
}
