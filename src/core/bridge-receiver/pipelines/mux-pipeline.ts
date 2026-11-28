import type {
  MediaJob,
  MediaTaskCoordinator,
} from '@core/task/media-task-coordinator'
import type { SourceMeta } from '@shared/types/task'
import type { AdaptedMux } from '../submit-download-adapter'
import { ensureMediaExtension } from './media-final-name'

export interface MuxPipelineDeps {
  coordinator: Pick<MediaTaskCoordinator, 'submit'>
  /** Reject before fetching manifests or creating a task if FFmpeg is absent. */
  assertFfmpegAvailable?: () => Promise<void>
}

/**
 * A resolved best-audio stream awaiting MP3 extraction. Built by the bridge
 * receiver when the submitter's quality hint was `mp3` — mirrors AdaptedMux
 * but with a single audio leg instead of a video + audio pair.
 */
export interface AdaptedAudioExtract {
  taskId: string
  saveDir: string
  /** Final name including the `.mp3` extension. */
  finalName: string
  audioUrl: string
  sanitizedHeaders: Record<string, string>
  sourceMeta: SourceMeta
  durationSec?: number
}

/**
 * Pipeline for `kind: 'mux'` adapted selections. Builds two single-part
 * SegmentPlans (container: 'single') and hands them to MediaTaskCoordinator.
 */
export class MuxPipeline {
  constructor(private readonly deps: MuxPipelineDeps) {}

  async isAvailable(): Promise<boolean> {
    if (!this.deps.assertFfmpegAvailable) return true
    try {
      await this.deps.assertFfmpegAvailable()
      return true
    } catch {
      return false
    }
  }

  async dispatch(adapted: AdaptedMux): Promise<{ taskId: string }> {
    await this.deps.assertFfmpegAvailable?.()
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
      ...(adapted.receipt ? { receipt: adapted.receipt } : {}),
      ...(adapted.durationSec !== undefined
        ? { durationSec: adapted.durationSec }
        : {}),
    }
    return this.deps.coordinator.submit(job)
  }

  /**
   * Dispatch the MP3 extraction job: the audio stream is downloaded as a
   * single-segment plan through the normal media coordinator, then the mux
   * phase re-encodes it to `finalName` instead of copy-remuxing.
   */
  async dispatchExtract(
    adapted: AdaptedAudioExtract
  ): Promise<{ taskId: string }> {
    await this.deps.assertFfmpegAvailable?.()
    const job: MediaJob = {
      taskId: adapted.taskId,
      kind: 'mux',
      extractAudio: true,
      video: {
        container: 'single',
        segments: [{ url: adapted.audioUrl, index: 0 }],
        isComplete: true,
      },
      headers: adapted.sanitizedHeaders,
      saveDir: adapted.saveDir,
      finalName: adapted.finalName,
      sourceMeta: adapted.sourceMeta,
      ...(adapted.durationSec !== undefined
        ? { durationSec: adapted.durationSec }
        : {}),
    }
    return this.deps.coordinator.submit(job)
  }
}
