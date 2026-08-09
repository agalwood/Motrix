import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pathExists } from './path-exists'

describe('pathExists', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'motrix-path-exists-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('returns true for an accessible path', async () => {
    const filePath = path.join(rootDir, 'task.data')
    writeFileSync(filePath, 'ok')

    await expect(pathExists(filePath)).resolves.toBe(true)
  })

  it('coerces filesystem errors to false', async () => {
    await expect(pathExists(path.join(rootDir, 'missing'))).resolves.toBe(false)
  })
})
