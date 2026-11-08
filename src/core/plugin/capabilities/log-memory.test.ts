// @vitest-environment node
import fs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  LogCapabilityHost,
  PLUGIN_LOG_MAX_BUFFER_BYTES,
  PLUGIN_LOG_MAX_RING_BYTES,
} from './log'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'motrix-log-memory-'))
  const host = new LogCapabilityHost({ pluginLogsDir: dir })
  cleanups.push(async () => {
    await host.close()
    await rm(dir, { recursive: true, force: true })
  })
  const records = async () =>
    (await readFile(path.join(dir, 'alice.demo/logs/current.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { host, records }
}
function state(host: LogCapabilityHost) {
  return (
    Reflect.get(host, 'per') as Map<
      string,
      {
        pendingBytes: number
        pending: unknown[]
        ringBytes: number
        dest?: { destroyed: boolean }
        dropped: number
      }
    >
  ).get('alice.demo')
}

it('does not open a writer for history inspection or capability creation', async () => {
  const { host } = await fixture()
  expect(host.getTail('alice.demo', 100)).toEqual([])
  const cap = host.create('alice.demo')
  await host.flush()
  expect(state(host)?.dest).toBeUndefined()
  cap.info('first write')
  await host.flush()
  expect(state(host)?.dest).toBeDefined()
})

it('bounds delayed-open floods and persists an exact loss summary after recovery', async () => {
  const { host, records } = await fixture()
  const mkdir = fs.promises.mkdir
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  vi.spyOn(fs.promises, 'mkdir').mockImplementationOnce(async (...args) => {
    await gate
    return mkdir(...args)
  })
  const cap = host.create('alice.demo')
  for (let index = 0; index < 2000; index++)
    cap.info('x'.repeat(4000), { index })
  expect(state(host)?.pendingBytes).toBeLessThanOrEqual(
    PLUGIN_LOG_MAX_BUFFER_BYTES
  )
  expect(state(host)?.pending.length).toBeLessThanOrEqual(512)
  expect(state(host)?.ringBytes).toBeLessThanOrEqual(PLUGIN_LOG_MAX_RING_BYTES)
  expect(state(host)?.dest).toBeUndefined()
  resume()
  await host.flush()
  const rows = await records()
  expect(
    rows.filter((row) => row.index !== undefined).length +
      rows.reduce((sum, row) => sum + (row.droppedEntries ?? 0), 0)
  ).toBe(2000)
  expect(rows.some((row) => row.droppedEntries > 0 && row.level === 40)).toBe(
    true
  )
})

it('bounds writes during clear without resurrecting old records', async () => {
  const { host, records } = await fixture()
  const cap = host.create('alice.demo')
  cap.info('before clear')
  await host.flush()
  const truncate = fs.promises.truncate
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const delayed = vi
    .spyOn(fs.promises, 'truncate')
    .mockImplementationOnce(async (...args) => {
      await gate
      return truncate(...args)
    })
  const clearing = host.clear('alice.demo')
  await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce())
  for (let index = 0; index < 2000; index++)
    cap.info('new'.repeat(1400), { index })
  expect(state(host)?.pendingBytes).toBeLessThanOrEqual(
    PLUGIN_LOG_MAX_BUFFER_BYTES
  )
  resume()
  await clearing
  await host.flush()
  const rows = await records()
  expect(rows.some((row) => row.msg === 'before clear')).toBe(false)
  expect(
    rows.filter((row) => row.index !== undefined).length +
      rows.reduce((sum, row) => sum + (row.droppedEntries ?? 0), 0)
  ).toBe(2000)
})

it('bounds the underlying destination when a write stalls', async () => {
  const { host, records } = await fixture()
  const cap = host.create('alice.demo')
  cap.info('ready')
  await host.flush()
  const write = fs.write
  let resume!: () => void
  vi.spyOn(fs, 'write').mockImplementationOnce((...args: unknown[]) => {
    resume = () => Reflect.apply(write, fs, args)
    return undefined as never
  })
  for (let index = 0; index < 1000; index++)
    cap.info('x'.repeat(8000), { index })
  expect(resume).toBeTypeOf('function')
  expect(state(host)?.dropped).toBeGreaterThan(0)
  expect(state(host)?.pendingBytes).toBe(0)
  resume()
  await host.flush()
  const rows = await records()
  expect(
    rows.filter((row) => row.index !== undefined).length +
      rows.reduce((sum, row) => sum + (row.droppedEntries ?? 0), 0)
  ).toBe(1000)
})

it('closes a writer admitted during opening and prevents stale capabilities from resurrecting it', async () => {
  const { host, records } = await fixture()
  const cap = host.create('alice.demo')
  cap.info('before release')
  const releasing = host.release('alice.demo')
  expect(host.release('alice.demo')).toBe(releasing)
  cap.info('during release')
  await releasing
  cap.info('after release')
  expect(state(host)).toBeUndefined()
  const next = host.create('alice.demo')
  next.info('after reinstall')
  await host.flush()
  expect((await records()).map((row) => row.msg)).toEqual([
    'before release',
    'after reinstall',
  ])
})

it('retains a writer after a failed release so durable output can be retried', async () => {
  const { host, records } = await fixture()
  host.create('alice.demo').error('retained')
  await host.flush()
  const error = new Error('fsync failed')
  vi.spyOn(fs, 'fsync').mockImplementationOnce((_fd, callback) => {
    queueMicrotask(() => callback(error))
  })
  await expect(host.release('alice.demo')).rejects.toBe(error)
  expect(state(host)?.dest?.destroyed).toBe(false)
  await host.release('alice.demo')
  expect(state(host)).toBeUndefined()
  expect((await records()).map((row) => row.msg)).toEqual(['retained'])
})

it('retries a transient open failure when releasing a recovered destination', async () => {
  const { host, records } = await fixture()
  vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(
    new Error('temporarily unavailable')
  )
  host.create('alice.demo').info('before open failure')
  await expect(host.flush()).rejects.toThrow('unavailable')
  try {
    await host.release('alice.demo')
    expect(state(host)).toBeUndefined()
    expect((await records()).some((row) => row.droppedEntries === 1)).toBe(true)
  } finally {
    // Keep the pre-fix failure isolated from fixture teardown.
    if (state(host)) await host.clear('alice.demo')
  }
})

it('waits for an in-flight clear before releasing the destination', async () => {
  const { host, records } = await fixture()
  const cap = host.create('alice.demo')
  cap.info('old')
  await host.flush()
  const truncate = fs.promises.truncate
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const delayed = vi
    .spyOn(fs.promises, 'truncate')
    .mockImplementationOnce(async (...args) => {
      await gate
      return truncate(...args)
    })
  const clearing = host.clear('alice.demo')
  await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce())
  cap.info('accepted during clear')
  const releasing = host.release('alice.demo')
  cap.info('stale after retirement')
  expect(state(host)?.dest?.destroyed).toBe(false)
  resume()
  await Promise.all([clearing, releasing])
  expect(state(host)).toBeUndefined()
  expect((await records()).map((row) => row.msg)).toEqual([
    'accepted during clear',
  ])
})

