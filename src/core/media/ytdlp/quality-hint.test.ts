import { describe, expect, it } from 'vitest'
import { parseQualityHint } from './quality-hint'

describe('parseQualityHint', () => {
  it('maps the mp3 token to an audio-only hint', () => {
    expect(parseQualityHint('mp3')).toEqual({ audioOnly: true })
    expect(parseQualityHint(' MP3 ')).toEqual({ audioOnly: true })
  })

  it('maps height labels to a height cap', () => {
    expect(parseQualityHint('1080p')).toEqual({ height: 1080 })
    expect(parseQualityHint('720p')).toEqual({ height: 720 })
    expect(parseQualityHint('2160p')).toEqual({ height: 2160 })
    expect(parseQualityHint('4K')).toBeUndefined()
  })

  it('treats the no-op labels as no hint at all', () => {
    for (const label of ['auto', 'file', 'source', 'original', 'AUTO']) {
      expect(parseQualityHint(label)).toBeUndefined()
    }
  })

  it('rejects absent, non-string and malformed labels', () => {
    expect(parseQualityHint(undefined)).toBeUndefined()
    expect(parseQualityHint(null)).toBeUndefined()
    expect(parseQualityHint('')).toBeUndefined()
    expect(parseQualityHint('   ')).toBeUndefined()
    expect(parseQualityHint('1080')).toBeUndefined()
    expect(parseQualityHint('1080 px')).toBeUndefined()
    expect(parseQualityHint('bv*[height<=720]+ba')).toBeUndefined()
  })

  it('guards against absurd heights before they reach a selector', () => {
    expect(parseQualityHint('9999p')).toBeUndefined()
    expect(parseQualityHint('4320p')).toEqual({ height: 4320 })
  })
})
