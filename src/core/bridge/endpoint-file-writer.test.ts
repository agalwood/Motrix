import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EndpointFileWriter } from './endpoint-file-writer'

describe('EndpointFileWriter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-bridge-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes endpoint.json with port and PID', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'tok')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.port).toBe(54321)
    expect(content.pid).toBe(process.pid)
  })

  it('persists the local token', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'secret-token-abc')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.localToken).toBe('secret-token-abc')
  })

  it('writes the file with owner-only (0600) permissions', async () => {
    if (process.platform === 'win32') return // POSIX mode bits only
    const path = join(dir, 'endpoint.json')
    const w = new EndpointFileWriter(path)
    await w.write(54321, 'tok')
    const { mode } = await stat(path)
    expect(mode & 0o777).toBe(0o600)
  })

  it('resets mode to 0600 even when the file already exists', async () => {
    if (process.platform === 'win32') return
    const path = join(dir, 'endpoint.json')
    const w = new EndpointFileWriter(path)
    await w.write(11111, 'tok-1')
    await w.write(22222, 'tok-2')
    const { mode } = await stat(path)
    expect(mode & 0o777).toBe(0o600)
  })

  it('clears the file on stop', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'tok')
    await w.clear()
    await expect(readFile(join(dir, 'endpoint.json'))).rejects.toThrow()
  })

  it('rewrites file on each write call', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(11111, 'tok-1')
    await w.write(22222, 'tok-2')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.port).toBe(22222)
    expect(content.localToken).toBe('tok-2')
  })
})
