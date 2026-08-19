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
    await w.write(54321, 'tok', 'gen-1')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.port).toBe(54321)
    expect(content.pid).toBe(process.pid)
  })

  it('persists the local token', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'secret-token-abc', 'gen-1')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.localToken).toBe('secret-token-abc')
  })

  it('persists the generation', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'tok', 'gen-abc-123')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.generation).toBe('gen-abc-123')
  })

  it('writes all five documented fields as parseable JSON', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'tok', 'gen-1')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(Object.keys(content).sort()).toEqual(
      ['generation', 'localToken', 'pid', 'port', 'writtenAt'].sort()
    )
  })

  it('writes the file with owner-only (0600) permissions', async () => {
    if (process.platform === 'win32') return // POSIX mode bits only
    const path = join(dir, 'endpoint.json')
    const w = new EndpointFileWriter(path)
    await w.write(54321, 'tok', 'gen-1')
    const { mode } = await stat(path)
    expect(mode & 0o777).toBe(0o600)
  })

  it('resets mode to 0600 even when the file already exists', async () => {
    if (process.platform === 'win32') return
    const path = join(dir, 'endpoint.json')
    const w = new EndpointFileWriter(path)
    await w.write(11111, 'tok-1', 'gen-1')
    await w.write(22222, 'tok-2', 'gen-2')
    const { mode } = await stat(path)
    expect(mode & 0o777).toBe(0o600)
  })

  it('clears the file on stop', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(54321, 'tok', 'gen-1')
    await w.clear()
    await expect(readFile(join(dir, 'endpoint.json'))).rejects.toThrow()
  })

  it('rewrites file on each write call', async () => {
    const w = new EndpointFileWriter(join(dir, 'endpoint.json'))
    await w.write(11111, 'tok-1', 'gen-1')
    await w.write(22222, 'tok-2', 'gen-2')
    const content = JSON.parse(
      await readFile(join(dir, 'endpoint.json'), 'utf-8')
    )
    expect(content.port).toBe(22222)
    expect(content.localToken).toBe('tok-2')
    expect(content.generation).toBe('gen-2')
  })

  it('leaves a complete, parseable file under concurrent writes', async () => {
    // endpoint.json is the attestation root (spec §9.1): a connect-storm of
    // concurrent bridge restarts/writes must never leave a truncated or
    // interleaved file on disk. write-file-atomic's temp-file + rename means
    // each write is all-or-nothing from a reader's perspective, even if the
    // final winner among concurrent writers is unspecified.
    const path = join(dir, 'endpoint.json')
    const w = new EndpointFileWriter(path)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        w.write(10000 + i, `tok-${i}`, `gen-${i}`)
      )
    )
    const raw = await readFile(path, 'utf-8')
    const content = JSON.parse(raw)
    expect(typeof content.port).toBe('number')
    expect(typeof content.localToken).toBe('string')
    expect(typeof content.generation).toBe('string')
  })
})
