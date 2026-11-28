import { expect, it } from 'vitest'
import { nasFileRange } from './file-routes'

it('supports single explicit and suffix byte ranges without unsafe arithmetic', () => {
  expect(nasFileRange(undefined, 10)).toEqual({ start: 0, end: 9 })
  expect(nasFileRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
  expect(nasFileRange('bytes=2-', 10)).toEqual({ start: 2, end: 9 })
  expect(nasFileRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
  expect(nasFileRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 })
  for (const value of [
    'bytes=-',
    'bytes=-0',
    'bytes=8-2',
    'bytes=10-',
    'bytes=0-1,4-6',
    'bytes=99999999999999999999-',
    'items=0-1',
  ])
    expect(nasFileRange(value, 10)).toBeNull()
  expect(nasFileRange('bytes=0-', 0)).toBeNull()
})
