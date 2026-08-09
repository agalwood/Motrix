import { CommandIds } from '@shared/commands-catalog'
import { Events } from '@shared/protocol/events'
import type { CommandRegistry } from '../command-registry'
import type { CommandDeps } from '../types'

export function registerNavigationCommands(
  registry: CommandRegistry,
  _deps: CommandDeps
): void {
  registry.register({
    id: CommandIds.NavigateTaskList,
    title: 'menu.task.taskList',
    run: ({ deps }) => {
      deps.windowManager.show('main')
      deps.eventBus.emit(Events.NavigateTo, '/downloads')
    },
  })
}
