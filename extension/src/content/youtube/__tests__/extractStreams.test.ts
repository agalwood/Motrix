import { describe, expect, it } from 'vitest'
import {
  type ItagInfo,
  type ObservedStream,
  parseItag,
  selectMuxStreams,
  YT_ITAG_KIND,
} from '@/content/youtube/extractStreams'

describe('extractStreams', () => {
  describe('parseItag', () => {
    it('parses itag from a real-shaped videoplayback URL', () => {
      const url =
        'https://r1.googlevideo.com/videoplayback?expire=1&itag=137&sig=test'
      expect(parseItag(url)).toBe(137)
    })

    it('returns null when itag is missing', () => {
      const url = 'https://r1.googlevideo.com/videoplayback?expire=1&sig=test'
      expect(parseItag(url)).toBeNull()
    })

    it('returns null when itag is non-numeric', () => {
      const url = 'https://r1.googlevideo.com/videoplayback?itag=abc'
      expect(parseItag(url)).toBeNull()
    })

    it('rejects partially numeric, fractional, zero, and unsafe itags', () => {
      for (const value of ['137junk', '137.5', '0', '9007199254740992']) {
        expect(
          parseItag(`https://r1.googlevideo.com/videoplayback?itag=${value}`)
        ).toBeNull()
      }
    })

    it('parses itag from URL with ? prefix (alternative query format)', () => {
      const url = 'https://example.com/?itag=251'
      expect(parseItag(url)).toBe(251)
    })

    it('returns null for malformed URLs', () => {
      expect(parseItag('not-a-url')).toBeNull()
    })
  })

  describe('selectMuxStreams', () => {
    it('picks highest-height video-only + audio-only from mixed observed set using itagInfo', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/137-low', itag: 137 }, // video
        { url: 'https://r1/135-mid', itag: 135 }, // video
        { url: 'https://r1/251-audio', itag: 251 }, // audio
        { url: 'https://r1/18-av', itag: 18 }, // av (skipped)
      ]

      const itagInfo: Record<number, ItagInfo> = {
        137: { kind: 'video', height: 1080, bitrate: 2500 },
        135: { kind: 'video', height: 720, bitrate: 1200 },
        251: { kind: 'audio', bitrate: 128 },
        18: { kind: 'av', height: 360 },
      }

      const result = selectMuxStreams(observed, itagInfo)
      expect(result).toEqual({
        video: 'https://r1/137-low', // highest height (1080 > 720)
        audio: 'https://r1/251-audio',
      })
    })

    it('uses YT_ITAG_KIND fallback when itagInfo is unavailable', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/137-video', itag: 137 }, // video-only (in fallback)
        { url: 'https://r1/251-audio', itag: 251 }, // audio-only (in fallback)
        { url: 'https://r1/18-av', itag: 18 }, // av (skipped)
      ]

      const result = selectMuxStreams(observed)
      expect(result).toEqual({
        video: 'https://r1/137-video',
        audio: 'https://r1/251-audio',
      })
    })

    it('picks best video by height when using itagInfo', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/136-360p', itag: 136 },
        { url: 'https://r1/137-1080p', itag: 137 },
        { url: 'https://r1/135-720p', itag: 135 },
        { url: 'https://r1/251-audio', itag: 251 },
      ]

      const itagInfo: Record<number, ItagInfo> = {
        136: { kind: 'video', height: 360 },
        137: { kind: 'video', height: 1080 },
        135: { kind: 'video', height: 720 },
        251: { kind: 'audio', bitrate: 128 },
      }

      const result = selectMuxStreams(observed, itagInfo)
      expect(result?.video).toBe('https://r1/137-1080p')
    })

    it('picks best audio by bitrate when using itagInfo', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/137-video', itag: 137 },
        { url: 'https://r1/249-lowbr', itag: 249 },
        { url: 'https://r1/251-highbr', itag: 251 },
        { url: 'https://r1/140-medbr', itag: 140 },
      ]

      const itagInfo: Record<number, ItagInfo> = {
        137: { kind: 'video', height: 1080 },
        249: { kind: 'audio', bitrate: 50 },
        251: { kind: 'audio', bitrate: 160 },
        140: { kind: 'audio', bitrate: 128 },
      }

      const result = selectMuxStreams(observed, itagInfo)
      expect(result?.audio).toBe('https://r1/251-highbr')
    })

    it('returns null when no video-only streams present', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/251-audio', itag: 251 },
      ]

      const result = selectMuxStreams(observed)
      expect(result).toBeNull()
    })

    it('returns null when no audio-only streams present', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/137-video', itag: 137 },
      ]

      const result = selectMuxStreams(observed)
      expect(result).toBeNull()
    })

    it('returns null when only av (progressive) streams present', () => {
      const observed: ObservedStream[] = [{ url: 'https://r1/18-av', itag: 18 }]

      const result = selectMuxStreams(observed)
      expect(result).toBeNull()
    })

    it('skips unknown itags', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/137-video', itag: 137 },
        { url: 'https://r1/unknown', itag: 9999 }, // unknown, will be skipped
        { url: 'https://r1/251-audio', itag: 251 },
      ]

      const result = selectMuxStreams(observed)
      expect(result).toEqual({
        video: 'https://r1/137-video',
        audio: 'https://r1/251-audio',
      })
    })

    it('picks first video/audio when no height/bitrate info available', () => {
      const observed: ObservedStream[] = [
        { url: 'https://r1/137-first', itag: 137 },
        { url: 'https://r1/135-second', itag: 135 },
        { url: 'https://r1/251-first-audio', itag: 251 },
        { url: 'https://r1/140-second-audio', itag: 140 },
      ]

      const result = selectMuxStreams(observed)
      expect(result).toEqual({
        video: 'https://r1/137-first',
        audio: 'https://r1/251-first-audio',
      })
    })
  })

  describe('YT_ITAG_KIND', () => {
    it('contains video-only itags', () => {
      expect(YT_ITAG_KIND[137]).toBe('video')
      expect(YT_ITAG_KIND[248]).toBe('video')
      expect(YT_ITAG_KIND[399]).toBe('video')
    })

    it('contains audio-only itags', () => {
      expect(YT_ITAG_KIND[139]).toBe('audio')
      expect(YT_ITAG_KIND[251]).toBe('audio')
      expect(YT_ITAG_KIND[250]).toBe('audio')
    })

    it('contains av (progressive) itags', () => {
      expect(YT_ITAG_KIND[18]).toBe('av')
      expect(YT_ITAG_KIND[22]).toBe('av')
    })
  })
})
