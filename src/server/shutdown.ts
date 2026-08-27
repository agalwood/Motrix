type ShutdownAction = () => void | Promise<void>

export interface ServerShutdownActions {
  gateShellWork: () => Promise<void>
  /**
   * Drain a pending coalesced TaskUpdated snapshot (TaskUpdatePublisher)
   * while SSE/WS consumers are still attached. Optional Phase 1 wiring of
   * the emit-coalescing design; runs before every ingress teardown.
   */
  flushTaskUpdates?: ShutdownAction
  stopPolling: ShutdownAction
  closeIngress: ShutdownAction
  closeBridge: ShutdownAction
  unsubscribeProducers: ShutdownAction
  drainDevWatcher: ShutdownAction
  drainPluginHost: ShutdownAction
  drainMagnet: ShutdownAction
  stopGeoIP: ShutdownAction
  drainSession: ShutdownAction
  disposeActivity: ShutdownAction
  disposeTransferStats: ShutdownAction
  disposeTracker: ShutdownAction
  stopSpeedLimit: ShutdownAction
  stopEngine: ShutdownAction
  closeDatabase: ShutdownAction
}

export function createServerShutdown(
  actions: ServerShutdownActions,
  onError: (error: unknown, label: string) => void
): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null

  return () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      const reportError = (error: unknown, label: string) => {
        try {
          onError(error, label)
        } catch {
          // Cleanup must continue even if diagnostics fail.
        }
      }
      const safely = async (label: string, action: ShutdownAction) => {
        try {
          await action()
        } catch (error) {
          reportError(error, label)
        }
      }

      let shellDrain = Promise.resolve()
      try {
        shellDrain = actions.gateShellWork()
      } catch (error) {
        reportError(error, 'gate-shell-work')
      }

      // Deliver a pending coalesced TaskUpdated before ingress teardown —
      // after closeIngress/closeBridge the snapshot would reach no one.
      if (actions.flushTaskUpdates) {
        await safely('task-update-flush', actions.flushTaskUpdates)
      }

      // Start every cancellation-capable teardown before awaiting any drain.
      // Startup/handlers may be blocked on the engine, plugin host, or session;
      // waiting for tracked work first would deadlock the only operations able
      // to release them.
      const cancellationDrain = Promise.all([
        safely('polling', actions.stopPolling),
        safely('http-ingress', actions.closeIngress),
        safely('bridge-ingress', actions.closeBridge),
        safely('rpc-notifications', actions.unsubscribeProducers),
        safely('dev-watcher', actions.drainDevWatcher),
        safely('plugin-host', actions.drainPluginHost),
        safely('magnet', actions.drainMagnet),
        safely('geoip', actions.stopGeoIP),
        safely('speed-limit', actions.stopSpeedLimit),
      ])
      // A tracker mutation may have paused an active task. Keep both Session
      // persistence and engine RPC alive until its unconditional resume
      // compensation settles.
      await safely('tracker', actions.disposeTracker)
      await Promise.all([
        cancellationDrain,
        safely('session', actions.drainSession),
        safely('engine', actions.stopEngine),
      ])
      await safely('shell-async-work', () => shellDrain)
      await safely('task-inspector-activity', actions.disposeActivity)
      await safely('transfer-stats', actions.disposeTransferStats)
      await safely('database', actions.closeDatabase)
    })()
    return shutdownPromise
  }
}

export async function runServerStartup(
  startup: () => void | Promise<void>,
  shutdown: () => Promise<void>,
  onStartupError: (error: unknown) => void = () => {}
): Promise<void> {
  try {
    await startup()
  } catch (error) {
    try {
      onStartupError(error)
    } catch {
      // A failure marker is diagnostic only; cleanup and the primary startup
      // error must still win.
    }
    await shutdown()
    throw error
  }
}

export function createServerExitCoordinator(
  shutdown: () => Promise<void>,
  exit: (code: number) => void
): (code: number) => Promise<void> {
  let requestedCode = 0
  let exitPromise: Promise<void> | null = null

  return (code: number) => {
    requestedCode = Math.max(requestedCode, code)
    if (exitPromise) return exitPromise
    exitPromise = Promise.resolve().then(async () => {
      await shutdown()
      exit(requestedCode)
    })
    return exitPromise
  }
}
