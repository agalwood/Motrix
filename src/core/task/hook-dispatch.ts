import type { DownloadTask } from '@shared/types/task'

/**
 * Legacy terminal-Hook wake-up seam.
 *
 * Terminal Hook payloads are admitted durably in the same SQLite transaction
 * as the task transition. This helper may only wake the durable scheduler; it
 * must never invoke a plugin directly or rebuild a payload from mutable task
 * state after the commit.
 */
export interface HookDispatchDeps {
  wakePostDeliveries?: () => void | Promise<void>
  log: { warn(ctx: Record<string, unknown>, msg: string): void }
}

/**
 * Which path dispatched the hook. Carried in the failure log's context so the
 * per-task finalize path and the startup recovery sweep stay distinguishable
 * in logs even though they share one message key.
 */
export type HookDispatchOrigin = 'finalize' | 'recovery'

export function fireAfterComplete(
  deps: HookDispatchDeps,
  task: DownloadTask,
  origin: HookDispatchOrigin
): void {
  wakeDurablePostDeliveries(deps, task.id, origin)
}

export function fireOnError(
  deps: HookDispatchDeps,
  task: DownloadTask,
  error: { code: string; message: string },
  origin: HookDispatchOrigin
): void {
  void error
  wakeDurablePostDeliveries(deps, task.id, origin)
}

function wakeDurablePostDeliveries(
  deps: HookDispatchDeps,
  taskId: string,
  origin: HookDispatchOrigin
): void {
  if (!deps.wakePostDeliveries) return
  void Promise.resolve(deps.wakePostDeliveries()).catch((err) => {
    deps.log.warn(
      { taskId, origin, err: (err as Error).message },
      'post_delivery_scheduler_wake_failed'
    )
  })
}
