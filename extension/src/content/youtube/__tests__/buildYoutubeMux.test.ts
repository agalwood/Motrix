import { describe, expect, it } from 'vitest'
import {
  buildYoutubeMux,
  playerResponseToItagInfo,
} from '@/content/youtube/buildYoutubeMux'

describe('buildYoutubeMux', () => {
  it('returns a mux DetectedMedia with the correct fields', () => {
    const streams = {
      video: 'https://r1.googlevideo.com/videoplayback?itag=137',
      audio: 'https://r1.googlevideo.com/videoplayback?itag=251',
    }
    const ctx = {
      pageUrl: 'https://www.youtube.com/watch?v=abc123',
      pageTitle: 'Test Video',
      now: 1000,
    }
    const result = buildYoutubeMux(streams, ctx)
    expect(result.kind).toBe('mux')
    expect(result.url).toBe(streams.video)
    expect(result.audioUrl).toBe(streams.audio)
    expect(result.pageUrl).toBe(ctx.pageUrl)
    expect(result.pageTitle).toBe(ctx.pageTitle)
    expect(result.detectedAt).toBe(ctx.now)
  })

  it('sets url to video stream and audioUrl to audio stream', () => {
    const videoUrl = 'https://r1.googlevideo.com/videoplayback?itag=248'
    const audioUrl = 'https://r1.googlevideo.com/videoplayback?itag=251'
    const result = buildYoutubeMux(
      { video: videoUrl, audio: audioUrl },
      { pageUrl: 'https://youtube.com/watch', pageTitle: 'Title', now: 42 }
    )
    expect(result.url).toBe(videoUrl)
    expect(result.audioUrl).toBe(audioUrl)
  })
})

describe('playerResponseToItagInfo', () => {
  it('classifies video-only formats (no audioQuality)', () => {
    const formats = [
      {
        itag: 137,
        mimeType: 'video/mp4; codecs="avc1"',
        height: 1080,
        bitrate: 2500,
      },
    ]
    const result = playerResponseToItagInfo(formats)
    expect(result[137]).toEqual({ kind: 'video', height: 1080, bitrate: 2500 })
  })

  it('classifies audio-only formats', () => {
    const formats = [
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 128 },
    ]
    const result = playerResponseToItagInfo(formats)
    expect(result[251]).toEqual({ kind: 'audio', bitrate: 128 })
  })

  it('classifies progressive (av) formats via audioQuality field', () => {
    const formats = [
      {
        itag: 18,
        mimeType: 'video/mp4; codecs="avc1,mp4a"',
        height: 360,
        bitrate: 500,
        audioQuality: 'AUDIO_QUALITY_LOW',
      },
    ]
    const result = playerResponseToItagInfo(formats)
    expect(result[18]?.kind).toBe('av')
  })

  it('handles a mixed set of formats', () => {
    const formats = [
      {
        itag: 248,
        mimeType: 'video/webm; codecs="vp9"',
        height: 1080,
        bitrate: 3000,
      },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160 },
      {
        itag: 137,
        mimeType: 'video/mp4; codecs="avc1"',
        height: 1080,
        bitrate: 2500,
      },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a"', bitrate: 128 },
    ]
    const result = playerResponseToItagInfo(formats)
    expect(result[248]?.kind).toBe('video')
    expect(result[251]?.kind).toBe('audio')
    expect(result[137]?.kind).toBe('video')
    expect(result[140]?.kind).toBe('audio')
  })

  it('skips entries without an itag', () => {
    const formats = [{ mimeType: 'video/mp4', height: 720 }]
    const result = playerResponseToItagInfo(formats)
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('skips non-object entries', () => {
    const formats = [null, 42, 'hello', { itag: 137, mimeType: 'video/mp4' }]
    const result = playerResponseToItagInfo(formats)
    expect(Object.keys(result)).toHaveLength(1)
    expect(result[137]?.kind).toBe('video')
  })

  it('omits height and bitrate when not numeric', () => {
    const formats = [{ itag: 251, mimeType: 'audio/webm' }]
    const result = playerResponseToItagInfo(formats)
    expect(result[251]).toEqual({ kind: 'audio' })
    expect('height' in (result[251] ?? {})).toBe(false)
    expect('bitrate' in (result[251] ?? {})).toBe(false)
  })

  it('returns empty object for empty input', () => {
    const result = playerResponseToItagInfo([])
    expect(result).toEqual({})
  })
})
