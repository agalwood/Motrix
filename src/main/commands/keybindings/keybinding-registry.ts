import type { CommandId } from '@shared/commands-catalog'
import { DEFAULT_KEYBINDINGS } from '@shared/keybindings-catalog'

export class KeybindingRegistry {
  private byCommand: Map<CommandId, string>

  constructor() {
    this.byCommand = new Map(
      DEFAULT_KEYBINDINGS.map((k) => [k.commandId, k.accelerator])
    )
  }

  forCommand(id: CommandId): string | undefined {
    return this.byCommand.get(id)
  }
}
