import type { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import type {
  AfterCompleteContextDTO,
  OnErrorContextDTO,
} from '@shared/types/plugin-hooks'
import type { DownloadTask } from '@shared/types/task'

/**
 * Shared fire-and-forget dispatch for the parallel afterComplete / onError
 * hook chains. Plan C spec §10: parallel hooks run in isolation — one
 * plugin's failure must not affect the others, and dispatch never blocks the
 * calling path. Both finalizeTask (per-task completion) and TaskRecoveryService
 * (startup recovery) reach the same terminal transitions, so the dispatch lives
 * here once instead of being copy-pasted into each.
 */
export interface HookDispatchDeps {
  orchestrator?: HookOrchestrator
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
  if (!deps.orchestrator) return
  const dto: AfterCompleteContextDTO = { task, filePath: task.finalPath }
  void deps.orchestrator
    .runParallel('afterComplete', dto, task.id)
    .catch((err) => {
      deps.log.warn(
        { taskId: task.id, origin, err: (err as Error).message },
        'after_complete_hook_failed'
      )
    })
}

export function fireOnError(
  deps: HookDispatchDeps,
  task: DownloadTask,
  error: { code: string; message: string },
  origin: HookDispatchOrigin
): void {
  if (!deps.orchestrator) return
  const dto: OnErrorContextDTO = { task, error }
  void deps.orchestrator.runParallel('onError', dto, task.id).catch((err) => {
    deps.log.warn(
      { taskId: task.id, origin, err: (err as Error).message },
      'on_error_hook_failed'
    )
  })
}
