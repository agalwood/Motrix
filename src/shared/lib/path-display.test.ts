import { describe, expect, it } from 'vitest'
import { formatNativePath, truncatePath } from './path-display'

describe('formatNativePath', () => {
  it.each([
    ['//nas/share//模型 文件.bin', '\\\\nas\\share\\模型 文件.bin'],
    ['\\\\nas\\share\\folder//file.bin', '\\\\nas\\share\\folder\\file.bin'],
    ['C:/downloads//file.bin', 'C:\\downloads\\file.bin'],
    ['C:/', 'C:\\'],
    ['///downloads//file.bin', '\\downloads\\file.bin'],
    ['', ''],
  ])(
    'formats Windows separators without losing the root: %s',
    (value, expected) => {
      expect(formatNativePath(value, 'win32')).toBe(expected)
    }
  )

  it.each(['darwin', 'linux', 'web'])(
    'preserves paths on %s, including literal backslashes',
    (platform) => {
      const value = '/downloads/a\\b//file.bin'
      expect(formatNativePath(value, platform)).toBe(value)
    }
  )
})

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const length = (value: string) => [...segmenter.segment(value)].length

describe('truncatePath', () => {
  it.each([
    '',
    '/',
    'C:\\',
    '\\\\nas\\share',
    '  /path with spaces/file.txt  ',
  ])('leaves fitting paths untouched: %s', (path) =>
    expect(truncatePath(path, length(path))).toBe(path)
  )

  it('preserves the last component when it fits beside the path prefix', () => {
    expect(truncatePath('/one/two/three/file.txt', 16)).toBe('/one/t…/file.txt')
    expect(truncatePath('C:\\one\\two\\three\\file.txt', 16)).toBe(
      'C:\\one…\\file.txt'
    )
  })

  it.each([
    '/Users/alice/Library/Application Support/Motrix/settings.json',
    'C:\\Users\\Alice\\AppData\\Roaming\\Motrix\\settings.json',
    '\\\\server\\share\\directory\\配置\\settings.json',
    '~/Downloads/a/very/long/directory/',
    '/目录/👩‍💻/e\u0301/very-long-filename.tar.gz',
    'long-file-without-any-directory-name.mkv',
  ])('respects the grapheme budget and keeps both ends of %s', (path) => {
    for (const maxChars of [3, 8, 16, 24, 40]) {
      const result = truncatePath(path, maxChars)
      expect(length(result)).toBeLessThanOrEqual(maxChars)
      expect(result[0]).toBe(path[0])
      expect(result.at(-1)).toBe(path.at(-1))
      if (length(path) > maxChars) expect(result).toContain('…')
    }
  })

  it('does not split emoji sequences or combining characters', () => {
    expect(truncatePath('a👨‍👩‍👧‍👦bcdef', 4)).toBe('a👨‍👩‍👧‍👦…f')
    expect(truncatePath('ae\u0301bcdef', 4)).toBe('ae\u0301…f')
    expect(truncatePath('/long/directory/e\u0301.txt', 12)).toMatch(
      /e\u0301\.txt$/
    )
  })

  it.each([
    [0, ''],
    [1, '…'],
    [2, 'a…'],
    [3, 'a…f'],
    [6, 'abcdef'],
  ] as const)('handles a budget of %s', (maxChars, expected) =>
    expect(truncatePath('abcdef', maxChars)).toBe(expected)
  )

  it.each([-1, 1.5, NaN, Infinity])(
    'rejects invalid budgets: %s',
    (maxChars) => {
      expect(() => truncatePath('/path', maxChars)).toThrow(RangeError)
    }
  )
})
