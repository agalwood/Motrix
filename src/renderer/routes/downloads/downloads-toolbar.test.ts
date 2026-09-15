import { describe, expect, it } from 'vitest'
import { toolbarActionCount } from './downloads-toolbar'

describe.each([
  { density: 'standard', compact: false, full: 342, pair: 308, closed: 148 },
  { density: 'compact', compact: true, full: 324, pair: 296, closed: 124 },
])('$density toolbar overflow priority', ({ compact, full, pair, closed }) => {
  it('reserves readable search space before retaining lower priority buttons', () => {
    expect(toolbarActionCount(full, true, 3, compact)).toBe(3)
    expect(toolbarActionCount(full - 1, true, 3, compact)).toBe(2)
    expect(toolbarActionCount(pair, true, 3, compact)).toBe(2)
    expect(toolbarActionCount(pair - 1, true, 3, compact)).toBe(1)
    expect(toolbarActionCount(closed, false, 3, compact)).toBe(3)
    expect(toolbarActionCount(closed - 1, false, 3, compact)).toBe(2)
  })
  it('requires spare space before restoring a hidden button', () => {
    expect(toolbarActionCount(full + 7, true, 2, compact)).toBe(2)
    expect(toolbarActionCount(full + 8, true, 2, compact)).toBe(3)
    expect(toolbarActionCount(pair + 7, true, 1, compact)).toBe(1)
    expect(toolbarActionCount(pair + 8, true, 1, compact)).toBe(2)
  })
})
