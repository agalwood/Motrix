import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCookieJar } from './cookie-jar'

describe('writeCookieJar', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bridge-jar-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes Netscape format file aria2 can read', async () => {
    const path = join(dir, 'jar.txt')
    await writeCookieJar(path, [
      {
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'unspecified',
        expiresAt: 1700000000,
      },
      {
        name: 'b',
        value: '2',
        domain: '.example.com',
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'unspecified',
      },
    ])
    const text = await readFile(path, 'utf-8')
    expect(text).toContain('# Netscape HTTP Cookie File')
    // aria2 expects tab-separated: domain  flag  path  secure  expires  name  value
    const lines = text.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('example.com\tFALSE\t/\tTRUE\t1700000000\ta\t1')
    expect(lines[1]).toBe('.example.com\tTRUE\t/\tFALSE\t0\tb\t2')
  })

  it('creates parent directories', async () => {
    const path = join(dir, 'nested', 'deep', 'jar.txt')
    await writeCookieJar(path, [])
    const text = await readFile(path, 'utf-8')
    expect(text).toContain('# Netscape HTTP Cookie File')
  })
})
