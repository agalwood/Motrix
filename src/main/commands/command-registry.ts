import type { MenuContext } from '@shared/types/menu-context'
import type { Command, CommandExecContext } from './types'

export class CommandRegistry {
  private commands = new Map<string, Command<unknown>>()

  register<T>(cmd: Command<T>): void {
    if (this.commands.has(cmd.id)) {
      throw new Error(`Command already registered: ${cmd.id}`)
    }
    this.commands.set(cmd.id, cmd as Command<unknown>)
  }

  get(id: string): Command<unknown> | undefined {
    return this.commands.get(id)
  }

  list(): readonly Command<unknown>[] {
    return [...this.commands.values()]
  }

  canExecute(id: string, ctx: Readonly<MenuContext>): boolean {
    const cmd = this.commands.get(id)
    if (!cmd) return false
    if (!cmd.precondition) return true
    return cmd.precondition(ctx)
  }

  async execute<T>(
    id: string,
    args: T,
    execCtx: Omit<CommandExecContext<T>, 'args'>
  ): Promise<void> {
    const cmd = this.commands.get(id)
    if (!cmd) return
    if (!this.canExecute(id, execCtx.menuContext)) return
    try {
      await (cmd as Command<T>).run({ ...execCtx, args })
    } catch (err) {
      execCtx.deps.log.error({ err: String(err), id }, 'command failed')
    }
  }
}
