import { describe, expect, it } from 'vitest'
import { taijiFilePadding, toTaijiSelection } from './taiji-file-selection'

describe('taiji padding-aware selection', () => {
  it('keeps domain file identities while converting the native selection indices', () => {
    expect(toTaijiSelection('1,3-4', [false, true, false, false])).toBe('1,2,3')
    expect(toTaijiSelection('3', [false, true, false])).toBe('2')
    expect(toTaijiSelection('1-3', [false, false, false])).toBe('1,2,3')
  })
  it('rejects padding-only, inverted and out-of-range selections', () => {
    for (const value of ['2', '3-1', '0', '1-9999999999999'])
      expect(() => toTaijiSelection(value, [false, true, false])).toThrow()
  })
  it('requires a complete, ordered file projection before changing selection', () => {
    expect(
      taijiFilePadding([
        { index: '1', padding: 'false' },
        { index: '2', padding: 'true' },
      ])
    ).toEqual([false, true])
    expect(() => taijiFilePadding([{ index: '2', padding: 'false' }])).toThrow()
  })
})
