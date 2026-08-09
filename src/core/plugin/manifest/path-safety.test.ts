import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInsidePluginDir } from './path-safety'

describe('resolveInsidePluginDir', () => {
  const root = '/plugins/alice.demo'

  it('resolves a normal relative path inside the root', () => {
    expect(resolveInsidePluginDir(root, 'dist/plugin.js')).toBe(
      path.join(root, 'dist/plugin.js')
    )
  })

  it('allows the root itself', () => {
    expect(resolveInsidePluginDir(root, '.')).toBe(path.resolve(root))
  })

  it('rejects parent-traversal escapes', () => {
    expect(resolveInsidePluginDir(root, '../../etc/passwd')).toBeNull()
    expect(resolveInsidePluginDir(root, 'dist/../../other/x')).toBeNull()
  })

  it('rejects absolute paths outside the root', () => {
    expect(resolveInsidePluginDir(root, '/etc/passwd')).toBeNull()
  })

  it('rejects a sibling whose name shares the root as a prefix', () => {
    // /plugins/alice-evil must not pass a naive startsWith('/plugins/alice')
    expect(resolveInsidePluginDir('/plugins/alice', '../alice-evil')).toBeNull()
  })
})
