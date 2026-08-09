import type { MediaJob } from '@core/task/media-task-coordinator'
import { describe, expect, it, vi } from 'vitest'
import type { AdaptedMux } from '../submit-download-adapter'
import { MuxPipeline } from './mux-pipeline'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeAdaptedMux(overrides: Partial<AdaptedMux> = {}): AdaptedMux {
  return {
    kind: 'mux',
    taskId: 'task-mux-1',
    saveDir: '/downloads',
    finalName: 'video.mp4',
    videoUrl: 'https://cdn.example/video.mp4',
    audioUrl: 'https://cdn.example/audio.mp4',
    sanitizedHeaders: { 'X-Auth': 'tok' },
    container: 'mp4',
    sourceMeta: {
      kind: 'mux',
      extensionId: 'ext1',
      browser: 'chromium',
      sessionKey: 'chromium:ext1',
      pageUrl: 'https://example.com/page',
      pageTitle: 'Test Page',
      qualityLabel: '1080p',
      durationSec: 120,
      submittedAt: 1,
    },
    durationSec: 120,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MuxPipeline', () => {
  it('builds two single-part SegmentPlans and calls coordinator.submit with video + audio', async () => {
    const captured: MediaJob[] = []
    const coordinator = {
      submit: vi.fn(async (job: MediaJob) => {
        captured.push(job)
        return { taskId: job.taskId ?? 'gen' }
      }),
    }

    const adapted = makeAdaptedMux()
    const pipeline = new MuxPipeline({ coordinator })
    const result = await pipeline.dispatch(adapted)

    expect(coordinator.submit).toHaveBeenCalledTimes(1)
    const job = captured[0]!

    // Basic job fields
    expect(job.taskId).toBe('task-mux-1')
    expect(job.saveDir).toBe('/downloads')
    expect(job.finalName).toBe('video.mp4')
    expect(job.headers).toEqual(adapted.sanitizedHeaders)
    expect(job.durationSec).toBe(120)
    expect(job.sourceMeta).toEqual(adapted.sourceMeta)

    // Video plan: single-part, container='single', url=videoUrl
    expect(job.video).toMatchObject({
      container: 'single',
      isComplete: true,
      segments: [{ url: adapted.videoUrl, index: 0 }],
    })
    expect(job.video.init).toBeUndefined()

    // Audio plan: single-part, container='single', url=audioUrl
    expect(job.audio).toBeDefined()
    expect(job.audio).toMatchObject({
      container: 'single',
      isComplete: true,
      segments: [{ url: adapted.audioUrl, index: 0 }],
    })
    expect(job.audio!.init).toBeUndefined()

    // Result propagates taskId
    expect(result).toEqual({ taskId: 'task-mux-1' })
  })

  it('appends the container extension when finalName has none (bilibili bvid → .mp4)', async () => {
    // The desktop Add-Task path derives finalName from the page URL, so a
    // bilibili URL yields "BV14vJg6ZEd4" with NO extension. Without a fix,
    // ffmpeg cannot choose an output muxer and exits 234. The pipeline must
    // hand the coordinator a finalName ending in the container extension.
    const coordinator = {
      submit: vi.fn(async (job: MediaJob) => ({ taskId: job.taskId ?? 'gen' })),
    }
    const adapted = makeAdaptedMux({ finalName: 'BV14vJg6ZEd4' })
    await new MuxPipeline({ coordinator }).dispatch(adapted)
    const job = coordinator.submit.mock.calls[0]![0] as MediaJob
    expect(job.finalName).toBe('BV14vJg6ZEd4.mp4')
  })

  it('uses .mkv when the container is mkv and the name has no extension', async () => {
    const coordinator = {
      submit: vi.fn(async (job: MediaJob) => ({ taskId: job.taskId ?? 'gen' })),
    }
    const adapted = makeAdaptedMux({ finalName: 'clip', container: 'mkv' })
    await new MuxPipeline({ coordinator }).dispatch(adapted)
    const job = coordinator.submit.mock.calls[0]![0] as MediaJob
    expect(job.finalName).toBe('clip.mkv')
  })

  it('omits durationSec from job when not present in adapted', async () => {
    const coordinator = {
      submit: vi.fn(async (job: MediaJob) => ({ taskId: job.taskId ?? 'gen' })),
    }

    const adapted = makeAdaptedMux({ durationSec: undefined })
    const pipeline = new MuxPipeline({ coordinator })
    await pipeline.dispatch(adapted)

    const job = coordinator.submit.mock.calls[0]![0] as MediaJob
    expect(job.durationSec).toBeUndefined()
  })
})
