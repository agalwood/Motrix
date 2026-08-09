import type { CreateTaskOptions } from '@core/task/create-task-handler'
import type { AdaptedDirect } from '../submit-download-adapter'

export interface DirectPipelineDeps {
  /**
   * Wraps createTaskHandler.handle. The receiver bootstraps with the
   * actual handler bound; tests inject a vi.fn. The returned `taskId`
   * is the stable DownloadTask.id and is what we hand to the extension
   * on the wire; `gid` is the current aria2 GID, kept only for callers
   * that still address aria2 directly (and is not exposed externally).
   */
  createTask: (
    req: unknown,
    deps: unknown,
    options: CreateTaskOptions
  ) => Promise<{ gid: string; taskId: string }>
  removeTask: (taskId: string) => Promise<void>
}

/**
 * Builds the engine request for `kind: 'direct'` and dispatches to
 * createTaskHandler. The handler internally registers the task with
 * TaskManager + persists via MotrixDatabase, so DirectPipeline does
 * neither — it is a thin adapter.
 *
 * EventBus subscriptions are global (one per receiver instance) and
 * live in BridgeReceiver, not here.
 */
export class DirectPipeline {
  constructor(private readonly deps: DirectPipelineDeps) {}

  async dispatch(adapted: AdaptedDirect): Promise<{ taskId: string }> {
    const req = {
      type: 'http' as const,
      // uris is a top-level field on httpTaskRequestSchema; there is no
      // `payload` for http tasks (that key is bt-only). Burying it under
      // payload.uris made handleCreateTask's schema reject every direct
      // submit ("uris: expected array, received undefined").
      uris: [adapted.primaryUrl],
      saveDir: adapted.saveDir,
      filename: adapted.finalName,
      connections: 1,
      headers: Object.entries(adapted.sanitizedHeaders).map(
        ([name, value]) => ({ name, value })
      ),
      proxy: undefined,
    }
    // Headers travel only via req.headers (→ params.headers). They used to be
    // duplicated here as extraEngineOptions.header too, but Aria2Adapter
    // applies extraEngineOptions LAST — so that copy clobbered options.header
    // back to the original request headers, silently discarding any rewrite a
    // beforeCreate plugin made to params.headers. Dropping the duplicate lets
    // the plugin-mutable params.headers win.
    const extraEngineOptions: Record<string, string | string[]> = {
      'load-cookies': adapted.jarPath,
      referer: adapted.pageUrl,
    }
    const { taskId } = await this.deps.createTask(req, undefined, {
      source: 'bridge',
      sourceMeta: adapted.sourceMeta,
      extraEngineOptions,
    })
    return { taskId }
  }

  async cancel(taskId: string): Promise<void> {
    await this.deps.removeTask(taskId)
  }
}
