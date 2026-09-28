import {
  getTaskListSnapshot,
  subscribeTaskList,
} from '@renderer/hooks/use-task-list'
import {
  onOperatorSessionLost,
  useOperatorSession,
} from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { useDownloadsSelection } from '@renderer/routes/downloads/store'
import { PRODUCT_MENU_ITEMS } from '@shared/application-menu-catalog'
import { type CommandId, CommandIds } from '@shared/commands-catalog'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { EngineState, type EngineStatusSnapshot } from '@shared/types/engine'
import {
  canMoveInQueue,
  canPause,
  canRemove,
  canResume,
  isStoppedTaskStatus,
} from '@shared/types/task-actions'

let list: { focus: () => void; generation: number; filterKey: string } | null =
  null
let generation = 0
let selectionIdentity = useDownloadsSelection.getState().committedSelectedIds
useDownloadsSelection.subscribe((state) => {
  if (state.committedSelectedIds !== selectionIdentity) {
    selectionIdentity = state.committedSelectedIds
    generation++
  }
})
const listeners = new Set<() => void>()
const publish = () => {
  for (const listener of listeners) listener()
}
let serverReachable = transport.platform !== 'web'
let engineReady = false

export function registerDownloadsMenuContext(
  focus: () => void,
  filterKey = ''
): () => void {
  const current = { focus, generation: ++generation, filterKey }
  list = current
  publish()
  return () => {
    if (list === current) {
      list = null
      generation++
      publish()
    }
  }
}
export interface TaskMenuIntent {
  generation: number
  selection: ReadonlySet<string>
  ids: readonly string[]
}
export function captureTaskMenuIntent(): TaskMenuIntent {
  const state = useDownloadsSelection.getState()
  return {
    generation,
    selection: state.committedSelectedIds,
    ids: list
      ? state.items
          .filter((task) => state.committedSelectedIds.has(task.id))
          .map((task) => task.id)
      : [],
  }
}
export function validTaskMenuIntent(intent: TaskMenuIntent): boolean {
  return (
    list !== null &&
    intent.generation === generation &&
    intent.selection === useDownloadsSelection.getState().committedSelectedIds
  )
}
export function selectedMenuTasks(intent?: TaskMenuIntent) {
  const captured = intent ?? captureTaskMenuIntent()
  if (!validTaskMenuIntent(captured)) return []
  const ids = new Set(captured.ids)
  return getTaskListSnapshot().tasks.filter((task) => ids.has(task.id))
}
export function focusDownloadsList(): void {
  list?.focus()
}
export function selectAllDownloads(): void {
  if (!list) return
  useDownloadsSelection.getState().selectAll()
  window.getSelection()?.removeAllRanges()
  list.focus()
}
export function taskWritesAvailable(): boolean {
  return (
    serverReachable &&
    engineReady &&
    getTaskListSnapshot().status === 'ready' &&
    (transport.platform !== 'web' ||
      useOperatorSession.getState().state === 'authenticated')
  )
}
export function menuActionEnabled(
  id: CommandId,
  intent?: TaskMenuIntent
): boolean {
  const tasks = getTaskListSnapshot().tasks
  if (id === CommandIds.TaskSelectAll)
    return list !== null && useDownloadsSelection.getState().items.length > 0
  const item = PRODUCT_MENU_ITEMS.find((item) => item.commandId === id)
  if (!item || item.scope === 'local')
    return (
      transport.platform !== 'web' ||
      useOperatorSession.getState().state === 'authenticated'
    )
  if (!taskWritesAvailable()) return false
  if (id === CommandIds.TaskPauseAll) return tasks.some(canPause)
  if (id === CommandIds.TaskResumeAll) return tasks.some(canResume)
  if (id === CommandIds.TaskClearStopped)
    return tasks.some((task) => isStoppedTaskStatus(task.status))
  const selected = selectedMenuTasks(intent)
  if (id === CommandIds.TaskPause) return selected.some(canPause)
  if (id === CommandIds.TaskResume) return selected.some(canResume)
  if (id === CommandIds.TaskDelete) return selected.some(canRemove)
  if (id === CommandIds.TaskMoveUp || id === CommandIds.TaskMoveDown)
    return selected.some(canMoveInQueue)
  return false
}

