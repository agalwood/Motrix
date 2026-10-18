import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from './interface'
import { LogCapabilityHost } from './log'

describe('LogCapabilityHost', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
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

  it('keeps the host and in-memory diagnostics available after the log destination cannot open', async () => {
    const blocked = path.join(dir, 'not-a-directory')
    writeFileSync(blocked, 'occupied')
    const unavailable = new LogCapabilityHost({ pluginLogsDir: blocked })
    const cap = unavailable.create('alice.demo')
    cap.error('initial failure')
    await expect(unavailable.flush()).rejects.toThrow(
      'Plugin log file is unavailable'
    )
    // A large follow-up must not trigger an immediate write to fd=-1 either.
    expect(() => cap.error('x'.repeat(10_000))).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(unavailable.getTail('alice.demo', 100)).toHaveLength(2)
    await expect(unavailable.clear('alice.demo')).rejects.toThrow(
      'Plugin log file is unavailable'
    )
    expect(unavailable.getTail('alice.demo', 100)).toHaveLength(2)
    fs.unlinkSync(blocked)
    const retry = unavailable.clear('alice.demo')
    cap.info('after destination recovery')
    await retry
    await unavailable.flush()
    expect(
      new LogCapabilityHost({ pluginLogsDir: blocked })
        .getTail('alice.demo', 100)
        .map((entry) => entry.msg)
    ).toEqual(['after destination recovery'])
  })

  it('restores persisted entries before new entries without replaying them as live events', async () => {
    host.create('alice.demo').error('worker failed', { source: 'host' })
    host.create('alice.demo').debug('diagnostic detail')
    const original = host.getTail('alice.demo', 10)
    await host.flush()
    const restarted = new LogCapabilityHost({ pluginLogsDir: dir })
    const listener = vi.fn()
    restarted.subscribe(listener)
    expect(restarted.getTail('alice.demo', 10)).toEqual(original)
    expect(listener).not.toHaveBeenCalled()
    restarted.create('alice.demo').info('after restart')
    expect(
      restarted.getTail('alice.demo', 10).map((entry) => entry.msg)
    ).toEqual(['worker failed', 'diagnostic detail', 'after restart'])
    expect(restarted.getTail('bob.demo', 10)).toEqual([])
    expect(restarted.getTail('alice.demo', 0)).toEqual([])
    await restarted.flush()
  })

  it('clears persisted history while preserving writes made during the clear', async () => {
    const cap = host.create('alice.demo')
    cap.error('before clear')
    const clearing = host.clear('alice.demo')
    cap.info('during clear')
    await clearing
    await host.flush()
    const restarted = new LogCapabilityHost({ pluginLogsDir: dir })
    expect(
      restarted.getTail('alice.demo', 100).map((entry) => entry.msg)
    ).toEqual(['during clear'])
    await restarted.clear('alice.demo')
    const again = new LogCapabilityHost({ pluginLogsDir: dir })
    expect(again.getTail('alice.demo', 100)).toEqual([])
  })

  it('rejects a failed flush without clearing history, then retries without resurrecting old logs', async () => {
    const truncate = vi.spyOn(fs.promises, 'truncate')
    const cap = host.create('alice.demo')
    cap.info('persisted')
    await host.flush()
    cap.error('buffered')
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const write = vi
      .spyOn(fs, 'write')
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error) => void
        queueMicrotask(() => callback(failure))
      })
    const clearing = host.clear('alice.demo')
    cap.info('during clear')
    await expect(clearing).rejects.toBe(failure)
    write.mockRestore()
    expect(truncate).not.toHaveBeenCalled()
    expect(host.getTail('alice.demo', 100).map((entry) => entry.msg)).toEqual([
      'persisted',
      'buffered',
      'during clear',
    ])
    await host.flush()
    await host.clear('alice.demo')
    await host.flush()
    const restarted = new LogCapabilityHost({ pluginLogsDir: dir })
    expect(restarted.getTail('alice.demo', 100)).toEqual([])
  })

  it('keeps visible and queued records when truncation fails and permits a later retry', async () => {
    const cap = host.create('alice.demo')
    cap.error('before clear')
    await host.flush()
    const failure = Object.assign(new Error('read only'), { code: 'EACCES' })
    vi.spyOn(fs.promises, 'truncate').mockRejectedValueOnce(failure)
    const clearing = host.clear('alice.demo')
    cap.info('during clear')
    await expect(clearing).rejects.toBe(failure)
    expect(host.getTail('alice.demo', 100).map((entry) => entry.msg)).toEqual([
      'before clear',
      'during clear',
    ])
    await host.flush()
    expect(
      new LogCapabilityHost({ pluginLogsDir: dir })
        .getTail('alice.demo', 100)
        .map((entry) => entry.msg)
    ).toEqual(['before clear', 'during clear'])
    await host.clear('alice.demo')
    await host.flush()
    expect(
      new LogCapabilityHost({ pluginLogsDir: dir }).getTail('alice.demo', 100)
    ).toEqual([])
  })

  it('aborts clearing when fsync fails and retains the previous record', async () => {
    const cap = host.create('alice.demo')
    cap.error('before clear')
    await host.flush()
    const failure = Object.assign(new Error('sync failed'), { code: 'EIO' })
    const sync = vi
      .spyOn(fs, 'fsync')
      .mockImplementationOnce((_fd, callback) => {
        queueMicrotask(() => callback(failure))
      })
    const truncate = vi.spyOn(fs.promises, 'truncate')
    await expect(host.clear('alice.demo')).rejects.toBe(failure)
    sync.mockRestore()
    expect(truncate).not.toHaveBeenCalled()
    expect(host.getTail('alice.demo', 100).map((entry) => entry.msg)).toEqual([
      'before clear',
    ])
    await host.clear('alice.demo')
    await host.flush()
    expect(
      new LogCapabilityHost({ pluginLogsDir: dir }).getTail('alice.demo', 100)
    ).toEqual([])
  })

  it('coalesces overlapping clears and preserves entries received before the disk commit', async () => {
    const cap = host.create('alice.demo')
    cap.error('before clear')
    let finish!: () => Promise<void>
    const realTruncate = fs.promises.truncate
    vi.spyOn(fs.promises, 'truncate').mockImplementationOnce(
      (...args) =>
        new Promise<void>((resolve, reject) => {
          finish = async () => {
            await realTruncate(...args).then(resolve, reject)
          }
        })
    )
    const clearing = host.clear('alice.demo')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(host.getTail('alice.demo', 100).map((entry) => entry.msg)).toEqual([
      'before clear',
    ])
    cap.info('during clear')
    expect(host.clear('alice.demo')).toBe(clearing)
    await finish()
    await clearing
    await host.flush()
    expect(
      new LogCapabilityHost({ pluginLogsDir: dir })
        .getTail('alice.demo', 100)
        .map((entry) => entry.msg)
    ).toEqual(['during clear'])
  })

  it('continues host sequence across restart and wall-clock rollback', async () => {
    const cap = host.create('alice.demo')
    cap.info('first')
    await host.flush()
    const restarted = new LogCapabilityHost({ pluginLogsDir: dir })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1)
    restarted.create('alice.demo').info('second')
    const entries = restarted.getTail('alice.demo', 100)
    expect(entries.map((entry) => entry.logSequence)).toEqual([1, 2])
    expect(entries[1].ts).toBeLessThan(entries[0].ts)
    await restarted.flush()
  })

  it('reads bounded historical tails and ignores malformed or truncated records', async () => {
    const logDir = path.join(dir, 'alice.demo', 'logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      path.join(logDir, 'current.ndjson'),
      [
        JSON.stringify({ time: 1, level: 30, msg: 'x'.repeat(600_000) }),
        '{broken',
        JSON.stringify({ time: 2, level: 900, msg: 'invalid level' }),
        JSON.stringify({ time: 3, level: 50, msg: 'retained', source: 'host' }),
        '{"time":4',
      ].join('\n')
    )
    expect(host.getTail('alice.demo', 100)).toEqual([
      { ts: 3, level: 'error', msg: 'retained', source: 'host' },
    ])
    host.create('alice.demo').error('after truncated record')
    await host.flush()
    const restarted = new LogCapabilityHost({ pluginLogsDir: dir })
    expect(
      restarted.getTail('alice.demo', 100).map((entry) => entry.msg)
    ).toEqual(['retained', 'after truncated record'])
    expect(() => host.getTail('../alice.demo', 100)).toThrow(
      'Invalid plugin log identifier'
    )
  })

  it('applies the shared plugin redaction to the ring and NDJSON', async () => {
    const cap = host.create('alice.demo')
    cap.info('request', {
      url: 'https://api.example.com/data?token=secret',
      headers: { Authorization: 'Bearer secret' },
      path: '/Users/alice/private/file.txt',
    })
    await host.flush()

    expect(host.getTail('alice.demo', 1)[0]).toMatchObject({
      url: 'https://api.example.com/data?token=[redacted]',
      path: 'file.txt',
    })
    expect(host.getTail('alice.demo', 1)[0]).not.toHaveProperty('headers')

    const file = path.join(dir, 'alice.demo', 'logs', 'current.ndjson')
    const entry = JSON.parse(readFileSync(file, 'utf8').trim())
    expect(entry.url).toBe('https://api.example.com/data?token=[redacted]')
    expect(entry.path).toBe('file.txt')
    expect(entry.headers).toBeUndefined()
    expect(JSON.stringify(entry)).not.toContain('secret')
  })

  it('keeps the existing explicit plugin verbose bypass', () => {
    host.setVerbose('alice.demo', true)
    const cap = host.create('alice.demo')
    const fields = {
      url: 'https://api.example.com/data?token=secret',
      headers: { Authorization: 'Bearer secret' },
    }

    cap.info('verbose request', fields)

    expect(host.getTail('alice.demo', 1)[0]).toMatchObject(fields)
  })

  it('prevents plugin fields from forging host log metadata', async () => {
    const cap = host.create('alice.demo')
    cap.warn('host message', {
      ts: 0,
      time: 0,
      level: 'fatal',
      msg: 'forged message',
      pid: 1,
      hostname: 'attacker',
      entryId: 'forged',
      logSequence: 12345,
    })
    await host.flush()

    const ringEntry = host.getTail('alice.demo', 1)[0]
    expect(ringEntry).toMatchObject({
      level: 'warn',
      msg: 'host message',
      fieldTs: 0,
      fieldTime: 0,
      fieldLevel: 'fatal',
      fieldMsg: 'forged message',
      fieldPid: 1,
      fieldHostname: 'attacker',
      fieldEntryId: 'forged',
      fieldLogSequence: 12345,
      logSequence: 1,
    })
    expect(ringEntry.ts).toBeGreaterThan(0)

    const file = path.join(dir, 'alice.demo', 'logs', 'current.ndjson')
    const ndjsonEntry = JSON.parse(readFileSync(file, 'utf8').trim())
    expect(ndjsonEntry.level).toBe(40)
    expect(ndjsonEntry.time).not.toBe(0)
    expect(ndjsonEntry.msg).toBe('host message')
    expect(ndjsonEntry.fieldLevel).toBe('fatal')
    expect(ndjsonEntry.fieldMsg).toBe('forged message')
  })

  it('bounds untrusted plugin message size in the ring and NDJSON', async () => {
    const cap = host.create('alice.demo')
    cap.info('x'.repeat(20_000), { count: 1 })
    await host.flush()

    const ringMessage = host.getTail('alice.demo', 1)[0].msg
    expect(ringMessage.length).toBeLessThanOrEqual(16 * 1024)
    expect(ringMessage).toContain('[truncated:')

    const file = path.join(dir, 'alice.demo', 'logs', 'current.ndjson')
    const ndjsonEntry = JSON.parse(readFileSync(file, 'utf8').trim())
    expect(ndjsonEntry.msg).toBe(ringMessage)
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

  it('clear() empties the ring buffer for the given plugin', async () => {
    const cap = host.create('alice.demo')
    cap.info('a')
    cap.info('b')
    expect(host.getTail('alice.demo', 10)).toHaveLength(2)
    await host.clear('alice.demo')
    expect(host.getTail('alice.demo', 10)).toHaveLength(0)
  })

  it('clear() on an unknown plugin keeps an empty history', async () => {
    await expect(host.clear('nobody.here')).resolves.toBeUndefined()
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

describe('verbose diagnostic lifetime', () => {
  afterEach(() => vi.useRealTimers())
  it('expires at one hour for previously created loggers without a UI timer', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mlog-expiry-'))
    const host = new LogCapabilityHost({ pluginLogsDir: dir })
    const cap = host.create('alice.demo')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000)
    host.setVerbose('alice.demo', true)
    expect(host.getState('alice.demo')).toEqual({
      verbose: true,
      expiresAt: 3_610_000,
    })
    cap.info('raw', { url: 'https://example.com/?token=secret' })
    expect(host.getTail('alice.demo', 1)[0].url).toContain('token=secret')
    vi.setSystemTime(3_610_000)
    cap.info('expired', { url: 'https://example.com/?id=public&token=secret' })
    expect(host.getState('alice.demo')).toEqual({
      verbose: false,
      expiresAt: null,
    })
    expect(host.getTail('alice.demo', 1)[0].url).toBe(
      'https://example.com/?id=public&token=[redacted]'
    )
    expect(host.isVerbose('bob.other')).toBe(false)
    host.setVerbose('alice.demo', true)
    host.setVerbose('alice.demo', false)
    expect(host.getState('alice.demo')).toEqual({
      verbose: false,
      expiresAt: null,
    })
  })
})
