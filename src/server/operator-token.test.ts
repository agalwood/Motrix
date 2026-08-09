import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provisionOperatorToken } from './operator-token'

describe('provisionOperatorToken', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-optoken-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('uses MOTRIX_OPERATOR_TOKEN when set, writing no file', async () => {
    const r = await provisionOperatorToken({
      dataDir: dir,
      env: { MOTRIX_OPERATOR_TOKEN: 'explicit-token' },
    })
    expect(r).toEqual({ token: 'explicit-token', source: 'env' })
    await expect(stat(join(dir, 'operator-token'))).rejects.toThrow()
  })

  it('mints a token and writes it host-readable at 0600 (independent of the bridge)', async () => {
    const r = await provisionOperatorToken({ dataDir: dir, env: {} })
    expect(r.source).toBe('file')
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(r.token.length).toBeGreaterThanOrEqual(43)
    expect(r.path).toBe(join(dir, 'operator-token'))
    // The host operator can read exactly the gate's secret…
    expect(await readFile(r.path as string, 'utf-8')).toBe(r.token)
    // …and only the owner can.
    expect((await stat(r.path as string)).mode & 0o777).toBe(0o600)
  })
})
