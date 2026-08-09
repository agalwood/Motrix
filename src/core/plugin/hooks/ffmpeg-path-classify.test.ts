import { describe, expect, it } from 'vitest'
import { classifyFfmpegOutput } from './ffmpeg-path-classify'

describe('classifyFfmpegOutput', () => {
  const saveDir = '/var/data/downloads/task-1'
  const pluginStorageRoot = '/var/data/plugins/alice.foo/storage'

  it('returns "saveDir" when output resolves under saveDir', () => {
    expect(
      classifyFfmpegOutput(
        '/var/data/downloads/task-1/out.mp4',
        saveDir,
        pluginStorageRoot
      )
    ).toBe('saveDir')
  })

  it('returns "saveDir" for relative paths that resolve under saveDir', () => {
    expect(classifyFfmpegOutput('out.mp4', saveDir, pluginStorageRoot)).toBe(
      'saveDir'
    )
  })

  it('returns "pluginStorage" when output resolves under plugin storage root', () => {
    expect(
      classifyFfmpegOutput(
        '/var/data/plugins/alice.foo/storage/thumbs/x.jpg',
        saveDir,
        pluginStorageRoot
      )
    ).toBe('pluginStorage')
  })

  it('returns "other" when output is outside both roots', () => {
    expect(
      classifyFfmpegOutput('/tmp/escape.mp4', saveDir, pluginStorageRoot)
    ).toBe('other')
  })

  it('handles trailing slashes on saveDir', () => {
    expect(
      classifyFfmpegOutput(
        '/var/data/downloads/task-1/out.mp4',
        '/var/data/downloads/task-1/',
        pluginStorageRoot
      )
    ).toBe('saveDir')
  })

  it('handles trailing slashes on pluginStorageRoot', () => {
    expect(
      classifyFfmpegOutput(
        '/var/data/plugins/alice.foo/storage/thumbs/x.jpg',
        saveDir,
        '/var/data/plugins/alice.foo/storage/'
      )
    ).toBe('pluginStorage')
  })

  it('returns "other" when either root is empty (degenerate input)', () => {
    expect(classifyFfmpegOutput('/anything.mp4', '', pluginStorageRoot)).toBe(
      'other'
    )
    expect(classifyFfmpegOutput('/anything.mp4', saveDir, '')).toBe('other')
  })

  it('does not treat saveDir prefix lookalikes as saveDir', () => {
    expect(
      classifyFfmpegOutput(
        '/var/data/downloads/task-12/out.mp4',
        '/var/data/downloads/task-1',
        pluginStorageRoot
      )
    ).toBe('other')
  })

  it('rejects relative path that escapes saveDir via ..', () => {
    expect(
      classifyFfmpegOutput('../sibling/x.mp4', saveDir, pluginStorageRoot)
    ).toBe('other')
  })
})