it('quarantines a destroyed writer after its close reports an error', async () => {
  const { host, records } = await fixture()
  const cap = host.create('alice.demo')
  cap.info('durable before closing')
  await host.flush()
  const close = fs.close
  const failure = new Error('close reported an I/O error')
  vi.spyOn(fs, 'close').mockImplementationOnce((fd, callback) => {
    // A close error does not prove that the old numeric FD is still owned.
    if (!callback) throw new Error('Expected the asynchronous close callback')
    close(fd, (error) => callback(error ?? failure))
  })
  try {
    const releasing = host.release('alice.demo')
    await expect(releasing).rejects.toBe(failure)
    expect(() => cap.info('late write')).not.toThrow()
    expect(host.release('alice.demo')).toBe(releasing)
    await expect(host.clear('alice.demo')).rejects.toThrow('closing')
    expect((await records()).map((row) => row.msg)).toEqual([
      'durable before closing',
    ])
  } finally {
    // The real descriptor is closed; discard only this quarantined test entry.
    ;(Reflect.get(host, 'per') as Map<string, unknown>).clear()
  }
})

it('bounds a single structured entry and closes all writers at shutdown', async () => {
  const { host, records } = await fixture()
  const cap = host.create('alice.demo')
  cap.info(
    'large fields',
    Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`field${i}`, 'x'.repeat(8000)])
    )
  )
  expect(host.getTail('alice.demo', 1)[0]).toMatchObject({
    fieldsTruncated: true,
  })
  const shutdown = host.close()
  cap.info('late shutdown write')
  await shutdown
  host.create('alice.demo').info('must not reopen')
  expect(state(host)).toBeUndefined()
  expect((await records()).map((row) => row.msg)).toEqual(['large fields'])
})
