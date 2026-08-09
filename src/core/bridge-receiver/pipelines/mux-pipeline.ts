import type {
  MediaJob,
  MediaTaskCoordinator,
} from '@core/task/media-task-coordinator'
import type { AdaptedMux } from '../submit-download-adapter'
import { ensureMediaExtension } from './media-final-name'

export interface MuxPipelineDeps {
  coordinator: Pick<MediaTaskCoordinator, 'submit'>
}

/**
 * Pipeline for `kind: 'mux'` adapted selections. Builds two single-part
 * SegmentPlans (container: 'single') and hands them to MediaTaskCoordinator.
 */
export class MuxPipeline {
  constructor(private readonly deps: MuxPipelineDeps) {}

  async dispatch(adapted: AdaptedMux): Promise<{ taskId: string }> {
    const job: MediaJob = {
      taskId: adapted.taskId,
      kind: 'mux',
      video: {
        container: 'single',
        segments: [{ url: adapted.videoUrl, index: 0 }],
        isComplete: true,
      },
      audio: {
        container: 'single',
        segments: [{ url: adapted.audioUrl, index: 0 }],
        isComplete: true,
      },
      headers: adapted.sanitizedHeaders,
      saveDir: adapted.saveDir,
      // ffmpeg needs an output extension or it can't pick a muxer (exit 234).
      finalName: ensureMediaExtension(adapted.finalName, adapted.container),
      sourceMeta: adapted.sourceMeta,
      ...(adapted.durationSec !== undefined
        ? { durationSec: adapted.durationSec }
        : {}),
    }
    return this.deps.coordinator.submit(job)
  }
}
