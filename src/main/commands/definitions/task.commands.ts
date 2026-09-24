import { pauseAllTasks, resumeAllTasks } from '@core/task/actions'
import { CommandIds } from '@shared/commands-catalog'
import { Events } from '@shared/protocol/events'
import type { CommandRegistry } from '../command-registry'
import type { CommandDeps } from '../types'
import { ctxTrue } from '../when'

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

  const selectionCommands = [
    [CommandIds.TaskPause, 'menu.task.pauseTask', 'selectedCanPause'],
    [CommandIds.TaskResume, 'menu.task.resumeTask', 'selectedCanResume'],
    [CommandIds.TaskDelete, 'menu.task.deleteTask', 'selectedCanRemove'],
    [CommandIds.TaskMoveUp, 'menu.task.moveTaskUp', 'selectedCanMove'],
    [CommandIds.TaskMoveDown, 'menu.task.moveTaskDown', 'selectedCanMove'],
  ] as const
  for (const [id, title, predicate] of selectionCommands) {
    registry.register({
      id,
      title,
      precondition: (context) => context[predicate] === true,
      run: ({ deps, menuContext }) => {
        deps.windowManager
          .get('main')
          ?.webContents.send(Events.RendererTaskMenuRequested, {
            commandId: id,
            taskIds: menuContext.selectedTaskIds ?? [],
            generation: menuContext.selectedTaskGeneration ?? 0,
          })
      },
    })
  }

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
    id: CommandIds.TaskSelectAll,
    title: 'menu.task.selectAllTask',
    precondition: ({ currentRoute }) =>
      currentRoute === '/downloads' || currentRoute.startsWith('/downloads/'),
    run: ({ deps }) => {
      deps.windowManager.get('main')?.webContents.send(Events.TaskSelectAll)
    },
  })

  registry.register({
    id: CommandIds.TaskClearStopped,
    title: 'menu.task.clearRecentTasks',
    precondition: ctxTrue('hasStoppedTasks'),
    run: ({ deps, menuContext }) => {
      deps.windowManager
        .get('main')
        ?.webContents.send(Events.RendererTaskMenuRequested, {
          commandId: CommandIds.TaskClearStopped,
          taskIds: [],
          generation: menuContext.selectedTaskGeneration ?? 0,
        })
    },
  })
}
