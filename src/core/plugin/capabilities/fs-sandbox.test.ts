import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FsSandboxError,
  resolveDeepInsideSandbox,
  resolveInsideSandbox,
} from './fs-sandbox'

describe('resolveInsideSandbox', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-'))
  mkdirSync(path.join(root, 'sub'))
  writeFileSync(path.join(root, 'sub/file.txt'), '')

  it('accepts a path inside root', async () => {
    const r = await resolveInsideSandbox(root, 'sub/file.txt')
    // On macOS, os.tmpdir() returns a /var/... path while realpath returns /private/var/...
    // (because /var → /private/var). Both resolveInsideSandbox and the assertion must compare canonical paths.
    expect(r).toBe(realpathSync(path.join(root, 'sub/file.txt')))
  })
  it('rejects parent traversal', async () => {
    await expect(resolveInsideSandbox(root, '../escape.txt')).rejects.toThrow(
      FsSandboxError
    )
  })
  it('rejects symlinks pointing outside root', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    writeFileSync(path.join(outside, 'evil.txt'), '')
    symlinkSync(path.join(outside, 'evil.txt'), path.join(root, 'link'))
    await expect(resolveInsideSandbox(root, 'link')).rejects.toThrow(
      /path_outside_sandbox/
    )
  })
  it('rejects paths longer than 4096 chars', async () => {
    const long = 'a/'.repeat(2100)
    await expect(resolveInsideSandbox(root, long)).rejects.toThrow(
      /path_too_long/
    )
  })
})

describe('resolveDeepInsideSandbox', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-deep-'))

  it('resolves a deeply nested missing path inside root', async () => {
    const r = await resolveDeepInsideSandbox(root, 'a/b/c/d/e.txt')
    const realRoot = realpathSync(root)
    expect(r).toBe(path.join(realRoot, 'a/b/c/d/e.txt'))
  })

  it('rejects paths longer than 4096 chars', async () => {
    const long = 'a/'.repeat(2100)
    await expect(resolveDeepInsideSandbox(root, long)).rejects.toThrow(
      /path_too_long/
    )
  })

  it('rejects parent traversal escape', async () => {
    await expect(
      resolveDeepInsideSandbox(root, '../../escape.txt')
    ).rejects.toThrow(FsSandboxError)
  })
})
