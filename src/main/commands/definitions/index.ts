import type { CommandRegistry } from '../command-registry'
import type { CommandDeps } from '../types'
import { registerAppCommands } from './app.commands'
import { registerHelpCommands } from './help.commands'
import { registerNavigationCommands } from './navigation.commands'
import { registerTaskCommands } from './task.commands'

export function registerAllCommands(
  registry: CommandRegistry,
  deps: CommandDeps
): void {
  registerAppCommands(registry, deps)
  registerTaskCommands(registry, deps)
  registerNavigationCommands(registry, deps)
  registerHelpCommands(registry, deps)
}
