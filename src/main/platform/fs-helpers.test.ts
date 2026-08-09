import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removePathRecursive, renameAtomic } from './fs-helpers'

describe('renameAtomic', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'fs-helpers-'))
  })
  afterEach(() => rmSync(baseDir, { recursive: true, force: true }))

  it('renames a file to a new name in same dir', async () => {
    const src = path.join(baseDir, 'a.txt')
    const dst = path.join(baseDir, 'b.txt')
    writeFileSync(src, 'hello')

    await renameAtomic(src, dst)

    expect(readFileSync(dst, 'utf8')).toBe('hello')
  })

  it('renames a directory', async () => {
    const src = path.join(baseDir, 'dirA')
    const dst = path.join(baseDir, 'dirB')
    mkdirSync(src)
    writeFileSync(path.join(src, 'inner.txt'), 'x')

    await renameAtomic(src, dst)

    expect(readFileSync(path.join(dst, 'inner.txt'), 'utf8')).toBe('x')
  })

  it('throws when source does not exist', async () => {
    await expect(
      renameAtomic(path.join(baseDir, 'missing'), path.join(baseDir, 'x'))
    ).rejects.toThrow()
  })
})

describe('removePathRecursive', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'fs-helpers-'))
  })
  afterEach(() => rmSync(baseDir, { recursive: true, force: true }))

  it('removes a regular file', async () => {
    const p = path.join(baseDir, 'x.txt')
    writeFileSync(p, 'y')

    await removePathRecursive(p)

    expect(() => readFileSync(p)).toThrow()
  })

  it('removes a directory and its contents', async () => {
    const dir = path.join(baseDir, 'd')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'a'), '1')

    await removePathRecursive(dir)

    expect(() => readFileSync(path.join(dir, 'a'))).toThrow()
  })

  it('is idempotent on nonexistent path', async () => {
    await expect(
      removePathRecursive(path.join(baseDir, 'missing'))
    ).resolves.not.toThrow()
  })
})
