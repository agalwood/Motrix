import { analyzeDownloadInput } from '@shared/lib/download-source-input'
import { describe, expect, it } from 'vitest'
import { getUrlDisplayParts, getUrlErrorRange } from './url-editor-presentation'

describe('URL editor presentation', () => {
  it.each([
    ['  htps://example.com  ', 'htps'],
    ['\nhttps://example.com/a\n  https://example.com/%zz', '%'],
    ['https://example.com/dir\\file?sig=%2f+%252F', '\\'],
    ['https://example.com/file name', ' '],
  ])(
    'maps precise diagnostics back to the original input: %s',
    (text, expected) => {
      const line = analyzeDownloadInput(text).at(-1)!
      const range = getUrlErrorRange(line)!
      expect(line.raw.slice(range.start, range.end)).toBe(expected)
      const parts = getUrlDisplayParts(line.raw, line)
      expect(parts.map((part) => part.text).join('')).toBe(line.raw)
      expect(
        parts
          .filter((part) => part.kind === 'error')
          .map((part) => part.text)
          .join('')
      ).toBe(expected)
    }
  )

  it.each([
    'missing scheme',
    'https://',
    'https://example.com:99999/a',
    'https://example.com/../file',
    'magnet:?xt=bad',
  ])('does not pretend a whole-URL diagnostic pinpoints a token: %s', (raw) => {
    expect(getUrlErrorRange(analyzeDownloadInput(raw)[0])).toBeUndefined()
  })

  it.each([
    ' https://例子.测试/中文?sig=%2f+%252F#section ',
    'https://[::1]:8080/file',
    'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
    '<img src=x onerror=alert(1)>',
    '',
  ])(
    'paints original text without serialization, decoding or HTML: %s',
    (raw) => {
      const parts = getUrlDisplayParts(raw, analyzeDownloadInput(raw)[0])
      expect(parts.map((part) => part.text).join('')).toBe(raw)
    }
  )
})
