import { describe, expect, it } from 'vitest'
import { createDisplacementMap } from './displacement-map'

describe('toolbar glass displacement', () => {
  it.each([
    [104, 36],
    [86, 30],
    [230, 36],
    [30, 30],
  ])(
    'keeps the center neutral and bends only the capsule rim at %i × %i',
    (width, height) => {
      const map = createDisplacementMap(width, height)
      const pixel = (x: number, y: number) =>
        Array.from(map.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
      expect(pixel(Math.floor(width / 2), Math.floor(height / 2))).toEqual([
        128, 128, 128, 255,
      ])
      // Outside a rounded corner is neutral, not a diagonal/sheared lens.
      expect(pixel(0, 0)).toEqual([128, 128, 128, 255])
      const top = pixel(Math.floor(width / 2), 0)
      const bottom = pixel(Math.floor(width / 2), height - 1)
      expect(top[1]).toBeGreaterThan(128)
      expect(bottom[1]).toBeLessThan(128)
      expect(top[1] + bottom[1]).toBe(256)
      const left = pixel(0, Math.floor(height / 2))
      const right = pixel(width - 1, Math.floor(height / 2))
      expect(left[0]).toBeGreaterThan(128)
      expect(right[0]).toBeLessThan(128)
      expect(left[0] + right[0]).toBe(256)
    }
  )
})
