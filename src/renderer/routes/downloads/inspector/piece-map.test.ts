import { describe, expect, it } from 'vitest'
import { aggregatePieceMap } from './piece-map'

describe('piece map aggregation', () => {
  it('reads most-significant bits first and ignores padding and invalid/missing hex', () => {
    expect(aggregatePieceMap('8', 4)).toEqual({
      cells: ['done', 'pending', 'pending', 'pending'],
      donePieces: 1,
      pendingPieces: 3,
    })
    expect(aggregatePieceMap('FF', 5)).toEqual({
      cells: Array(5).fill('done'),
      donePieces: 5,
      pendingPieces: 0,
    })
    expect(aggregatePieceMap('Fg', 12).donePieces).toBe(4)
    expect(aggregatePieceMap('', 0)).toEqual({
      cells: [],
      donePieces: 0,
      pendingPieces: 0,
    })
  })

  it.each([1, 3, 4, 5, 3999, 4000, 4001, 7458, 297623])(
    'preserves bucket coloring and counts real completed pieces for %i pieces',
    (count) => {
      const pattern = '9a7C0f'
      const bitfield = pattern.repeat(Math.ceil(count / 24))
      const bits = Array.from(
        { length: count },
        (_, index) =>
          (Number.parseInt(bitfield[Math.floor(index / 4)], 16) >>
            (3 - (index % 4))) &
          1
      )
      const stride = Math.ceil(count / 4000)
      const cells = []
      for (let start = 0; start < count; start += stride) {
        const bucket = bits.slice(start, start + stride)
        cells.push(
          bucket.reduce((sum, bit) => sum + bit, 0) * 2 >= bucket.length
            ? 'done'
            : 'pending'
        )
      }
      const result = aggregatePieceMap(bitfield, count)
      expect(result.cells).toEqual(cells)
      expect(result.donePieces).toBe(bits.reduce((sum, bit) => sum + bit, 0))
      expect(result.pendingPieces + result.donePieces).toBe(count)
    }
  )

  it('keeps memory bounded for a huge declared piece count with truncated metadata', () => {
    const result = aggregatePieceMap('8', 100_000_000)
    expect(result.cells).toHaveLength(4000)
    expect(result.donePieces).toBe(1)
    expect(result.pendingPieces).toBe(99_999_999)
  })
})
