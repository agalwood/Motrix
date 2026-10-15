import { describe, expect, it } from 'vitest'
import {
  MAX_MANUAL_TASK_FILENAME_LENGTH,
  parseManualTaskInput,
  sanitizeFilename,
  sanitizeFilenameWithExtension,
} from '@/shared/manualTask'

describe('parseManualTaskInput', () => {
  it('trims and canonicalizes HTTP(S) input', () => {
    expect(
      parseManualTaskInput('  HTTPS://example.com/files/My%20File.zip  ')
    ).toEqual({
      ok: true,
      value: {
        kind: 'direct',
        url: 'https://example.com/files/My%20File.zip',
        suggestedFilename: 'My File.zip',
      },
    })
  })

  it('uses a stable fallback for a URL without a path filename', () => {
    expect(parseManualTaskInput('https://example.com/downloads/')).toEqual({
      ok: true,
      value: {
        kind: 'direct',
        url: 'https://example.com/downloads/',
        suggestedFilename: 'download',
      },
    })
  })

  it('uses magnet dn first and sanitizes it as a filename', () => {
    expect(
      parseManualTaskInput(
        'MAGNET:?xt=urn:btih:abcdef&dn=..%2FMovie%3A+Final.mkv'
      )
    ).toEqual({
      ok: true,
      value: {
        kind: 'magnet',
        uri: 'magnet:?xt=urn:btih:abcdef&dn=..%2FMovie%3A+Final.mkv',
        suggestedFilename: '.._Movie_ Final.mkv',
      },
    })
  })

  it('uses a stable generic name when a magnet has no dn', () => {
    expect(parseManualTaskInput('magnet:?xt=urn:btih:abcdef')).toMatchObject({
      ok: true,
      value: {
        kind: 'magnet',
        suggestedFilename: 'magnet-download',
      },
    })
  })

  it.each(['magnet:?', 'magnet:?dn=Name'])(
    'rejects a magnet without xt',
    (input) => {
      expect(parseManualTaskInput(input)).toEqual({
        ok: false,
        reason: 'invalid',
      })
    }
  )

  it.each([
    'http://172.16.50.14/file.zip',
    'https://192.168.1.10:8443/file.zip',
    'http://localhost/file.zip',
    'http://127.0.0.1/file.zip',
    'http://[::1]:8080/file.zip',
    'http://nas/file.zip',
    'https://例子.测试/file.zip',
  ])('accepts IP, local and internationalized HTTP hosts: %s', (input) => {
    expect(parseManualTaskInput(input)).toEqual({
      ok: true,
      value: {
        kind: 'direct',
        url: new URL(input).href,
        suggestedFilename: 'file.zip',
      },
    })
  })

  it.each(['', '   '])('rejects empty input %#', (input) => {
    expect(parseManualTaskInput(input)).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it.each([
    'file:///tmp/private',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'ftp://example.com/file.zip',
    'ftps://example.com/file.zip',
    'sftp://example.com/file.zip',
  ])('rejects unsupported input %s', (input) => {
    expect(parseManualTaskInput(input)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('rejects malformed URLs without echoing the input', () => {
    expect(parseManualTaskInput('not a URL')).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('keeps the suggested filename non-empty and within the MDXP limit', () => {
    const result = parseManualTaskInput(
      `https://example.com/${'a'.repeat(300)}.zip`
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.suggestedFilename.length).toBeGreaterThan(0)
    expect(result.value.suggestedFilename.length).toBeLessThanOrEqual(
      MAX_MANUAL_TASK_FILENAME_LENGTH
    )
  })

  it('removes Unicode bidi controls that can disguise an executable suffix', () => {
    expect(sanitizeFilename('invoice\u202Egnp.exe', 'download')).toBe(
      'invoicegnp.exe'
    )
    expect(
      sanitizeFilename(
        'safe\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069.png',
        'download'
      )
    ).toBe('safe.png')
    expect(
      parseManualTaskInput('https://example.com/files/invoice%E2%80%AEgnp.exe')
    ).toMatchObject({
      ok: true,
      value: { suggestedFilename: 'invoicegnp.exe' },
    })
  })

  it('replaces an incompatible or dangerous suffix with the trusted extension', () => {
    expect(sanitizeFilenameWithExtension('photo.exe', 'png', 'download')).toBe(
      'photo.png'
    )
    expect(
      sanitizeFilenameWithExtension('photo.jpeg', '.jpg', 'download')
    ).toBe('photo.jpg')
    expect(
      sanitizeFilenameWithExtension('photo.png.exe', 'png', 'download')
    ).toBe('photo.png')
  })

  it('keeps the canonical suffix within 255 code units without splitting a surrogate', () => {
    const filename = sanitizeFilenameWithExtension(
      `${'a'.repeat(250)}😀.exe`,
      'png',
      'download'
    )
    const exactFit = sanitizeFilenameWithExtension(
      `${'a'.repeat(249)}😀.exe`,
      'png',
      'download'
    )

    expect(filename).toBe(`${'a'.repeat(250)}.png`)
    expect(filename.length).toBeLessThanOrEqual(MAX_MANUAL_TASK_FILENAME_LENGTH)
    expect(exactFit).toBe(`${'a'.repeat(249)}😀.png`)
    expect(exactFit).toHaveLength(MAX_MANUAL_TASK_FILENAME_LENGTH)
  })
})
