import { describe, expect, it } from 'vitest'
import { extractExtension, relativizeTorrentPath } from './path-ext'

describe('extractExtension', () => {
  it('returns lower-cased dot-suffix', () => {
    expect(extractExtension('foo/bar.MP4')).toBe('.mp4')
  })
  it('returns empty for no extension', () => {
    expect(extractExtension('foo/bar')).toBe('')
  })
  it('uses last dot for compound suffixes', () => {
    expect(extractExtension('archive.tar.gz')).toBe('.gz')
  })
  it('treats dotfile (leading-dot, no other dot) as no extension', () => {
    expect(extractExtension('foo/.bashrc')).toBe('')
  })
  it('handles backslash separator (Windows)', () => {
    expect(extractExtension('C:\\path\\to\\file.ZIP')).toBe('.zip')
  })
})

describe('relativizeTorrentPath', () => {
  it('strips diskPath prefix for single-file BT (.motrix container)', () => {
    expect(
      relativizeTorrentPath(
        '/Users/x/Downloads/ubuntu-25.10-desktop-amd64.iso.motrix/ubuntu-25.10-desktop-amd64.iso',
        '/Users/x/Downloads/ubuntu-25.10-desktop-amd64.iso.motrix'
      )
    ).toBe('ubuntu-25.10-desktop-amd64.iso')
  })

  it('strips diskPath prefix for multi-file BT (preserves subdirs)', () => {
    expect(
      relativizeTorrentPath(
        '/Users/x/Downloads/Album.motrix/CD1/track01.flac',
        '/Users/x/Downloads/Album.motrix'
      )
    ).toBe('CD1/track01.flac')
  })

  it('falls back to basename when no anchor matches', () => {
    expect(
      relativizeTorrentPath('/Users/x/Downloads/file.zip', null, undefined, '')
    ).toBe('file.zip')
  })

  it('tries multiple anchors in order', () => {
    expect(
      relativizeTorrentPath(
        '/save/inner/file.bin',
        '/wrong/path',
        '/save/inner'
      )
    ).toBe('file.bin')
  })

  it('handles trailing separator on anchor', () => {
    expect(relativizeTorrentPath('/save/dir/file.bin', '/save/dir/')).toBe(
      'file.bin'
    )
  })

  it('handles backslash separators (Windows)', () => {
    expect(
      relativizeTorrentPath(
        'C:\\Users\\x\\Downloads\\torrent.motrix\\file.iso',
        'C:\\Users\\x\\Downloads\\torrent.motrix'
      )
    ).toBe('file.iso')
  })

  it('returns input unchanged when no separator and no match', () => {
    expect(relativizeTorrentPath('plain.txt')).toBe('plain.txt')
  })
})
