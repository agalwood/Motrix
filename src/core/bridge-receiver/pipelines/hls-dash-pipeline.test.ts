import type { MediaJob } from '@core/task/media-task-coordinator'
import { describe, expect, it, vi } from 'vitest'
import { BridgeReceiverError } from '../errors'
import type { AdaptedDash, AdaptedHls } from '../submit-download-adapter'
import { HlsDashPipeline } from './hls-dash-pipeline'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANIFEST_BASE = 'https://cdn.example/stream'
const MASTER_URL = `${MANIFEST_BASE}/master.m3u8`
const VARIANT_URL = `${MANIFEST_BASE}/hi/index.m3u8`
const AUDIO_URL = `${MANIFEST_BASE}/audio/en.m3u8`

// A simple HLS MEDIA (VOD) playlist — no master
const MEDIA_VOD = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.0,
seg0.ts
#EXTINF:9.0,
seg1.ts
#EXT-X-ENDLIST
`

// An HLS MASTER playlist referencing one variant + audio rendition
const MASTER_WITH_AUDIO = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="${AUDIO_URL}"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AUDIO="aac"
${VARIANT_URL}
`

// An HLS MASTER without audio rendition
const MASTER_NO_AUDIO = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2400000
${VARIANT_URL}
`

// A live HLS playlist (no ENDLIST, no VOD type)
const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:2.0,
live0.ts
#EXTINF:2.0,
live1.ts
`

// A simple variant media playlist returned when master is fetched
const VARIANT_MEDIA = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
chunk0.ts
#EXTINF:6.0,
chunk1.ts
#EXT-X-ENDLIST
`

// An audio media playlist
const AUDIO_MEDIA = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
aud0.aac
#EXT-X-ENDLIST
`

// Minimal DASH MPD
const DASH_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT30S" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period duration="PT30S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" duration="10000" startNumber="1"
     initialization="init-v.mp4"
     media="seg-v-$Number$.m4s"/>
   <Representation id="v" bandwidth="1000000"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4">
   <SegmentTemplate timescale="1000" duration="10000" startNumber="1"
     initialization="init-a.mp4"
     media="seg-a-$Number$.m4s"/>
   <Representation id="a" bandwidth="128000"/>
  </AdaptationSet>
 </Period>
