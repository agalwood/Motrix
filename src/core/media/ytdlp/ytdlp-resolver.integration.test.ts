import { describe, expect, it } from 'vitest'
import { locateYtdlp } from './ytdlp-locator'
import { resolveWithYtdlp } from './ytdlp-resolver'

/**
 * Live yt-dlp check. Opt-in because it needs both the yt-dlp binary and
 * outbound network access to a video site:
 *
 *   MOTRIX_LIVE_NETWORK_TESTS=1 pnpm exec vitest run src/core/media/ytdlp/ytdlp-resolver.integration.test.ts
 */
const liveEnabled = process.env.MOTRIX_LIVE_NETWORK_TESTS === '1'
const location = liveEnabled ? await locateYtdlp({ env: process.env }) : null

describe.skipIf(!liveEnabled || !location?.available)(
  'resolveWithYtdlp (live)',
  {
    timeout: 120_000,
  },
  () => {
    it('resolves a YouTube watch page into a mux pair', async () => {
      const outcome = await resolveWithYtdlp(
        'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        { binaryPath: location?.binaryPath ?? 'yt-dlp' }
      )
      expect(outcome.status).toBe('resolved')
      if (outcome.status !== 'resolved') return
      expect(outcome.resolution.kind).toBe('mux')
      if (outcome.resolution.kind !== 'mux') return
      expect(outcome.resolution.videoUrl).toMatch(/^https:\/\//)
      expect(outcome.resolution.audioUrl).toMatch(/^https:\/\//)
      expect(outcome.resolution.container).toMatch(/^(mp4|mkv)$/)
      expect(outcome.resolution.title).toBe('Me at the zoo')
    })

    it('reports unsupported for a page no extractor claims', async () => {
      const outcome = await resolveWithYtdlp(
        'https://example.com/definitely-not-a-video',
        { binaryPath: location?.binaryPath ?? 'yt-dlp' }
      )
      expect(outcome.status).not.toBe('resolved')
    })
  }
)
