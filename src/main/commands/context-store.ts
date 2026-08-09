import type { MenuContext } from '@shared/types/menu-context'
import { DEFAULT_MENU_CONTEXT } from './menu-context'

export type ContextListener = (ctx: Readonly<MenuContext>) => void

export class ContextStore {
  private ctx: MenuContext = { ...DEFAULT_MENU_CONTEXT }
  private listeners = new Set<ContextListener>()

  get(): Readonly<MenuContext> {
    return this.ctx
  }

  merge(patch: Partial<MenuContext>): void {
    let changed = false
    const next: MenuContext = { ...this.ctx }
    for (const [k, v] of Object.entries(patch) as [
      keyof MenuContext,
      MenuContext[keyof MenuContext] | undefined,
    ][]) {
      if (v === undefined) continue
      if (next[k] !== v) {
        ;(next as unknown as Record<string, unknown>)[k] = v
        changed = true
      }
    }
    if (!changed) return
    next.taskSelected = next.selectedTaskId !== null
    this.ctx = next
    const snapshot = this.ctx
    for (const fn of this.listeners) fn(snapshot)
  }

  onChange(fn: ContextListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}
