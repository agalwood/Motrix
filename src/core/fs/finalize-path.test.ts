import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFinalizeTarget } from './finalize-path'

describe('resolveFinalizeTarget', () => {
  it.each([
    ['/downloads/', 'sub/file', '/downloads/sub/file'],
    ['/', 'file', '/file'],
  ])('resolves %s + %s', (root, target, expected) => {
    expect(resolveFinalizeTarget(root, target, path.posix)).toBe(expected)
  })

  it.each(['', '.', '/downloads', '../file', '/downloads-other/file'])(
    'rejects %s',
    (target) => {
      expect(() =>
        resolveFinalizeTarget('/downloads', target, path.posix)
      ).toThrow('descendant')
    }
  )

  it.each([
    ['C:\\Downloads\\', 'c:\\downloads\\file'],
    ['C:\\', 'C:\\file'],
    ['\\\\server\\share\\', '\\\\SERVER\\share\\file'],
    ['C:\\Downloads', '\\\\?\\C:\\Downloads\\file'],
    ['\\\\?\\C:\\Downloads', 'C:\\Downloads\\file'],
    ['\\\\server\\share', '\\\\?\\UNC\\server\\share\\file'],
  ])('accepts equivalent Windows roots: %s -> %s', (root, target) => {
    expect(resolveFinalizeTarget(root, target, path.win32)).toBe(
      path.win32.resolve(root, target)
    )
  })

  it.each([
    ['C:\\Downloads', 'D:\\file'],
    ['C:\\Downloads', 'C:\\Downloads2\\file'],
    ['C:\\Downloads', '\\\\?\\C:\\Downloads'],
    ['\\\\server\\share', '\\\\server\\other\\file'],
  ])('rejects a different or equal Windows root: %s -> %s', (root, target) => {
    expect(() => resolveFinalizeTarget(root, target, path.win32)).toThrow(
      'descendant'
    )
  })
})
