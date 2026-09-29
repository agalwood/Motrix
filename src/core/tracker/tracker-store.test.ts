import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrackerStore } from './tracker-store'

describe('TrackerStore', () => {
  let tmpDir: string
  let filePath: string
  let store: TrackerStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-store-'))
    filePath = path.join(tmpDir, 'tracker.json')
    store = new TrackerStore(filePath)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty list when file does not exist', async () => {
    const list = await store.load()
    expect(list.effective).toEqual([])
    expect(list.blacklist).toEqual([])
    expect(list.healthMap).toEqual({})
    expect(list.sourceMap).toEqual({})
    expect(list.lastSyncAt).toBeNull()
  })

  it('round-trips save and load', async () => {
    const data = {
      effective: ['udp://tracker.example.com:1337'],
      blacklist: ['http://bad.tracker.com'],
      healthMap: {
        'udp://tracker.example.com:1337': {
          url: 'udp://tracker.example.com:1337',
          protocol: 'udp' as const,
          status: 'healthy' as const,
          lastProbeMs: 42,
          lastProbeAt: 1000,
          successCount: 5,
          failCount: 1,
          successRate: 0.83,
        },
      },
      sourceMap: {},
      lastSyncAt: 1000,
      lastProbeAt: 1000,
    }
    await store.save(data)
    const loaded = await store.load()
    expect(loaded).toMatchObject({ ...data, version: 2 })
  })

  it('persists sourceMap', async () => {
    await store.save({
      effective: ['udp://a'],
      blacklist: [],
      healthMap: {},
      sourceMap: { 'udp://a': ['ngosang-best'] },
      lastSyncAt: 0,
      lastProbeAt: 0,
    })
    const loaded = await store.load()
    expect(loaded.sourceMap['udp://a']).toEqual(['ngosang-best'])
  })

  it('mergeHealth combines existing and fresh data', () => {
    const existing = {
      'udp://a.com': {
        url: 'udp://a.com',
        protocol: 'udp' as const,
        status: 'healthy' as const,
        lastProbeMs: 50,
        lastProbeAt: 900,
        successCount: 3,
        samples: [
          { at: 700, ok: true },
          { at: 800, ok: true },
          { at: 900, ok: true },
        ],
        failCount: 0,
        successRate: 1.0,
      },
    }
    const fresh = [
      {
        url: 'udp://a.com',
        protocol: 'udp' as const,
        status: 'slow' as const,
        lastProbeMs: 4000,
        lastProbeAt: 1000,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
      },
      {
        url: 'http://b.com',
        protocol: 'http' as const,
        status: 'healthy' as const,
        lastProbeMs: 30,
        lastProbeAt: 1000,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
      },
    ]
    const merged = store.mergeHealth(existing, fresh)
    expect(merged['udp://a.com'].successCount).toBe(4)
    expect(merged['udp://a.com'].lastProbeMs).toBe(4000)
    expect(merged['http://b.com'].successCount).toBe(1)
  })
  it('backs up v1 state before the first atomic migration', async () => {
    const legacy = JSON.stringify({
      effective: ['udp://a:80'],
      healthMap: {},
      sourceMap: {},
      blacklist: [],
      lastSyncAt: 100,
      lastProbeAt: null,
    })
    await fs.writeFile(filePath, legacy)
    const loaded = await store.load()
    await store.save(loaded)
    expect(await fs.readFile(`${filePath}.v1.bak`, 'utf8')).toBe(legacy)
    expect((await store.load()).version).toBe(2)
  })

  it('preserves an invalid original before recovery', async () => {
    await fs.writeFile(filePath, '{broken')
    const loaded = await store.load()
    await store.save(loaded)
    expect(await fs.readFile(`${filePath}.invalid.bak`, 'utf8')).toBe('{broken')
  })

  it('does not treat lifetime aggregates as recent timed samples', () => {
    const old = {
      url: 'udp://a:80',
      protocol: 'udp' as const,
      status: 'healthy' as const,
      lastProbeMs: 1,
      lastProbeAt: 1000,
      successCount: 9999,
      failCount: 0,
      successRate: 1,
    }
    const merged = store.mergeHealth({ [old.url]: old }, [
      { ...old, status: 'unreachable', lastProbeAt: 2000 },
    ])
    expect(merged[old.url]).toMatchObject({
      successCount: 0,
      failCount: 1,
      successRate: 0,
    })
  })

  it('drops old samples and separates network routes', () => {
    const now = Date.now()
    const old = {
      url: 'udp://a:80',
      protocol: 'udp' as const,
      status: 'healthy' as const,
      lastProbeMs: 1,
      lastProbeAt: now,
      successCount: 1,
      failCount: 1,
      successRate: 0.5,
      routeKey: 'a',
      samples: [
        { at: now - 8 * 86_400_000, ok: false },
        { at: now, ok: true },
      ],
    }
    expect(
      store.mergeHealth({ [old.url]: old }, [{ ...old, lastProbeAt: now + 1 }])[
        old.url
      ].successRate
    ).toBe(1)
    expect(
      store.mergeHealth({ [old.url]: old }, [
        { ...old, routeKey: 'b', status: 'unreachable', lastProbeAt: now + 1 },
      ])[old.url].samples
    ).toEqual([{ at: now + 1, ok: false }])
  })
})
