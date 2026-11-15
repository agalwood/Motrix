import { create } from 'zustand'

/** Pause requests are shared by the inspector, task menus and dashboard. */
export const useTaskPauseStore = create<{ pending: ReadonlySet<string> }>(
  () => ({
    pending: new Set(),
  })
)

export function beginTaskPauses(ids: readonly string[]): string[] {
  const pending = new Set(useTaskPauseStore.getState().pending)
  const acquired: string[] = []
  for (const id of ids) {
    if (pending.has(id)) continue
    pending.add(id)
    acquired.push(id)
  }
  if (acquired.length) useTaskPauseStore.setState({ pending })
  return acquired
}

export function finishTaskPauses(ids: readonly string[]): void {
  const pending = new Set(useTaskPauseStore.getState().pending)
  for (const id of ids) pending.delete(id)
  useTaskPauseStore.setState({ pending })
}