</MPD>`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdaptedHls(overrides: Partial<AdaptedHls> = {}): AdaptedHls {
  return {
    kind: 'hls',
    taskId: 'task-hls-1',
    saveDir: '/downloads',
    finalName: 'video.ts',
    manifestUrl: `${MANIFEST_BASE}/index.m3u8`,
    sanitizedHeaders: { 'X-Token': 'abc' },
    container: 'ts',
    sourceMeta: {
      kind: 'hls',
      extensionId: 'ext1',
      browser: 'chromium',
      sessionKey: 'chromium:ext1',
      pageUrl: 'https://example.com/page',
      pageTitle: 'Test Page',
      qualityLabel: '1080p',
      durationSec: 18,
      submittedAt: 1,
    },
    durationSec: 18,
    ...overrides,
  }
}

function makeAdaptedDash(overrides: Partial<AdaptedDash> = {}): AdaptedDash {
  return {
    kind: 'dash',
    taskId: 'task-dash-1',
    saveDir: '/downloads',
    finalName: 'video.mp4',
    manifestUrl: `${MANIFEST_BASE}/manifest.mpd`,
    sanitizedHeaders: {},
    container: 'mp4',
    sourceMeta: {
      kind: 'dash',
      extensionId: 'ext1',
      browser: 'chromium',
      sessionKey: 'chromium:ext1',
      pageUrl: 'https://example.com/page',
      pageTitle: 'Test Page',
      qualityLabel: '1080p',
      durationSec: 30,
      submittedAt: 1,
    },
    durationSec: 30,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HlsDashPipeline', () => {
  describe('HLS MEDIA playlist (VOD) — direct, no master', () => {
    it('fetches the manifest and calls coordinator.submit with a video SegmentPlan, no audio', async () => {
      const fetchManifest = vi.fn(async () => MEDIA_VOD)
      const captured: MediaJob[] = []
      const coordinator = {
        submit: vi.fn(async (job: MediaJob) => {
          captured.push(job)
          return { taskId: job.taskId ?? 'generated' }
        }),
      }

      const adapted = makeAdaptedHls({
        manifestUrl: `${MANIFEST_BASE}/index.m3u8`,
      })
      const pipeline = new HlsDashPipeline({ fetchManifest, coordinator })
      const result = await pipeline.dispatch(adapted)

      // fetchManifest called exactly once
      expect(fetchManifest).toHaveBeenCalledTimes(1)
      expect(fetchManifest).toHaveBeenCalledWith(
        `${MANIFEST_BASE}/index.m3u8`,
        {
          headers: adapted.sanitizedHeaders,
        }
      )

      // coordinator.submit called with correct job
      expect(coordinator.submit).toHaveBeenCalledTimes(1)
      const job = captured[0]!
      expect(job.taskId).toBe('task-hls-1')
      expect(job.saveDir).toBe('/downloads')
      expect(job.finalName).toBe('video.ts')
      expect(job.headers).toEqual(adapted.sanitizedHeaders)
      expect(job.durationSec).toBe(18)

      // Video plan has segments, no audio
      expect(job.video.segments).toHaveLength(2)
      expect(job.video.segments[0]!.url).toMatch(/seg0\.ts/)
      expect(job.audio).toBeUndefined()

      // result propagates taskId
      expect(result).toEqual({ taskId: 'task-hls-1' })
    })
  })

  describe('HLS MASTER playlist — fetches variant then media', () => {
    it('makes 2 fetch calls for master-without-audio: master + variant', async () => {
      const fetchManifest = vi
        .fn()
        .mockResolvedValueOnce(MASTER_NO_AUDIO) // master fetch
        .mockResolvedValueOnce(VARIANT_MEDIA) // variant fetch

      const coordinator = {
        submit: vi.fn(async (job: MediaJob) => ({
          taskId: job.taskId ?? 'gen',
        })),
      }

      const adapted = makeAdaptedHls({ manifestUrl: MASTER_URL })
      const pipeline = new HlsDashPipeline({ fetchManifest, coordinator })
      await pipeline.dispatch(adapted)

      expect(fetchManifest).toHaveBeenCalledTimes(2)
      expect(fetchManifest).toHaveBeenNthCalledWith(1, MASTER_URL, {
        headers: adapted.sanitizedHeaders,
      })
      expect(fetchManifest).toHaveBeenNthCalledWith(2, VARIANT_URL, {
        headers: adapted.sanitizedHeaders,
      })

      const job = coordinator.submit.mock.calls[0]![0] as MediaJob
      expect(job.video.segments).toHaveLength(2)
      expect(job.audio).toBeUndefined()
    })

    it('makes 3 fetch calls for master-with-audio: master + variant + audio', async () => {
      const fetchManifest = vi
        .fn()
        .mockResolvedValueOnce(MASTER_WITH_AUDIO) // master
        .mockResolvedValueOnce(VARIANT_MEDIA) // variant
        .mockResolvedValueOnce(AUDIO_MEDIA) // audio rendition

      const coordinator = {
        submit: vi.fn(async (job: MediaJob) => ({
          taskId: job.taskId ?? 'gen',
        })),
      }

      const adapted = makeAdaptedHls({ manifestUrl: MASTER_URL })
      const pipeline = new HlsDashPipeline({ fetchManifest, coordinator })
      await pipeline.dispatch(adapted)

      expect(fetchManifest).toHaveBeenCalledTimes(3)

      const job = coordinator.submit.mock.calls[0]![0] as MediaJob
      expect(job.video.segments).toHaveLength(2) // from VARIANT_MEDIA
      expect(job.audio).toBeDefined()
      expect(job.audio!.segments).toHaveLength(1) // from AUDIO_MEDIA
    })
  })

  describe('live HLS playlist', () => {
    it('rejects with BridgeReceiverError code unsupported-live', async () => {
      const fetchManifest = vi.fn(async () => LIVE_PLAYLIST)
      const coordinator = { submit: vi.fn() }

      const adapted = makeAdaptedHls()
      const pipeline = new HlsDashPipeline({ fetchManifest, coordinator })

      await expect(pipeline.dispatch(adapted)).rejects.toSatisfy(
        (e) => e instanceof BridgeReceiverError && e.code === 'unsupported-live'
      )
      expect(coordinator.submit).not.toHaveBeenCalled()
    })
  })

  describe('DASH manifest', () => {
    it('calls coordinator.submit with video and audio SegmentPlans', async () => {
      const fetchManifest = vi.fn(async () => DASH_MPD)
      const captured: MediaJob[] = []
      const coordinator = {
        submit: vi.fn(async (job: MediaJob) => {
          captured.push(job)
          return { taskId: job.taskId ?? 'gen' }
        }),
      }

      const adapted = makeAdaptedDash()
      const pipeline = new HlsDashPipeline({ fetchManifest, coordinator })
      const result = await pipeline.dispatch(adapted)

      expect(fetchManifest).toHaveBeenCalledTimes(1)
      const job = captured[0]!
      expect(job.taskId).toBe('task-dash-1')
      expect(job.video).toBeDefined()
      expect(job.video.segments.length).toBeGreaterThan(0)
      expect(job.audio).toBeDefined()
      expect(job.audio!.segments.length).toBeGreaterThan(0)
      expect(result).toEqual({ taskId: 'task-dash-1' })
    })
  })

  describe('fetch failure', () => {
    it('wraps network error as BridgeReceiverError transient-failure', async () => {
      const fetchManifest = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
      const coordinator = { submit: vi.fn() }

      const pipeline = new HlsDashPipeline({ fetchManifest, coordinator })
      await expect(pipeline.dispatch(makeAdaptedHls())).rejects.toSatisfy(
        (e) =>
          e instanceof BridgeReceiverError && e.code === 'transient-failure'
      )
      expect(coordinator.submit).not.toHaveBeenCalled()
    })
  })
})
