import { CommandIds } from '@shared/commands-catalog'
import { Events } from '@shared/protocol/events'
import type { CommandRegistry } from '../command-registry'
import type { CommandDeps } from '../types'

export function registerAppCommands(
  registry: CommandRegistry,
  _deps: CommandDeps
): void {
  registry.register({
    id: CommandIds.AppShowAbout,
    title: 'menu.app.about',
    run: ({ deps }) => {
      deps.windowManager.show('main')
      deps.eventBus.emit(Events.NavigateTo, '/settings/about')
    },
  })

  registry.register({
    id: CommandIds.AppOpenPreferences,
    title: 'menu.app.preferences',
    run: ({ deps }) => {
      deps.windowManager.show('main')
      deps.eventBus.emit(Events.NavigateTo, '/settings')
    },
  })

  registry.register({
    id: CommandIds.AppCheckForUpdates,
    title: 'menu.app.checkForUpdates',
    run: async ({ deps }) => {
      deps.windowManager.show('main')
      deps.eventBus.emit(Events.NavigateTo, '/settings/about')
      // The About page already explains why updates are unavailable;
      // checking anyway would only log a rejected command.
      if (deps.updateManager.getState().phase !== 'unsupported') {
        await deps.updateManager.check()
      }
    },
  })

  registry.register({
    id: CommandIds.AppShowMain,
    title: 'menu.app.show',
    run: ({ deps }) => {
      deps.windowManager.show('main')
    },
  })
  // AppQuit is an Electron role; no command registration.
}
