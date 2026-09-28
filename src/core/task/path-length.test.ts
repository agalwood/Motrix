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
  it('accepts the #2183 destination now that the engine opens long paths', () => {
    // 262 characters used to overrun MAX_PATH. aria2 passes such paths
    // through the \\?\ namespace since 1.37.0-motrix.16, so it fits.
    expect(ISSUE_2183).toHaveLength(262)
    expect(exceedsPathLimit(ISSUE_2183, 'win32')).toBeNull()
  })

  it('uses the extended-length limit, less the engine prefix', () => {
    // 32,767 UTF-16 units, minus the longest prefix aria2 adds (\\?\UNC\).
    expect(WINDOWS_MAX_PATH).toBe(32_767 - '\\\\?\\UNC\\'.length)
  })

  it('accepts a path exactly at the limit', () => {
    const atLimit = `C:\\${'a'.repeat(WINDOWS_MAX_PATH - 3)}`
    expect(atLimit).toHaveLength(WINDOWS_MAX_PATH)
    expect(exceedsPathLimit(atLimit, 'win32')).toBeNull()
  })

  it('flags one character past the limit', () => {
    const overLimit = `C:\\${'a'.repeat(WINDOWS_MAX_PATH - 2)}`
    expect(exceedsPathLimit(overLimit, 'win32')).toEqual({
      length: WINDOWS_MAX_PATH + 1,
      limit: WINDOWS_MAX_PATH,
    })
  })

  it('never flags on POSIX platforms', () => {
    const huge = `/d/${'a'.repeat(WINDOWS_MAX_PATH)}`
    expect(exceedsPathLimit(huge, 'darwin')).toBeNull()
    expect(exceedsPathLimit(huge, 'linux')).toBeNull()
  })

  it('ignores a path already escaped with the long-path prefix', () => {
    const huge = `\\\\?\\C:\\${'a'.repeat(WINDOWS_MAX_PATH)}`
    expect(exceedsPathLimit(huge, 'win32')).toBeNull()
  })

  it('measures UTF-16 code units, not code points', () => {
    // An astral character costs Windows two units: this path is under the
    // limit by code points but over it by units.
    const pairs = Math.ceil(WINDOWS_MAX_PATH / 2)
    const emoji = `C:\\${'\u{1F600}'.repeat(pairs)}`
    expect([...emoji].length).toBeLessThan(WINDOWS_MAX_PATH)
    expect(exceedsPathLimit(emoji, 'win32')?.length).toBe(3 + pairs * 2)
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
    const slightly = `${dir}\\${'a'.repeat(WINDOWS_MAX_PATH)}`
    const badly = `${dir}\\${'b'.repeat(WINDOWS_MAX_PATH * 2)}`
    expect(findPathOverrun([slightly, badly], 'win32')?.path).toBe(badly)
  })

  it('skips empty candidates', () => {
    expect(findPathOverrun(['', `${dir}\\a.bin`], 'win32')).toBeNull()
  })

  it('is inert off win32', () => {
    expect(
      findPathOverrun([`${dir}\\${'b'.repeat(WINDOWS_MAX_PATH)}`], 'linux')
    ).toBeNull()
  })
})
