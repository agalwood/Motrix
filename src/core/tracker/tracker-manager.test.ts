import { Events } from '@shared/protocol/events'
import type { CuratedTrackerList } from '@shared/types/tracker'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackerManager } from './tracker-manager'

function createMockRpcClient() {
  return {
    changeGlobalOption: vi.fn().mockResolvedValue('OK'),
    changeOption: vi.fn().mockResolvedValue('OK'),
    pause: vi.fn().mockResolvedValue('gid1'),
    unpause: vi.fn().mockResolvedValue('gid1'),
    tellStatus: vi.fn().mockResolvedValue({ status: 'active' }),
  }
}

function createMockEventBus() {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()

  return {
    emit: vi.fn((channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args)
      }
    }),
    on: vi.fn((channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel) ?? new Set<Listener>()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    off: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
    }),
    removeAll: vi.fn(() => listeners.clear()),
  }
}

function createMockSettingsManager() {
  return {
    get: vi.fn().mockReturnValue({
      tracker: {
        autoSync: false,
        syncIntervalHours: 12,
        sources: [],
        sourcesEnabled: true,
        probeEnabled: true,
        probeTimeoutMs: 5000,
        healthyThresholdMs: 3000,
        minSuccessRate: 0.5,
        maxTrackerCount: 50,
        blacklistEnabled: false,
        blacklistSources: [],
      },
    }),
    getProxy: vi.fn().mockReturnValue({
      enabled: false,
      protocol: 'http',
      host: '',
      port: 8080,
      user: '',
      password: '',
      bypass: [],
      scopes: { download: false, updateApp: false, updateTrackers: false },
    }),
  }
}

function createMockSyncer() {
  return {
    fetch: vi.fn().mockResolvedValue({
      trackers: ['udp://a.com:1337', 'http://b.com/ann', 'udp://c.com:80'],
      sourceStatus: { s1: { ok: true, count: 3, elapsedMs: 100 } },
    }),
  }
}

function createMockProber() {
  return {
    probe: vi.fn().mockResolvedValue([
      {
        url: 'udp://a.com:1337',
        protocol: 'udp',
        status: 'healthy',
        lastProbeMs: 20,
        lastProbeAt: 1000,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
      },
      {
        url: 'http://b.com/ann',
        protocol: 'http',
        status: 'unreachable',
        lastProbeMs: null,
        lastProbeAt: 1000,
        successCount: 0,
        failCount: 1,
        successRate: 0,
      },
      {
        url: 'udp://c.com:80',
        protocol: 'udp',
        status: 'healthy',
        lastProbeMs: 50,
        lastProbeAt: 1000,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
      },
    ]),
  }
}

