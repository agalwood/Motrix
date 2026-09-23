import { describe, expect, it } from 'vitest'
import {
  exceedsPathLimit,
  extractAria2FilePath,
  findPathOverrun,
  WINDOWS_MAX_PATH,
} from './path-length'

// The exact destination from agalwood/Motrix#2183 (262 chars).
const ISSUE_2183 = String.raw`F:\Game\Dead Cells (2018).motrix\Dead Cells (2018)\Bonuses\Dead Cells - Demake Soundtrack\FLAC Yoann Laulan - Dead Cells - Soundtrack Part 2 (Demake) FLAC\Yoann Laulan - Dead Cells - Soundtrack Part 2 (Demake) - 21 The Time Keeper Formerly Known As Assassin.flac`

describe('exceedsPathLimit', () => {
  it('flags the #2183 destination on win32', () => {
    expect(ISSUE_2183).toHaveLength(262)
    expect(exceedsPathLimit(ISSUE_2183, 'win32')).toEqual({
      length: 262,
      limit: WINDOWS_MAX_PATH,
    })
  })

  it('accepts a path exactly at the limit', () => {
    const atLimit = `C:\\${'a'.repeat(WINDOWS_MAX_PATH - 3)}`
    expect(atLimit).toHaveLength(WINDOWS_MAX_PATH)
    expect(exceedsPathLimit(atLimit, 'win32')).toBeNull()
  })

  it('flags one character past the limit', () => {
    const overLimit = `C:\\${'a'.repeat(WINDOWS_MAX_PATH - 2)}`
    expect(exceedsPathLimit(overLimit, 'win32')?.length).toBe(
      WINDOWS_MAX_PATH + 1
    )
  })

  it('never flags on platforms without the MAX_PATH cap', () => {
    expect(exceedsPathLimit(ISSUE_2183, 'darwin')).toBeNull()
    expect(exceedsPathLimit(ISSUE_2183, 'linux')).toBeNull()
  })

  it('ignores a path already escaped with the long-path prefix', () => {
    expect(exceedsPathLimit(`\\\\?\\${ISSUE_2183}`, 'win32')).toBeNull()
  })

  it('measures UTF-16 code units, not code points', () => {
    // An astral emoji is two UTF-16 units to Windows, so a path that looks
    // short by code points can still overrun MAX_PATH.
    const emoji = '\u{1F600}'.repeat(130) // 130 code points, 260 units
    expect(exceedsPathLimit(`C:\\${emoji}`, 'win32')?.length).toBe(263)
  })
})

describe('extractAria2FilePath', () => {
  it('pulls the path out of the EX_FILE_OPEN message', () => {
    expect(
      extractAria2FilePath(
        'Failed to open the file F:/Game/x/y.flac, cause: The system cannot find the path specified.'
      )
    ).toBe('F:/Game/x/y.flac')
  })

  it('keeps commas that belong to the filename', () => {
    expect(
      extractAria2FilePath(
        'Failed to open the file C:/d/Hello, World (2018).mkv, cause: nope'
      )
    ).toBe('C:/d/Hello, World (2018).mkv')
  })

  it('returns null for an unrelated message', () => {
    expect(extractAria2FilePath('Timeout')).toBeNull()
    expect(extractAria2FilePath(null)).toBeNull()
  })
})

describe('findPathOverrun', () => {
  const dir = `C:\\Downloads\\${'d'.repeat(100)}`

  it('returns null when every candidate fits', () => {
    expect(findPathOverrun([`${dir}\\a.bin`], 'win32')).toBeNull()
  })

  it('reports the worst offender, not the first', () => {
    const slightly = `${dir}\\${'a'.repeat(160)}`
    const badly = `${dir}\\${'b'.repeat(400)}`
    expect(findPathOverrun([slightly, badly], 'win32')?.path).toBe(badly)
  })

  it('skips empty candidates', () => {
    expect(findPathOverrun(['', `${dir}\\a.bin`], 'win32')).toBeNull()
  })

  it('is inert off win32', () => {
    expect(findPathOverrun([`${dir}\\${'b'.repeat(400)}`], 'linux')).toBeNull()
  })
})
