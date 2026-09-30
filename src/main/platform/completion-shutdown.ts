import type { EventBus } from '@core/events/event-bus'
import {
  CompletionShutdownController,
  type ShutdownPreparation,
} from '@core/task/completion-shutdown-controller'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type CompletionShutdownState,
  completionShutdownRequestSchema,
} from '@shared/schemas/completion-shutdown'
import type { DownloadTask } from '@shared/types/task'
import {
  type BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  powerSaveBlocker,
} from 'electron'
import { registerTrustedIpcHandler } from '../ipc/trusted-ipc'
import { createSystemShutdown } from './system-shutdown'

interface Dependencies {
  eventBus: EventBus
  getTasks(): DownloadTask[]
  isReady(): boolean
  waitForReady(): Promise<void>
  prepare(): ShutdownPreparation
  save(): Promise<void>
  broadcast(state: CompletionShutdownState): void
  translate(key: string, params?: Record<string, unknown>): string
  logError(error: unknown): void
  getMainWindow(): BrowserWindow | null
  showMainWindow(): void
}

export function setupCompletionShutdown(deps: Dependencies): () => void {
  const system = createSystemShutdown()
  let blocker: number | null = null
  let countdownDialog: AbortController | null = null
  let previousPhase: CompletionShutdownState['phase'] = 'off'
  let startupSettled = false
  let disposed = false
  const controller = new CompletionShutdownController({
    ...deps,
    supported: system.supported,
    isReady: () => startupSettled && deps.isReady(),
    probe: async () => {
      await deps.waitForReady()
      if (disposed) return
      startupSettled = true
      controller.evaluate()
      await system.probe()
    },
    requestShutdown: system.requestShutdown,
    onError: deps.logError,
    onState: (state) => {
      const active = ['waiting', 'countdown', 'preparing'].includes(state.phase)
      if (active && blocker === null)
        blocker = powerSaveBlocker.start('prevent-app-suspension')
      if (!active && blocker !== null) {
        powerSaveBlocker.stop(blocker)
        blocker = null
      }
      deps.broadcast(state)
      if (state.phase !== 'countdown') {
        countdownDialog?.abort()
        countdownDialog = null
      }
      if (state.phase === 'countdown' && previousPhase !== 'countdown') {
        const abort = new AbortController()
        countdownDialog = abort
        // Native window/dialog APIs may throw before returning a Promise.
        // Any failure must cancel the power action, including synchronous ones.
        void (async () => {
          const parent = deps.getMainWindow()
          if (!parent || parent.isDestroyed())
            throw new Error('Shutdown cancellation window is unavailable')
          deps.showMainWindow()
          return dialog.showMessageBox(parent, {
            type: 'warning',
            title: 'Motrix',
            message: deps.translate(
              'panel.downloads.completionShutdown.countdown',
              { seconds: 60 }
            ),
            detail: deps.translate('panel.downloads.completionShutdown.detail'),
            buttons: [deps.translate('common.cancel')],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: abort.signal,
          })
        })()
          .then(() => {
            if (!abort.signal.aborted) controller.cancel()
          })
          .catch((error) => {
            deps.logError(error)
            if (!abort.signal.aborted) controller.cancel()
          })
      }
      if (
        state.phase === 'failed' &&
        ['preparing', 'requested'].includes(previousPhase)
      ) {
        dialog.showErrorBox(
          'Motrix',
          deps.translate('panel.downloads.completionShutdown.failed')
        )
      }
      previousPhase = state.phase
    },
  })
  void deps.waitForReady().then(() => {
    if (!disposed) startupSettled = true
  })
  const evaluate = () => controller.evaluate()
  const interrupt = () => controller.interrupt()
  deps.eventBus.on(Events.TaskUpdated, evaluate)
  deps.eventBus.on(Events.EngineDisconnected, interrupt)
  deps.eventBus.on(Events.EngineStateChanged, evaluate)
  powerMonitor.on('suspend', interrupt)
  powerMonitor.on('resume', interrupt)
  registerTrustedIpcHandler(Queries.GetCompletionShutdown, () =>
    controller.getState()
  )
  registerTrustedIpcHandler(
    Commands.SetCompletionShutdown,
    (_event, payload: unknown) => {
      const { enabled } = completionShutdownRequestSchema.parse(payload)
      return controller.setEnabled(enabled)
    }
  )
  deps.broadcast(controller.getState())
  return () => {
    disposed = true
    controller.dispose()
    deps.eventBus.off(Events.TaskUpdated, evaluate)
    deps.eventBus.off(Events.EngineDisconnected, interrupt)
    deps.eventBus.off(Events.EngineStateChanged, evaluate)
    powerMonitor.off('suspend', interrupt)
    powerMonitor.off('resume', interrupt)
    ipcMain.removeHandler(Queries.GetCompletionShutdown)
    ipcMain.removeHandler(Commands.SetCompletionShutdown)
  }
}
