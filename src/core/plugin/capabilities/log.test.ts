import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from './interface'
import { LogCapabilityHost } from './log'

describe('LogCapabilityHost', () => {
  let dir: string
  let host: LogCapabilityHost

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mlog-'))
    host = new LogCapabilityHost({ pluginLogsDir: dir })
  })

  it('writes an entry to current.ndjson', async () => {
    const cap = host.create('alice.demo')
    cap.info('hello', { foo: 1 })
    await host.flush()
    const file = path.join(dir, 'alice.demo', 'logs', 'current.ndjson')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    const entry = JSON.parse(lines[0])
    expect(entry.msg).toBe('hello')
    expect(entry.foo).toBe(1)
    expect(entry.level).toBeDefined()
  })

  it('flush() persists every entry, across the write buffer and a refill', async () => {
    const cap = host.create('alice.demo')
    const file = path.join(dir, 'alice.demo', 'logs', 'current.ndjson')

    // Well past the destination's 4 KiB buffer, so this spans both the
    // size-triggered writes and the tail that only flush() can push out.
    for (let index = 0; index < 200; index += 1) {
      cap.info('batch', { index })
    }
    await host.flush()
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(200)

    cap.info('after')
    await host.flush()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(201)
    expect(JSON.parse(lines[200]).msg).toBe('after')
  })

  it('exposes a tail subscription via getTail()', () => {
    const cap = host.create('alice.demo')
    cap.info('a')
    cap.info('b')
    const tail = host.getTail('alice.demo', 10)
    expect(tail).toHaveLength(2)
  })

  it('clear() empties the ring buffer for the given plugin', () => {
    const cap = host.create('alice.demo')
    cap.info('a')
    cap.info('b')
    expect(host.getTail('alice.demo', 10)).toHaveLength(2)
    host.clear('alice.demo')
    expect(host.getTail('alice.demo', 10)).toHaveLength(0)
  })

  it('clear() on an unknown plugin is a no-op', () => {
    expect(() => host.clear('nobody.here')).not.toThrow()
  })

  it('setVerbose() / isVerbose() track per-plugin flag (default false)', () => {
    expect(host.isVerbose('alice.demo')).toBe(false)
    host.setVerbose('alice.demo', true)
    expect(host.isVerbose('alice.demo')).toBe(true)
    expect(host.isVerbose('bob.other')).toBe(false)
    host.setVerbose('alice.demo', false)
    expect(host.isVerbose('alice.demo')).toBe(false)
  })

  it('subscribe() receives (pluginId, entry) for every push', () => {
    const listener = vi.fn<(pluginId: string, entry: LogEntry) => void>()
    const off = host.subscribe(listener)
    const aliceCap = host.create('alice.demo')
    const bobCap = host.create('bob.other')
    aliceCap.info('a', { k: 1 })
    bobCap.warn('b')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[0][0]).toBe('alice.demo')
    expect(listener.mock.calls[0][1]).toMatchObject({
      level: 'info',
      msg: 'a',
      k: 1,
    })
    expect(listener.mock.calls[1][0]).toBe('bob.other')
    expect(listener.mock.calls[1][1]).toMatchObject({ level: 'warn', msg: 'b' })
    off()
    aliceCap.info('c')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('subscribe() supports multiple listeners independently', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = host.subscribe(a)
    host.subscribe(b)
    host.create('p').info('x')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    host.create('p').info('y')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('a throwing listener does not break subsequent listeners', () => {
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    host.subscribe(bad)
    host.subscribe(good)
    host.create('p').info('x')
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
  })
})
