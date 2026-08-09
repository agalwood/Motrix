import {
  clearStoppedTasks,
  moveTask,
  pauseAllTasks,
  pauseTask,
  removeTask,
  resumeAllTasks,
  resumeTask,
} from '@core/task/actions'
import { CommandIds } from '@shared/commands-catalog'
import { TaskStatus } from '@shared/types/task'
import type { CommandRegistry } from '../command-registry'
import type { CommandDeps } from '../types'
import { and, ctxEq, ctxIn, ctxTrue, not } from '../when'

export function registerTaskCommands(
  registry: CommandRegistry,
  _deps: CommandDeps
): void {
  registry.register({
    id: CommandIds.TaskNew,
    title: 'menu.task.newTask',
    run: ({ deps }) => {
      deps.windowManager.show('add-task', { mode: 'links' })
    },
  })

  registry.register({
    id: CommandIds.TaskNewBt,
    title: 'menu.task.newBtTask',
    run: ({ deps }) => {
      deps.windowManager.show('add-task', { mode: 'torrent' })
    },
  })

  registry.register({
    id: CommandIds.TaskOpenFile,
    title: 'menu.task.openFile',
    run: async ({ deps }) => {
      const { dialog } = await import('electron')
      const result = await dialog.showOpenDialog({
        title: 'Open Torrent File',
        filters: [{ name: 'Torrent', extensions: ['torrent'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return
      deps.protocolManager.handleTorrentFile(result.filePaths[0])
    },
  })

  registry.register({
    id: CommandIds.TaskPause,
    title: 'menu.task.pauseTask',
    precondition: and(
      ctxTrue('taskSelected'),
      ctxIn('selectedTaskStatus', [
        TaskStatus.Downloading,
        TaskStatus.FetchingMetadata,
      ])
    ),
    run: async ({ deps, menuContext }) => {
      const id = menuContext.selectedTaskId
      if (!id) return
      await pauseTask(id, deps)
    },
  })

  registry.register({
    id: CommandIds.TaskResume,
    title: 'menu.task.resumeTask',
    precondition: and(
      ctxTrue('taskSelected'),
      ctxEq('selectedTaskStatus', TaskStatus.Paused)
    ),
    run: async ({ deps, menuContext }) => {
      const id = menuContext.selectedTaskId
      if (!id) return
      await resumeTask(id, deps)
    },
  })

  registry.register({
    id: CommandIds.TaskDelete,
    title: 'menu.task.deleteTask',
    precondition: ctxTrue('taskSelected'),
    run: async ({ deps, menuContext }) => {
      const id = menuContext.selectedTaskId
      if (!id) return
      // Menu/palette delete defaults to keeping files on disk; the
      // renderer-side delete dialog (Task 19) will surface the
      // `deleteWithFiles=true` path when the user explicitly opts in.
      await removeTask(
        id,
        { deleteWithFiles: false },
        { ...deps, db: deps.motrixDatabase }
      )
    },
  })

  registry.register({
    id: CommandIds.TaskMoveUp,
    title: 'menu.task.moveTaskUp',
    precondition: and(
      ctxTrue('taskSelected'),
      not(ctxTrue('selectedTaskAtTop'))
    ),
    run: async ({ deps, menuContext }) => {
      const id = menuContext.selectedTaskId
      if (!id) return
      await moveTask(id, 'up', deps)
    },
  })

  registry.register({
    id: CommandIds.TaskMoveDown,
    title: 'menu.task.moveTaskDown',
    precondition: and(
      ctxTrue('taskSelected'),
      not(ctxTrue('selectedTaskAtBottom'))
    ),
    run: async ({ deps, menuContext }) => {
      const id = menuContext.selectedTaskId
      if (!id) return
      await moveTask(id, 'down', deps)
    },
  })

  registry.register({
    id: CommandIds.TaskPauseAll,
    title: 'menu.task.pauseAllTask',
    precondition: ctxTrue('hasAnyActiveTask'),
    run: async ({ deps }) => {
      await pauseAllTasks(deps)
    },
  })

  registry.register({
    id: CommandIds.TaskResumeAll,
    title: 'menu.task.resumeAllTask',
    precondition: ctxTrue('hasAnyPausedTask'),
    run: async ({ deps }) => {
      await resumeAllTasks(deps)
    },
  })

  registry.register({
    id: CommandIds.TaskClearStopped,
    title: 'menu.task.clearRecentTasks',
    precondition: ctxTrue('hasStoppedTasks'),
    run: async ({ deps }) => {
      await clearStoppedTasks({
        taskManager: deps.taskManager,
        adapter: deps.adapter,
        db: deps.motrixDatabase,
        taskPersistence: deps.taskPersistence,
        eventBus: deps.eventBus,
        log: deps.log,
        deleteParentTasks: deps.deleteParentTasks,
        runTaskMutation: deps.runTaskMutation,
        publishTaskUpdateNow: deps.publishTaskUpdateNow,
      })
    },
  })
}
