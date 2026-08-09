import { describe, expect, it } from 'vitest'
import { ensureMediaExtension } from './media-final-name'

describe('ensureMediaExtension', () => {
  it('appends .mp4 to an extensionless name (the bilibili bvid case)', () => {
    expect(ensureMediaExtension('BV14vJg6ZEd4', 'mp4')).toBe('BV14vJg6ZEd4.mp4')
  })

  it('appends .mkv when the container is mkv', () => {
    expect(ensureMediaExtension('clip', 'mkv')).toBe('clip.mkv')
  })

  it('maps an HLS ts input container to an mp4 output extension', () => {
    expect(ensureMediaExtension('stream', 'ts')).toBe('stream.mp4')
  })

  it('leaves a name that already has the container extension unchanged', () => {
    expect(ensureMediaExtension('video.mp4', 'mp4')).toBe('video.mp4')
  })

  it('trusts any known media extension rather than double-appending', () => {
    expect(ensureMediaExtension('movie.mkv', 'mp4')).toBe('movie.mkv')
    expect(ensureMediaExtension('clip.webm', 'mp4')).toBe('clip.webm')
    expect(ensureMediaExtension('a.MP4', 'mp4')).toBe('a.MP4')
  })

  it('appends when the dot is not a media extension (e.g. a dotted title)', () => {
    expect(ensureMediaExtension('Ep.1 - Title', 'mp4')).toBe('Ep.1 - Title.mp4')
  })
})
