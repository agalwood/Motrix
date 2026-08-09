import { describe, expect, it } from 'vitest'
import { ffmpegSatisfies, parseVersion } from './ffmpeg-semver'

describe('ffmpeg-semver', () => {
  it('parses version strings into tuples', () => {
    expect(parseVersion('6.0.1')).toEqual([6, 0, 1])
    expect(parseVersion('5.1')).toEqual([5, 1, 0])
    expect(parseVersion('4')).toEqual([4, 0, 0])
  })

  it('parses ffmpeg banner version like "6.0.1-tessus"', () => {
    expect(parseVersion('6.0.1-tessus')).toEqual([6, 0, 1])
  })

  it('returns null for unparseable strings', () => {
    expect(parseVersion('not-a-version')).toBeNull()
  })

  it('satisfies >=N.N.N range', () => {
    expect(ffmpegSatisfies('6.0.1', '>=4.4')).toBe(true)
    expect(ffmpegSatisfies('4.4.0', '>=4.4')).toBe(true)
    expect(ffmpegSatisfies('4.3.9', '>=4.4')).toBe(false)
    expect(ffmpegSatisfies('3.4.2', '>=4.4')).toBe(false)
  })

  it('range null → always satisfies', () => {
    expect(ffmpegSatisfies('3.0.0', null)).toBe(true)
  })

  it('returns false when version unparseable', () => {
    expect(ffmpegSatisfies('garbage', '>=4.4')).toBe(false)
  })

  it('returns false when range unparseable', () => {
    expect(ffmpegSatisfies('5.0.0', '<5.0')).toBe(false)
  })
})
