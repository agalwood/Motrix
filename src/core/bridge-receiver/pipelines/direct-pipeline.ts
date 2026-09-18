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
    // Keep Referer in the same header path as the download and plugin hooks,
    // so metadata discovery can reconstruct the request without passthrough
    // engine options. A supplied header takes precedence over the page URL.
    const headers = Object.entries(adapted.sanitizedHeaders).map(
      ([name, value]) => ({ name, value })
    )
    if (!headers.some(({ name }) => name.toLowerCase() === 'referer')) {
      headers.push({ name: 'Referer', value: adapted.pageUrl })
    }
    const req = {
      type: 'http' as const,
      // uris is a top-level field on httpTaskRequestSchema; there is no
      // `payload` for http tasks (that key is bt-only). Burying it under
      // payload.uris made handleCreateTask's schema reject every direct
      // submit ("uris: expected array, received undefined").
      uris: [adapted.primaryUrl],
      saveDir: adapted.saveDir,
      ...(adapted.discoverFilename ? {} : { filename: adapted.finalName }),
      // Match manual tasks by leaving the per-task override unset. Aria2 then
      // inherits the app's global split and per-server connection settings.
      headers,
      proxy: undefined,
    }
    const { taskId } = await this.deps.createTask(req, undefined, {
      source: 'bridge',
      sourceMeta: adapted.sourceMeta,
      // Even [] requests an isolated task cookie jar in the engine.
      cookies: adapted.cookies,
    })
    return { taskId }
  }

  async cancel(taskId: string): Promise<void> {
    await this.deps.removeTask(taskId)
  }
}