function createMockStore() {
  const data: CuratedTrackerList = {
    effective: [],
    blacklist: [],
    healthMap: {},
    sourceMap: {},
    lastSyncAt: null,
    lastProbeAt: null,
  }
  return {
    load: vi.fn().mockResolvedValue(data),
    save: vi.fn().mockResolvedValue(undefined),
    mergeHealth: vi.fn().mockImplementation((_existing, fresh) => {
      const map: Record<string, unknown> = {}
      for (const h of fresh) map[h.url] = h
      return map
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

describe('TrackerManager', () => {
  let rpc: ReturnType<typeof createMockRpcClient>
  let eventBus: ReturnType<typeof createMockEventBus>
  let settings: ReturnType<typeof createMockSettingsManager>
  let syncer: ReturnType<typeof createMockSyncer>
  let prober: ReturnType<typeof createMockProber>
  let store: ReturnType<typeof createMockStore>
  let manager: TrackerManager

  beforeEach(() => {
    vi.useFakeTimers()
    rpc = createMockRpcClient()
    eventBus = createMockEventBus()
    settings = createMockSettingsManager()
    syncer = createMockSyncer()
    prober = createMockProber()
    store = createMockStore()
    manager = new TrackerManager(
      settings as never,
      rpc as never,
      eventBus as never,
      syncer as never,
      prober as never,
      store as never
    )
  })

  afterEach(() => {
    manager.dispose()
    vi.useRealTimers()
  })

  it('syncAndCurate fetches, probes, curates, and writes to aria2', async () => {
    const result = await manager.syncAndCurate()

    expect(syncer.fetch).toHaveBeenCalledOnce()
    expect(prober.probe).toHaveBeenCalledOnce()
    expect(store.save).toHaveBeenCalledOnce()
    expect(rpc.changeGlobalOption).toHaveBeenCalledOnce()

    const opts = rpc.changeGlobalOption.mock.calls[0][0]
    expect(opts['bt-tracker']).toContain('udp://a.com:1337')
    expect(opts['bt-tracker']).toContain('udp://c.com:80')
    expect(opts['bt-tracker']).not.toContain('http://b.com/ann')

    expect(result.totalFetched).toBe(3)
    expect(result.totalHealthy).toBe(2)
    expect(result.totalCurated).toBe(2)
  })

  describe('applySyncScheduleChange', () => {
    const withTracker = (over: {
      autoSync: boolean
      syncIntervalHours?: number
    }) => {
      const cfg = settings.get().tracker
      settings.get.mockReturnValue({
        tracker: { ...cfg, syncIntervalHours: cfg.syncIntervalHours, ...over },
      })
    }

    it('arms the periodic sync timer when autoSync is on', async () => {
      withTracker({ autoSync: true, syncIntervalHours: 1 })
      manager.applySyncScheduleChange()
      expect(syncer.fetch).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(syncer.fetch).toHaveBeenCalledTimes(1)
    })

    it('stops the timer when autoSync is turned off at runtime', async () => {
      withTracker({ autoSync: true, syncIntervalHours: 1 })
      manager.applySyncScheduleChange()
      withTracker({ autoSync: false })
      manager.applySyncScheduleChange()
      await vi.advanceTimersByTimeAsync(7_200_000)
      expect(syncer.fetch).not.toHaveBeenCalled()
    })

    it('re-arms with the new interval', async () => {
      withTracker({ autoSync: true, syncIntervalHours: 12 })
      manager.applySyncScheduleChange()
      withTracker({ autoSync: true, syncIntervalHours: 1 })
      manager.applySyncScheduleChange()
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(syncer.fetch).toHaveBeenCalledTimes(1)
    })

    it('does not publish or re-arm when dispose wins a blocked init', async () => {
      const loaded = deferred<CuratedTrackerList>()
      store.load.mockReturnValueOnce(loaded.promise)
      const cfg = settings.get().tracker
      settings.get.mockReturnValue({
        tracker: {
          ...cfg,
          autoSync: true,
          syncIntervalHours: 1,
          sourcesEnabled: true,
        },
      })
      const initializing = manager.init()
      await Promise.resolve()

      manager.dispose()
      loaded.resolve({
        effective: ['udp://cached-tracker'],
        blacklist: [],
        healthMap: {},
        sourceMap: {},
        lastSyncAt: 1,
        lastProbeAt: 1,
      })
      await initializing
      await vi.advanceTimersByTimeAsync(3_600_000)

      expect(rpc.changeGlobalOption).not.toHaveBeenCalled()
      expect(syncer.fetch).not.toHaveBeenCalled()
    })
  })

  it('emits TrackerListUpdated after sync', async () => {
    await manager.syncAndCurate()
    expect(eventBus.emit).toHaveBeenCalledWith(
      'event:trackerListUpdated',
      expect.objectContaining({ count: 2 })
    )
  })

  it('passes proxy to syncer.fetch when updateTrackers scope is on', async () => {
    settings.getProxy.mockReturnValue({
      enabled: true,
      protocol: 'http',
      host: 'p.example.com',
      port: 8080,
      user: '',
      password: '',
      bypass: [],
      scopes: { download: false, updateApp: false, updateTrackers: true },
    })
    await manager.syncAndCurate()
    expect(syncer.fetch).toHaveBeenCalledWith(expect.anything(), {
      server: 'http://p.example.com:8080',
    })
  })

  it('passes undefined proxy when updateTrackers scope is off', async () => {
    await manager.syncAndCurate()
    expect(syncer.fetch).toHaveBeenCalledWith(expect.anything(), undefined)
  })

  it('uses the resolved HTTP bridge for SOCKS5 tracker fetches', async () => {
    settings.getProxy.mockReturnValue({
      enabled: true,
      protocol: 'socks5',
      host: 'p.example.com',
      port: 1080,
      user: '',
      password: '',
      bypass: [],
      scopes: { download: false, updateApp: false, updateTrackers: true },
    })
    const resolveProxyUrl = vi.fn().mockResolvedValue('http://127.0.0.1:43123')
    const bridgedManager = new TrackerManager(
      settings as never,
      rpc as never,
      eventBus as never,
      syncer as never,
      prober as never,
      store as never,
      undefined,
      resolveProxyUrl
    )

    await bridgedManager.syncAndCurate()
    bridgedManager.dispose()

    expect(resolveProxyUrl).toHaveBeenCalledWith(settings.getProxy())
    expect(syncer.fetch).toHaveBeenCalledWith(expect.anything(), {
      server: 'http://127.0.0.1:43123',
    })
  })

  it('invalidateProxyCache is callable without throwing', () => {
    expect(() => manager.invalidateProxyCache()).not.toThrow()
  })

  it('skips source fetch when sourcesEnabled is false and writes empty bt-tracker', async () => {
    settings.get.mockReturnValue({
      tracker: {
        autoSync: false,
        syncIntervalHours: 12,
        sources: [
          {
            id: 's1',
            label: 'S1',
            url: 'http://example/list',
            builtin: false,
            enabled: true,
            cdn: false,
          },
        ],
        sourcesEnabled: false,
        probeEnabled: true,
        probeTimeoutMs: 5000,
        healthyThresholdMs: 3000,
        minSuccessRate: 0.5,
        maxTrackerCount: 50,
        blacklistEnabled: false,
        blacklistSources: [],
      },
    })

    await manager.syncAndCurate()

    expect(syncer.fetch).not.toHaveBeenCalled()
    expect(prober.probe).not.toHaveBeenCalled()
    expect(rpc.changeGlobalOption).toHaveBeenCalledWith(
      expect.objectContaining({ 'bt-tracker': '' })
    )
  })

  it('builds sourceMap from per-source urls in SourceFetchStatus', async () => {
    syncer.fetch.mockResolvedValue({
      trackers: ['udp://a', 'udp://b'],
      sourceStatus: {
        'src-1': {
          ok: true,
          count: 2,
          elapsedMs: 5,
          urls: ['udp://a', 'udp://b'],
        },
      },
    })
    prober.probe.mockResolvedValue([
      {
        url: 'udp://a',
        protocol: 'udp',
        status: 'healthy',
        lastProbeMs: 10,
        lastProbeAt: 1000,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
      },
      {
        url: 'udp://b',
        protocol: 'udp',
        status: 'healthy',
        lastProbeMs: 20,
        lastProbeAt: 1000,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
      },
    ])

    await manager.syncAndCurate()

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMap: { 'udp://a': ['src-1'], 'udp://b': ['src-1'] },
      })
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers for the new-method tests
// ---------------------------------------------------------------------------

interface RpcOverrides {
  status?: string
  getOption?: Record<string, string>
}

function makeRpcMock(overrides: RpcOverrides = {}) {
  return {
    changeGlobalOption: vi.fn().mockResolvedValue('OK'),
    changeOption: vi.fn().mockResolvedValue('OK'),
    pause: vi.fn().mockResolvedValue('gid-1'),
    unpause: vi.fn().mockResolvedValue('gid-1'),
    tellStatus: vi
      .fn()
      .mockResolvedValue({ status: overrides.status ?? 'active' }),
    getOption: vi
      .fn()
      .mockResolvedValue(overrides.getOption ?? { 'bt-tracker': '' }),
  }
}

interface ManagerOverrides {
  curatedEffective?: string[]
}

function makeManager(
  rpc: ReturnType<typeof makeRpcMock>,
  overrides: ManagerOverrides = {}
) {
  const settings = createMockSettingsManager()
  const eventBus = createMockEventBus()
  const syncer = createMockSyncer()
  const prober = createMockProber()

  // Build a store that seeds the curated effective list immediately on load
  const effectiveTrackers = overrides.curatedEffective ?? []
  const store = {
    load: vi.fn().mockResolvedValue({
      effective: effectiveTrackers,
      blacklist: [],
      healthMap: {},
      sourceMap: {},
      lastSyncAt: null,
      lastProbeAt: null,
    }),
    save: vi.fn().mockResolvedValue(undefined),
    mergeHealth: vi
      .fn()
      .mockImplementation((_existing: unknown, fresh: { url: string }[]) => {
        const map: Record<string, unknown> = {}
        for (const h of fresh) map[h.url] = h
        return map
      }),
  }
  const taskActions = {
    pauseTask: vi.fn(async () => undefined),
    resumeTask: vi.fn(async () => undefined),
  }

  const mgr = new TrackerManager(
    settings as never,
    rpc as never,
    eventBus as never,
    syncer as never,
    prober as never,
    store as never,
    taskActions
  )
  // Eagerly initialise so curated.effective is populated from the store mock
  return { manager: mgr, initPromise: mgr.init(), taskActions }
}

describe('TrackerManager.setBtTracker', () => {
  it('pauses and resumes an active task through public-id actions', async () => {
    const rpc = makeRpcMock({ status: 'active' })
    const { manager, initPromise, taskActions } = makeManager(rpc)
    await initPromise
    await manager.setBtTracker('task-1', 'gid-1', [
      'http://a.example/announce',
      'udp://b.example:80',
    ])
    expect(taskActions.pauseTask).toHaveBeenCalledWith('task-1')
    expect(rpc.changeOption).toHaveBeenCalledWith('gid-1', {
      'bt-tracker': 'http://a.example/announce,udp://b.example:80',
    })
    expect(taskActions.resumeTask).toHaveBeenCalledWith('task-1')
    expect(rpc.pause).not.toHaveBeenCalled()
    expect(rpc.unpause).not.toHaveBeenCalled()
  })

  it('does not invoke public pause/resume actions when status is paused', async () => {
    const rpc = makeRpcMock({ status: 'paused' })
    const { manager, initPromise, taskActions } = makeManager(rpc)
    await initPromise
    await manager.setBtTracker('task-1', 'gid-1', ['http://a'])
    expect(taskActions.pauseTask).not.toHaveBeenCalled()
    expect(taskActions.resumeTask).not.toHaveBeenCalled()
    expect(rpc.changeOption).toHaveBeenCalled()
  })

  it('resumes through the public-id action when changeOption rejects', async () => {
    const rpc = makeRpcMock({ status: 'active' })
    rpc.changeOption.mockRejectedValue(new Error('engine rejected option'))
    const { manager, initPromise, taskActions } = makeManager(rpc)
    await initPromise

    await expect(
      manager.setBtTracker('task-1', 'gid-1', ['http://a'])
    ).rejects.toThrow('engine rejected option')

    expect(taskActions.pauseTask).toHaveBeenCalledWith('task-1')
    expect(taskActions.resumeTask).toHaveBeenCalledWith('task-1')
  })

  it('resumes after dispose wins while the public pause action is pending', async () => {
    const pauseStarted = deferred<void>()
    const allowPause = deferred<void>()
    const rpc = makeRpcMock({ status: 'active' })
    const { manager, initPromise, taskActions } = makeManager(rpc)
    taskActions.pauseTask.mockImplementation(async () => {
      pauseStarted.resolve()
      await allowPause.promise
    })
    await initPromise

    const setting = manager.setBtTracker('task-1', 'gid-1', ['http://a'])
    await pauseStarted.promise
    manager.dispose()
    allowPause.resolve()

    await expect(setting).rejects.toThrow('TrackerManager is disposed')
    expect(rpc.changeOption).not.toHaveBeenCalled()
    expect(taskActions.resumeTask).toHaveBeenCalledWith('task-1')
  })

  it('resumes after dispose wins while changeOption is pending', async () => {
    const changeStarted = deferred<void>()
    const allowChange = deferred<void>()
    const rpc = makeRpcMock({ status: 'active' })
    rpc.changeOption.mockImplementation(async () => {
      changeStarted.resolve()
      await allowChange.promise
      return 'OK'
    })
    const { manager, initPromise, taskActions } = makeManager(rpc)
    await initPromise

    const setting = manager.setBtTracker('task-1', 'gid-1', ['http://a'])
    await changeStarted.promise
    manager.dispose()
    allowChange.resolve()

    await expect(setting).rejects.toThrow('TrackerManager is disposed')
    expect(taskActions.pauseTask).toHaveBeenCalledWith('task-1')
    expect(taskActions.resumeTask).toHaveBeenCalledWith('task-1')
  })

  it('stopAndDrain gates new changes and waits for resume compensation', async () => {
    const changeStarted = deferred<void>()
    const allowChange = deferred<void>()
    const resumeStarted = deferred<void>()
    const allowResume = deferred<void>()
    const rpc = makeRpcMock({ status: 'active' })
    rpc.changeOption.mockImplementation(async () => {
      changeStarted.resolve()
      await allowChange.promise
      return 'OK'
    })
    const { manager, initPromise, taskActions } = makeManager(rpc)
    taskActions.resumeTask.mockImplementation(async () => {
      resumeStarted.resolve()
      await allowResume.promise
    })
    await initPromise

    const setting = manager.setBtTracker('task-1', 'gid-1', ['http://a'])
    await changeStarted.promise
    const draining = manager.stopAndDrain()

    await expect(
      manager.setBtTracker('task-2', 'gid-2', ['http://b'])
    ).rejects.toThrow('TrackerManager is disposed')
    allowChange.resolve()
    await resumeStarted.promise

    let drained = false
    void draining.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    allowResume.resolve()
    await expect(setting).rejects.toThrow('TrackerManager is disposed')
    await draining

    expect(taskActions.resumeTask).toHaveBeenCalledWith('task-1')
    expect(drained).toBe(true)
  })

  it('writes empty bt-tracker for empty list', async () => {
    const rpc = makeRpcMock({ status: 'paused' })
    const { manager, initPromise } = makeManager(rpc)
    await initPromise
    await manager.setBtTracker('task-1', 'gid-1', [])
    expect(rpc.changeOption).toHaveBeenCalledWith('gid-1', {
      'bt-tracker': '',
    })
  })
})

describe('TrackerManager.syncBtTracker', () => {
  it('additively merges global into effective and writes back', async () => {
    const rpc = makeRpcMock({
      status: 'paused',
      getOption: { 'bt-tracker': 'http://a.example,http://b.example' },
    })
    const { manager, initPromise } = makeManager(rpc, {
      curatedEffective: ['http://b.example', 'http://c.example'],
    })
    await initPromise
    await manager.syncBtTracker('task-1', 'gid-1', false)
    const optsArg = (rpc.changeOption as Mock).mock.calls[0][1]
    const trackers = (optsArg['bt-tracker'] as string).split(',')
    expect(new Set(trackers)).toEqual(
      new Set(['http://a.example', 'http://b.example', 'http://c.example'])
    )
  })

  it('is a no-op for private torrents', async () => {
    const rpc = makeRpcMock({ status: 'paused' })
    const { manager, initPromise } = makeManager(rpc, {
      curatedEffective: ['http://x'],
    })
    await initPromise
    await manager.syncBtTracker('task-1', 'gid-1', true)
    expect(rpc.changeOption).not.toHaveBeenCalled()
  })
})

describe('TrackerManager.applySourcesChange', () => {
  it('clears bt-tracker when disabled', async () => {
    const rpc = makeRpcMock()
    const { manager, initPromise } = makeManager(rpc)
    await initPromise
    await manager.applySourcesChange(false)
    expect(rpc.changeGlobalOption).toHaveBeenCalledWith({ 'bt-tracker': '' })
  })

  it('triggers syncAndCurate when enabled', async () => {
    const rpc = makeRpcMock()
    const { manager, initPromise } = makeManager(rpc)
    await initPromise
    const spy = vi.spyOn(manager, 'syncAndCurate').mockResolvedValue({
      totalFetched: 0,
      totalHealthy: 0,
      totalCurated: 0,
      syncResult: { trackers: [], sourceStatus: {} },
    })
    await manager.applySourcesChange(true)
    expect(spy).toHaveBeenCalled()
  })
})

describe('TrackerManager.applyBlacklistChange', () => {
  it('clears bt-exclude-tracker when disabled', async () => {
    const rpc = makeRpcMock()
    const { manager, initPromise } = makeManager(rpc)
    await initPromise
    await manager.applyBlacklistChange(false)
    expect(rpc.changeGlobalOption).toHaveBeenCalledWith({
      'bt-exclude-tracker': '',
    })
  })

  it('triggers syncAndCurate when enabled', async () => {
    const rpc = makeRpcMock()
    const { manager, initPromise } = makeManager(rpc)
    await initPromise
    const spy = vi.spyOn(manager, 'syncAndCurate').mockResolvedValue({
      totalFetched: 0,
      totalHealthy: 0,
      totalCurated: 0,
      syncResult: { trackers: [], sourceStatus: {} },
    })
    await manager.applyBlacklistChange(true)
    expect(spy).toHaveBeenCalled()
  })
})

describe('TrackerManager engine-ready cache push', () => {
  function makeStoreWithCurated(cached: CuratedTrackerList) {
    return {
      load: vi.fn().mockResolvedValue(cached),
      save: vi.fn().mockResolvedValue(undefined),
      mergeHealth: vi
        .fn()
        .mockImplementation((_existing: unknown, fresh: { url: string }[]) => {
          const map: Record<string, unknown> = {}
          for (const h of fresh) map[h.url] = h
          return map
        }),
    }
  }

  function makeSettingsWithFlags(opts: {
    sourcesEnabled: boolean
    blacklistEnabled: boolean
  }) {
    const base = createMockSettingsManager()
    base.get.mockReturnValue({
      tracker: {
        autoSync: false,
        syncIntervalHours: 12,
        sources: [],
        sourcesEnabled: opts.sourcesEnabled,
        probeEnabled: true,
        probeTimeoutMs: 5000,
        healthyThresholdMs: 3000,
        minSuccessRate: 0.5,
        maxTrackerCount: 50,
        blacklistEnabled: opts.blacklistEnabled,
        blacklistSources: [],
      },
    })
    return base
  }

  function makeCached(
    effective: string[],
    blacklist: string[] = []
  ): CuratedTrackerList {
    return {
      effective,
      blacklist,
      healthMap: {},
      sourceMap: {},
      lastSyncAt: 1,
      lastProbeAt: 1,
    }
  }

  function makeHarness(
    cached: CuratedTrackerList,
    flags = { sourcesEnabled: true, blacklistEnabled: false }
  ) {
    const rpc = makeRpcMock()
    const eventBus = createMockEventBus()
    const store = makeStoreWithCurated(cached)
    const mgr = new TrackerManager(
      makeSettingsWithFlags(flags) as never,
      rpc as never,
      eventBus as never,
      createMockSyncer() as never,
      createMockProber() as never,
      store as never
    )
    return { mgr, rpc, eventBus, store }
  }

  it('waits for engine ready before pushing cached effective and blacklist', async () => {
    const { mgr, rpc, eventBus } = makeHarness(
      makeCached(['udp://cached-tracker'], ['udp://cached-bad']),
      { sourcesEnabled: true, blacklistEnabled: true }
    )
    await mgr.init()
    expect(rpc.changeGlobalOption).not.toHaveBeenCalled()

    eventBus.emit(Events.EngineRecovered)
    expect(rpc.changeGlobalOption).toHaveBeenCalledWith({
      'bt-tracker': 'udp://cached-tracker',
      'bt-exclude-tracker': 'udp://cached-bad',
    })
    mgr.dispose()
  })

  it('pushes after init when engine ready arrives while cache is loading', async () => {
    const cached = makeCached(['udp://cached-tracker'])
    const loaded = deferred<CuratedTrackerList>()
    const { mgr, rpc, eventBus, store } = makeHarness(cached)
    store.load.mockReturnValueOnce(loaded.promise)

    const initializing = mgr.init()
    eventBus.emit(Events.EngineRecovered)
    expect(rpc.changeGlobalOption).not.toHaveBeenCalled()

    loaded.resolve(cached)
    await initializing
    expect(rpc.changeGlobalOption).toHaveBeenCalledWith({
      'bt-tracker': 'udp://cached-tracker',
    })
    mgr.dispose()
  })

  it('reapplies cached state after an engine reconnect', async () => {
    const { mgr, rpc, eventBus } = makeHarness(
      makeCached(['udp://cached-tracker'])
    )
    await mgr.init()

    eventBus.emit(Events.EngineRecovered)
    eventBus.emit(Events.EngineDisconnected)
    eventBus.emit(Events.EngineRecovered)

    expect(rpc.changeGlobalOption).toHaveBeenCalledTimes(2)
    mgr.dispose()
  })

  it('does not push after disposal', async () => {
    const { mgr, rpc, eventBus } = makeHarness(
      makeCached(['udp://cached-tracker'])
    )
    await mgr.init()
    mgr.dispose()

    eventBus.emit(Events.EngineRecovered)

    expect(rpc.changeGlobalOption).not.toHaveBeenCalled()
    expect(eventBus.off).toHaveBeenCalledWith(
      Events.EngineRecovered,
      expect.any(Function)
    )
  })

  it('waits for an accepted cache push during shutdown', async () => {
    const pushStarted = deferred<void>()
    const allowPush = deferred<void>()
    const { mgr, rpc, eventBus } = makeHarness(
      makeCached(['udp://cached-tracker'])
    )
    rpc.changeGlobalOption.mockImplementation(async () => {
      pushStarted.resolve()
      await allowPush.promise
      return 'OK'
    })
    await mgr.init()
    eventBus.emit(Events.EngineRecovered)
    await pushStarted.promise

    const draining = mgr.stopAndDrain()
    let drained = false
    void draining.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    allowPush.resolve()
    await draining
    expect(drained).toBe(true)
  })

  it('does not push when both subsystems are disabled', async () => {
    const { mgr, rpc, eventBus } = makeHarness(
      makeCached(['udp://x'], ['udp://y']),
      { sourcesEnabled: false, blacklistEnabled: false }
    )
    await mgr.init()
    eventBus.emit(Events.EngineRecovered)
    expect(rpc.changeGlobalOption).not.toHaveBeenCalled()
    mgr.dispose()
  })
})
