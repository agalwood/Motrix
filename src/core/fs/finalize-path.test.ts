import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveFinalizeTarget,
  sanitizeFinalizeFilename,
  sanitizeFinalizePath,
} from './finalize-path'

describe('resolveFinalizeTarget', () => {
  it.each([
    ['/downloads/', 'sub/file', '/downloads/sub/file'],
    ['/', 'file', '/file'],
  ])('resolves %s + %s', (root, target, expected) => {
    expect(resolveFinalizeTarget(root, target, path.posix)).toBe(expected)
  })

  it.each(['', '.', '/downloads', '../file', '/downloads-other/file'])(
    'rejects %s',
    (target) => {
      expect(() =>
        resolveFinalizeTarget('/downloads', target, path.posix)
      ).toThrow('descendant')
    }
  )

  it.each([
    ['C:\\Downloads\\', 'c:\\downloads\\file'],
    ['C:\\', 'C:\\file'],
    ['\\\\server\\share\\', '\\\\SERVER\\share\\file'],
    ['C:\\Downloads', '\\\\?\\C:\\Downloads\\file'],
    ['\\\\?\\C:\\Downloads', 'C:\\Downloads\\file'],
    ['\\\\server\\share', '\\\\?\\UNC\\server\\share\\file'],
  ])('accepts equivalent Windows roots: %s -> %s', (root, target) => {
    expect(resolveFinalizeTarget(root, target, path.win32)).toBe(
      path.win32.resolve(root, target)
    )
  })

  it.each([
    ['C:\\Downloads', 'D:\\file'],
    ['C:\\Downloads', 'C:\\Downloads2\\file'],
    ['C:\\Downloads', '\\\\?\\C:\\Downloads'],
    ['\\\\server\\share', '\\\\server\\other\\file'],
  ])('rejects a different or equal Windows root: %s -> %s', (root, target) => {
    expect(() => resolveFinalizeTarget(root, target, path.win32)).toThrow(
      'descendant'
    )
  })
})

describe('sanitizeFinalizeFilename', () => {
  // Mirrors the sidecar matrix in packages/finalize-fs/src/sanitize.rs;
  // keep both tables in sync.
  it.each([
    ['normal.zip', 'normal.zip'],
    ['资料.tar.gz', '资料.tar.gz'],
    ['movie🎬.mp4', 'movie🎬.mp4'],
    ['file<name>.mp4', 'file_name_.mp4'],
    ['a:b.txt', 'a_b.txt'],
    ['say "hi"?', 'say _hi__'],
    ['star*|dot>', 'star__dot_'],
    ['path/injection.txt', 'path_injection.txt'],
    ['win\\dows.txt', 'win_dows.txt'],
    ['CON', 'CON_'],
    ['con.txt', 'con_.txt'],
    ['Com5', 'Com5_'],
    ['LPT9.tar.gz', 'LPT9_.tar.gz'],
    ['COM¹.log', 'COM¹_.log'],
    ['lpt².dat', 'lpt²_.dat'],
    ['aux', 'aux_'],
    ['nul.image.iso', 'nul_.image.iso'],
    ['conin$.txt', 'conin$_.txt'],
    ['CONOUT$.log', 'CONOUT$_.log'],
    ['trailing. ', 'trailing'],
    ['trailing...   ', 'trailing'],
    ['trailing.', 'trailing'],
    ['spaces   .txt', 'spaces   .txt'],
    ['.hidden', '.hidden'],
    ['.', 'download'],
    ['..', 'download'],
    ['', 'download'],
    ['   ', 'download'],
    ['???', '___'],
    ['control\tchar\n', 'control_char_'],
    ['console\u{7f}.log', 'console_.log'],
    ['CON. ', 'CON_'],
    ['degree°name', 'degree°name'],
  ])('sanitizes %j', (input, expected) => {
    expect(sanitizeFinalizeFilename(input)).toBe(expected)
  })

  it.each(['CON', 'file.', 'a/b\\c:d', 'spaces . ', 'name<?>.txt', ''])(
    'is idempotent for %j',
    (input) => {
      const once = sanitizeFinalizeFilename(input)
      expect(sanitizeFinalizeFilename(once)).toBe(once)
    }
  )

  it('clamps long components on character boundaries while keeping extensions', () => {
    expect(Buffer.byteLength(sanitizeFinalizeFilename('a'.repeat(300)))).toBe(
      254
    )
    expect(sanitizeFinalizeFilename(`${'字'.repeat(100)}.zip`)).toBe(
      `${'字'.repeat(83)}.zip`
    )
    expect(
      Buffer.byteLength(
        sanitizeFinalizeFilename(`${'d'.repeat(300)}.${'x'.repeat(200)}`)
      )
    ).toBe(254)
    expect(sanitizeFinalizeFilename(`${'b'.repeat(300)}.`)).not.toMatch(
      /[. ]$/u
    )
  })

  it('clamps components at the byte budget boundary exactly', () => {
    // 253 and 254 bytes are at or under the budget and survive untouched;
    // 255 bytes is one over and clamps to exactly 254, leaving room for a
    // conflict suffix (` (1)`, `.N`) that publication may append later.
    for (const bytes of [253, 254]) {
      expect(sanitizeFinalizeFilename('a'.repeat(bytes))).toBe(
        'a'.repeat(bytes)
      )
    }
    expect(sanitizeFinalizeFilename('a'.repeat(255))).toBe('a'.repeat(254))

    // With a kept extension the stem absorbs the clamp: a 251-byte stem plus
    // ".zip" totals 255, so the stem drops exactly one byte.
    expect(sanitizeFinalizeFilename(`${'a'.repeat(251)}.zip`)).toBe(
      `${'a'.repeat(250)}.zip`
    )
  })
})

describe('sanitizeFinalizePath', () => {
  it.each([
    ['/downloads/normal.zip', '/downloads/normal.zip'],
    ['/downloads/CON.txt ', '/downloads/CON_.txt'],
    ['/downloads/nested/bad:name.bin', '/downloads/nested/bad_name.bin'],
  ])('sanitizes only the final component of %s', (input, expected) => {
    expect(sanitizeFinalizePath(input, path.posix)).toBe(expected)
  })

  it('keeps Windows drive and directory components untouched', () => {
    expect(sanitizeFinalizePath('C:\\Downloads<Sub>\\CON', path.win32)).toBe(
      'C:\\Downloads<Sub>\\CON_'
    )
  })
})
