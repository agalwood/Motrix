import path from 'node:path'
import type { AutoCategorizeSettings } from '@shared/schemas/auto-categorize'
import { describe, expect, it } from 'vitest'
import {
  autoCategorizeSaveDir,
  extensionFromName,
  extensionFromTaskSource,
} from './auto-categorize'

const enabled: AutoCategorizeSettings = {
  enabled: true,
  rules: [
    { exts: ['mp4', 'mkv', 'webm'], folder: 'Video' },
    { exts: ['zip', '7z'], folder: 'Archives' },
  ],
}

describe('extensionFromName', () => {
  it.each([
    ['movie.mkv', 'mkv'],
    ['archive.TAR.GZ', 'gz'],
    ['deep/nested/path/song.mp3', 'mp3'],
    ['windows\\path\\file.EXE', 'exe'],
    ['report.final.pdf', 'pdf'],
  ])('extracts %s → %s', (name, ext) => {
    expect(extensionFromName(name)).toBe(ext)
  })

  it.each([
    ['no-extension'],
    ['.hidden'],
    ['trailing.'],
    [''],
    ['bad-image.svg%00'],
    ['x'.repeat(20)],
  ])('rejects %s', (name) => {
    expect(extensionFromName(name)).toBeNull()
  })
})

describe('extensionFromTaskSource', () => {
  it('reads the magnet dn= hint', () => {
    expect(
      extensionFromTaskSource('magnet:?xt=urn:btih:ABCDEF&dn=Movie+2024.mkv')
    ).toBe('mkv')
  })

  it('returns null for magnets without dn', () => {
    expect(extensionFromTaskSource('magnet:?xt=urn:btih:ABCDEF')).toBeNull()
  })

  it('reads the URL path basename and decodes it', () => {
    expect(
      extensionFromTaskSource(
        'https://example.com/dl/Ubuntu%2024.04.iso?token=1'
      )
    ).toBe('iso')
  })

  it('returns null for extensionless URLs', () => {
    expect(extensionFromTaskSource('https://example.com/download')).toBeNull()
  })

  it('treats bare names directly', () => {
    expect(extensionFromTaskSource('setup.exe')).toBe('exe')
  })

  it('returns null for empty input', () => {
    expect(extensionFromTaskSource('   ')).toBeNull()
  })
})

describe('autoCategorizeSaveDir', () => {
  it('routes matched extensions under the rule folder', () => {
    const base = path.join('down', 'loads')
    expect(autoCategorizeSaveDir(enabled, 'mkv', base)).toBe(
      path.join(base, 'Video')
    )
    expect(autoCategorizeSaveDir(enabled, '7z', base)).toBe(
      path.join(base, 'Archives')
    )
  })

  it('falls back to the default dir for unmatched extensions', () => {
    expect(autoCategorizeSaveDir(enabled, 'pdf', path.join('dl'))).toBe(
      path.join('dl')
    )
  })

  it('falls back when disabled or hint missing', () => {
    expect(
      autoCategorizeSaveDir(
        { ...enabled, enabled: false },
        'mkv',
        path.join('dl')
      )
    ).toBe(path.join('dl'))
    expect(autoCategorizeSaveDir(enabled, null, path.join('dl'))).toBe(
      path.join('dl')
    )
  })

  it('never touches an empty sentinel default dir', () => {
    expect(autoCategorizeSaveDir(enabled, 'mkv', '')).toBe('')
  })
})
