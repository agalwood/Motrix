import type { CreateTaskOptions } from '@core/task/create-task-handler'
import type { BridgeSourceMeta } from '@shared/types/task'
import type { AdaptedMagnet } from '../submit-download-adapter'

export interface MagnetPipelineDeps {
  createTask: (
    req: unknown,
    deps: unknown,
    options: CreateTaskOptions
  ) => Promise<{ gid: string; taskId: string }>
  removeTask: (taskId: string) => Promise<void>
  /**
   * Route a bridge-submitted magnet through MagnetTracker's metadata-only
   * fetch (bound to `MagnetTracker.submit` with `source:'bridge'` in the
   * bootstrap). Returns the motrixId of the pending metadata task — handed
   * to the extension as its taskId. This is what makes the bridge path emit
   * `MagnetFileSelection` (the dialog) and avoid aria2's auto-follow (the
   * duplicate BT record), mirroring the UI path in `Commands.CreateTask`.
   */
  submitMagnetForFileSelection: (
    uri: string,
    saveDir: string,
    sourceMeta: BridgeSourceMeta
  ) => Promise<string>
  /**
   * Whether the "pick files after magnet metadata resolves" app setting is
   * on. Read live (not captured) so a settings toggle takes effect without
   * rebuilding the receiver.
   */
  isMagnetFileSelectionEnabled: () => boolean
}

/**
 * Dispatches a `kind: 'magnet'` bridge submit. When file selection is enabled
 * it defers to MagnetTracker (metadata-only fetch → file dialog → swap in
 * place, a single Downloads row). Otherwise it dispatches the magnet straight
 * to the engine as a `bt` task and lets aria2 fetch metadata + download all
 * files. Either way the task is attributed `source:'bridge'` so progress
 * notifications keep flowing to the extension via ProgressPublisher.
 */
export class MagnetPipeline {
  constructor(private readonly deps: MagnetPipelineDeps) {}

  async dispatch(adapted: AdaptedMagnet): Promise<{ taskId: string }> {
    if (this.deps.isMagnetFileSelectionEnabled()) {
      const taskId = await this.deps.submitMagnetForFileSelection(
        adapted.uri,
        adapted.saveDir,
        adapted.sourceMeta
      )
      return { taskId }
    }

    const req = {
      type: 'bt' as const,
      saveDir: adapted.saveDir,
      payload: { kind: 'magnet' as const, uri: adapted.uri },
      selectedFiles: [] as number[],
    }
    const { taskId } = await this.deps.createTask(req, undefined, {
      source: 'bridge',
      sourceMeta: adapted.sourceMeta,
    })
    return { taskId }
  }

  async cancel(taskId: string): Promise<void> {
    await this.deps.removeTask(taskId)
  }
}
