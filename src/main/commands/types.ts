import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EventBus } from '@core/events/event-bus'
import type { Logger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { SessionManager } from '@core/session/session-manager'
import type { SettingsManager } from '@core/settings/settings-manager'
import type {
  TaskActionDeps,
  TaskTransitionRecordInput,
} from '@core/task/actions/shared'
import type { FileCleanupService } from '@core/task/file-cleanup-service'
import type { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import type { TaskManager } from '@core/task/task-manager'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import type { MagnetTracker } from '@core/torrent/magnet-tracker'
import type { MenuContext } from '@shared/types/menu-context'
import type { UpdateManager } from '../core/update-manager'
import type { createProtocolManager } from '../platform/protocol-manager'
import type { WindowManager } from '../window/window-manager'
import type { WhenExpr } from './when'

export interface CommandDeps {
  taskManager: TaskManager
  settingsManager: SettingsManager
  adapter: EngineAdapter
  windowManager: WindowManager
  eventBus: EventBus
  log: Logger
  updateManager: UpdateManager
  protocolManager: ReturnType<typeof createProtocolManager>
  fileCleanupService: FileCleanupService
  torrentMetaStore: TorrentMetaStore
  motrixDatabase: MotrixDatabase
  taskPersistence: Pick<SessionManager, 'runExclusivePersistence'>
  magnetTracker: MagnetTracker
  persistTask: NonNullable<TaskActionDeps['persistTask']>
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction — used INSTEAD OF `persistTask` whenever a status
   * transition qualifies for one. Optional; absence degrades pauseTask/
   * resumeTask (menu-triggered) to plain `persistTask` (no occurrence).
   */
  persistTaskWithOccurrence?: TaskActionDeps['persistTaskWithOccurrence']
  /** Delivers a just-committed terminal occurrence to in-process consumers. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  recordTransition: (input: TaskTransitionRecordInput) => void | Promise<void>
  deleteParentTasks: NonNullable<TaskActionDeps['deleteParentTasks']>
  runTaskMutation: NonNullable<TaskActionDeps['runTaskMutation']>
  /** Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher). */
  publishTaskUpdate: TaskActionDeps['publishTaskUpdate']
  publishTaskUpdateNow: TaskActionDeps['publishTaskUpdateNow']
}

export interface CommandExecContext<TArgs = void> {
  menuContext: Readonly<MenuContext>
  args: TArgs
  deps: CommandDeps
}

export interface Command<TArgs = void> {
  id: string
  title: string
  description?: string
  precondition?: WhenExpr
  run(ctx: CommandExecContext<TArgs>): void | Promise<void>
  source?: 'builtin' | 'plugin'
  ownerId?: string
  pluginSafe?: boolean
}
