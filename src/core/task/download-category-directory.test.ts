import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  categoryAdmissionDirectory,
  categorySaveDirectory,
} from './download-category-directory'

const root = path.resolve('downloads')

describe('category save directories', () => {
  it('routes files into stable category subfolders', () => {
    expect(categorySaveDirectory(root, 'manual.pdf', true)).toBe(
      path.join(root, 'Documents')
    )
    expect(categorySaveDirectory(root, 'unknown', true)).toBe(
      path.join(root, 'Other')
    )
  })
  it('leaves the destination intact when automatic sorting is off', () => {
    expect(categorySaveDirectory(root, 'setup.exe', false)).toBe(root)
  })
  it('respects an explicitly chosen category folder without nesting categories', () => {
    const selected = path.join(root, 'Compressed')
    expect(categorySaveDirectory(selected, 'movie.mp4', true)).toBe(selected)
    expect(categoryAdmissionDirectory(selected, true)).toBe(root)
  })
})
