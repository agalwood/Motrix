import { parseDash } from '@core/media/dash-parser'
import { parseHlsMaster, parseHlsMedia } from '@core/media/hls-parser'
import { MediaParseError } from '@core/media/segment-plan'
import type {
  MediaJob,
  MediaTaskCoordinator,
} from '@core/task/media-task-coordinator'
import { BridgeReceiverError } from '../errors'
import type { AdaptedDash, AdaptedHls } from '../submit-download-adapter'
import { ensureMediaExtension } from './media-final-name'

export interface HlsDashPipelineDeps {
  fetchManifest: (
    url: string,
    opts: { headers?: Record<string, string> }
  ) => Promise<string>
  coordinator: Pick<MediaTaskCoordinator, 'submit'>
}

/**
 * Pipeline for HLS and DASH manifests. Fetches and parses the manifest,
 * builds a MediaJob, and hands it to MediaTaskCoordinator.start.
 *
 * HLS flow:
 *  - MASTER playlist (contains #EXT-X-STREAM-INF): parseHlsMaster → fetch
 *    variantUrl → parseHlsMedia (video); if audioUrl present → fetch it →
 *    parseHlsMedia (audio).
 *  - MEDIA playlist directly: parseHlsMedia (video only).
 *
 * DASH flow: parseDash → { video, audio? }.
 *
 * Error mapping:
 *  - Fetch failure → BridgeReceiverError('transient-failure', …)
 *  - MediaParseError → BridgeReceiverError(e.code, e.message)
 */
export class HlsDashPipeline {
  constructor(private readonly deps: HlsDashPipelineDeps) {}

  async dispatch(
    adapted: AdaptedHls | AdaptedDash
  ): Promise<{ taskId: string }> {
    const { fetchManifest, coordinator } = this.deps
    const headers = adapted.sanitizedHeaders
    // ffmpeg needs an output extension or it can't pick a muxer (exit 234) —
    // a manifest-derived finalName may lack one. Compute once for all branches.
    const finalName = ensureMediaExtension(adapted.finalName, adapted.container)

    // --- fetch primary manifest ---
    let manifestText: string
    try {
      manifestText = await fetchManifest(adapted.manifestUrl, { headers })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new BridgeReceiverError(
        'transient-failure',
        `manifest fetch failed: ${msg}`
      )
    }

    try {
      if (adapted.kind === 'dash') {
        // DASH
        const { video, audio } = parseDash(manifestText, adapted.manifestUrl)
        const job: MediaJob = {
          taskId: adapted.taskId,
          kind: 'dash',
          video,
          ...(audio !== undefined ? { audio } : {}),
          headers,
          saveDir: adapted.saveDir,
          finalName,
          sourceMeta: adapted.sourceMeta,
          ...(adapted.durationSec !== undefined
            ? { durationSec: adapted.durationSec }
            : {}),
        }
        return coordinator.submit(job)
      }

      // HLS
      const isMaster = manifestText.includes('#EXT-X-STREAM-INF')

      if (isMaster) {
        const { variantUrl, audioUrl } = parseHlsMaster(
          manifestText,
          adapted.manifestUrl
        )

        let variantText: string
        try {
          variantText = await fetchManifest(variantUrl, { headers })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new BridgeReceiverError(
            'transient-failure',
            `variant fetch failed: ${msg}`
          )
        }
        const video = parseHlsMedia(variantText, variantUrl)

        let audioJob: ReturnType<typeof parseHlsMedia> | undefined
        if (audioUrl !== undefined) {
          let audioText: string
          try {
            audioText = await fetchManifest(audioUrl, { headers })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            throw new BridgeReceiverError(
              'transient-failure',
              `audio fetch failed: ${msg}`
            )
          }
          audioJob = parseHlsMedia(audioText, audioUrl)
        }

        const job: MediaJob = {
          taskId: adapted.taskId,
          kind: 'hls',
          video,
          ...(audioJob !== undefined ? { audio: audioJob } : {}),
          headers,
          saveDir: adapted.saveDir,
          finalName,
          sourceMeta: adapted.sourceMeta,
          ...(adapted.durationSec !== undefined
            ? { durationSec: adapted.durationSec }
            : {}),
        }
        return coordinator.submit(job)
      }

      // Media playlist (not master)
      const video = parseHlsMedia(manifestText, adapted.manifestUrl)
      const job: MediaJob = {
        taskId: adapted.taskId,
        kind: 'hls',
        video,
        headers,
        saveDir: adapted.saveDir,
        finalName,
        sourceMeta: adapted.sourceMeta,
        ...(adapted.durationSec !== undefined
          ? { durationSec: adapted.durationSec }
          : {}),
      }
      return coordinator.submit(job)
    } catch (e) {
      if (e instanceof MediaParseError) {
        throw new BridgeReceiverError(e.code, e.message)
      }
      throw e
    }
  }
}
