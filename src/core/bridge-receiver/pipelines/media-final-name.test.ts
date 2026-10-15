import { describe, expect, it } from 'vitest'
import { ensureMediaExtension, ensureMp3Extension } from './media-final-name'

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

describe('ensureMp3Extension', () => {
  it('appends .mp3 to an extensionless name', () => {
    expect(ensureMp3Extension('Human Title')).toBe('Human Title.mp3')
    expect(ensureMp3Extension('BV14vJg6ZEd4')).toBe('BV14vJg6ZEd4.mp3')
  })

  it('replaces the media extension a resolved stream or page name carried', () => {
    expect(ensureMp3Extension('audio.m4a')).toBe('audio.mp3')
    expect(ensureMp3Extension('video.mp4')).toBe('video.mp3')
    expect(ensureMp3Extension('clip.webm')).toBe('clip.mp3')
    expect(ensureMp3Extension('a.MP4')).toBe('a.mp3')
  })

  it('is idempotent for an already-mp3 name', () => {
    expect(ensureMp3Extension('song.mp3')).toBe('song.mp3')
  })

  it('keeps non-media dotted titles intact and appends', () => {
    expect(ensureMp3Extension('Ep.1 - Title')).toBe('Ep.1 - Title.mp3')
  })
})