/** Only semantic changes notify React: progress frames do not rebuild the menu. */
export function subscribeMenuContext(listener: () => void): () => void {
  const detachTasks = subscribeTaskList(listener)
  const detachSelection = useDownloadsSelection.subscribe(listener)
  const detachAuth = useOperatorSession.subscribe(listener)
  listeners.add(listener)
  return () => {
    detachTasks()
    detachSelection()
    detachAuth()
    listeners.delete(listener)
  }
}
export function menuContextSignature(intent?: TaskMenuIntent): string {
  return PRODUCT_MENU_ITEMS.map((item) =>
    menuActionEnabled(item.commandId, intent) ? '1' : '0'
  ).join('')
}
export function startMenuConnection(): () => void {
  serverReachable = transport.platform !== 'web'
  let epoch = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  const refreshEngine = async () => {
    if (inFlight || disposed) return
    inFlight = true
    clearTimeout(timer)
    const current = ++epoch
    const sessionEpoch = useOperatorSession.getState().epoch
    const canPublish = () =>
      !disposed &&
      current === epoch &&
      sessionEpoch === useOperatorSession.getState().epoch
    try {
      const result = (await transport.invoke(
        Queries.GetEngineStatus
      )) as EngineStatusSnapshot
      if (canPublish()) {
        serverReachable = true
        engineReady = result.state === EngineState.Ready
        publish()
      }
    } catch {
      if (canPublish()) {
        serverReachable = false
        engineReady = false
        publish()
      }
    } finally {
      inFlight = false
      if (!disposed && transport.platform === 'web')
        timer = setTimeout(
          () => {
            if (document.visibilityState !== 'hidden') void refreshEngine()
          },
          transport.getConnectionState?.() === 'connected' ? 30_000 : 5_000
        )
    }
  }
  const onEngine = (...args: unknown[]) => {
    epoch++
    serverReachable = true
    engineReady = args[0] === EngineState.Ready
    publish()
  }
  const detach = transport.onConnectionChange?.((event) => {
    if (event.state === 'connected' || event.state === 'disconnected')
      void refreshEngine()
  })
  const foreground = () => {
    if (document.visibilityState !== 'hidden') void refreshEngine()
  }
  transport.on(Events.EngineStateChanged, onEngine)
  window.addEventListener('online', foreground)
  document.addEventListener('visibilitychange', foreground)
  void refreshEngine()
  return () => {
    disposed = true
    epoch++
    clearTimeout(timer)
    window.removeEventListener('online', foreground)
    document.removeEventListener('visibilitychange', foreground)
    detach?.()
    transport.off(Events.EngineStateChanged, onEngine)
  }
}
onOperatorSessionLost(() => {
  useDownloadsSelection.getState().clearSelection()
  useDownloadsSelection.getState().setItems([])
  serverReachable = false
  engineReady = false
  publish()
})

export function menuContextPatch() {
  const intent = captureTaskMenuIntent()
  const tasks = selectedMenuTasks(intent)
  const primary = tasks.find((task) => task.id === intent.ids[0])
  return {
    selectedTaskIds: intent.ids,
    selectedTaskGeneration: intent.generation,
    selectedTaskId: primary?.id ?? null,
    selectedTaskStatus: primary?.status ?? null,
    selectedTaskAtTop: false,
    selectedTaskAtBottom: false,
    selectedCanPause: menuActionEnabled(CommandIds.TaskPause, intent),
    selectedCanResume: menuActionEnabled(CommandIds.TaskResume, intent),
    selectedCanRemove: menuActionEnabled(CommandIds.TaskDelete, intent),
    selectedCanMove: menuActionEnabled(CommandIds.TaskMoveUp, intent),
    hasAnyActiveTask: menuActionEnabled(CommandIds.TaskPauseAll),
    hasAnyPausedTask: menuActionEnabled(CommandIds.TaskResumeAll),
    hasStoppedTasks: menuActionEnabled(CommandIds.TaskClearStopped),
  }
}
