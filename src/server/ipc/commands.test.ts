import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import type { EventBus } from '@core/events/event-bus'
import { NotificationCenter } from '@core/notifications/notification-center'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import type { GrantsManager } from '@core/plugin/grants/grants-manager'
import type { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import type { RegistryClient } from '@core/plugin/registry/registry-client'
import type { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { MotrixDatabase } from '@core/session/motrix-database'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { FileCleanupService } from '@core/task/file-cleanup-service'
import type { FinalNamePicker } from '@core/task/final-name-picker'
import type { TaskManager } from '@core/task/task-manager'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import type { MagnetTracker } from '@core/torrent/magnet-tracker'
import type { TrackerManager } from '@core/tracker'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerPluginInstallService } from '../plugin/install-service'
import type { ServerCommandContext } from './commands'
import { buildServerCommandHandlers } from './commands'

const PROXY_OFF = {
  enabled: false,
  protocol: 'http' as const,
  host: '',
  port: 8080,
  user: '',
  password: '',
  bypass: [] as string[],
  scopes: { download: false, updateApp: false, updateTrackers: false },
}
const PROXY_ON = { ...PROXY_OFF, enabled: true, host: 'p.example', port: 80 }

function makeFakeCtx() {
  return {
    supervisor: {
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      applyEngineSettings: vi.fn().mockResolvedValue(undefined),
      applyAsyncDns: vi.fn().mockResolvedValue(undefined),
      applyDefaultSaveDir: vi.fn().mockResolvedValue(undefined),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      assertReady: vi.fn(),
    } as unknown as EngineSupervisor,
    dnsFallback: { reset: vi.fn() },
    settingsManager: {
      get: vi.fn(),
      update: vi.fn(),
      removePluginConfig: vi.fn().mockResolvedValue(undefined),
      getApp: vi.fn(() => ({
        defaultSaveDir: '/tmp',
        magnetFileSelection: true,
      })),
      getEngine: vi.fn(() => ({ userAgent: 'Motrix/Test' })),
    } as unknown as SettingsManager,
    geoipManager: {
      triggerUpdate: vi.fn(),
    },
    rpcClient: {} as Aria2RpcClient,
    adapter: {} as EngineAdapter,
    trackerManager: {
      applySourcesChange: vi.fn().mockResolvedValue(undefined),
      applyBlacklistChange: vi.fn().mockResolvedValue(undefined),
      applySyncScheduleChange: vi.fn(),
    } as unknown as TrackerManager,
    bridgeControl: {
      setEnabled: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
    },
    aria2BinaryPath: '/usr/bin/aria2c',
    finalNamePicker: {} as FinalNamePicker,
    torrentMetaStore: {} as TorrentMetaStore,
    taskManager: {
      getById: vi.fn(() => undefined),
    } as unknown as TaskManager,
    fileCleanupService: {} as FileCleanupService,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    proxyApplier: {
      apply: vi.fn().mockResolvedValue({ downloadProxy: 'unchanged' }),
      applyAll: vi.fn().mockResolvedValue({ downloadProxy: 'unchanged' }),
    },
    appliedDownloadProxyPolicy: new AppliedDownloadProxyPolicy({ noProxy: '' }),
    motrixDatabase: {
      deleteMetadata: vi.fn(),
    } as unknown as MotrixDatabase,
    notificationCenter: {
      notify: vi.fn(() => ({ fresh: true })),
      markRead: vi.fn(() => true),
      markAllRead: vi.fn(() => 0),
      delete: vi.fn(() => true),
      clear: vi.fn(() => 0),
    } as unknown as NotificationCenter,
    taskPersistence: {
      runExclusivePersistence: vi.fn(
        async (operation: () => unknown | Promise<unknown>) => operation()
      ),
    },
    pluginRegistry: {
      refreshState: vi.fn(),
      list: vi.fn(() => []),
    } as unknown as PluginRegistry,
    registryClient: {
      refresh: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as RegistryClient,
    hostVersion: '2.0',
    pluginStateStore: {
      setEnabled: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as PluginStateStore,
    pluginHost: {
      deactivate: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginHost,
    pluginInstaller: {
      commit: vi.fn(),
      cancel: vi.fn(),
      uninstall: vi.fn(),
    } as unknown as PluginInstaller,
    pluginInstallService: {
      stage: vi.fn(),
    } as unknown as ServerPluginInstallService,
    pluginGrants: { updateGrants: vi.fn() } as unknown as GrantsManager,
    capabilityHost: {
      secrets: {
        available: vi.fn(() => false),
        encrypt: vi.fn(),
      },
      configFor: vi.fn(() => ({ applyExternalChange: vi.fn() })),
      clearLog: vi.fn(),
      setLogVerbose: vi.fn(),
    } as unknown as CapabilityHost,
    userDataDir: '/tmp/userdata',
    pluginsDir: '/tmp/userdata/plugins',
    pluginActivation: {
      dispatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActivationDispatcher,
    magnetTracker: {
      submit: vi.fn().mockResolvedValue(undefined),
      retryMetadata: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue('removed'),
      observe: vi.fn().mockReturnValue(false),
      dispose: vi.fn(),
      primeFromDatabase: vi.fn(),
    } as unknown as MagnetTracker,
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    runTaskMutation: vi.fn(
      async (_taskIds: readonly string[], operation: () => Promise<unknown>) =>
        operation()
    ),
    downloadPathPolicy: {
      allowedSaveDirs: ['/downloads'],
      prepareSaveDir: vi.fn(async (requested: string) => requested),
    },
  }
}

function makeSettings(
  proxy: typeof PROXY_OFF,
  tracker: {
    sourcesEnabled?: boolean
    blacklistEnabled?: boolean
    autoSync?: boolean
    syncIntervalHours?: number
  } = {},
  engine: { dnsMode?: 'auto' | 'system' | 'engine'; split?: number } = {},
  app: { defaultSaveDir?: string; browserBridgeEnabled?: boolean } = {},
  bridge: { fixedPort?: 'auto' | number } = {}
) {
  return {
    app: {
      defaultSaveDir: '/downloads',
      browserBridgeEnabled: true,
      ...app,
    },
    bridge: { fixedPort: 'auto' as const, ...bridge },
    proxy,
    tracker: {
      sourcesEnabled: true,
      blacklistEnabled: true,
      autoSync: true,
      syncIntervalHours: 24,
      ...tracker,
    },
    engine: {
      dnsMode: 'auto',
      ...engine,
    },
  }
}

describe('server Commands.UpdateSettings', () => {
  it('does not invoke proxyApplier when proxy unchanged', async () => {
    const ctx = makeFakeCtx()
    const settings = makeSettings(PROXY_OFF)
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockReturnValue(
      settings
    )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({})
    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
    expect(ctx.supervisor.stop).not.toHaveBeenCalled()
  })

  it('reasserts every proxy scope when proxy fields changed', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSettings(PROXY_OFF))
      .mockReturnValue(makeSettings(PROXY_ON))
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })
    expect(ctx.proxyApplier.applyAll).toHaveBeenCalledWith(PROXY_ON)
    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
  })

  it('commits the exact route returned by a successful proxy hot-apply', async () => {
    const ctx = makeFakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSettings(PROXY_OFF))
      .mockReturnValue(makeSettings(PROXY_ON))
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      downloadProxy: 'applied',
      appliedProxy: {
        allProxy: 'http://bridge-user:bridge-pass@127.0.0.1:43123',
        noProxy: 'localhost',
      },
    })
    const handlers = buildServerCommandHandlers({
      ...ctx,
      appliedDownloadProxyPolicy: policy,
    } as Parameters<typeof buildServerCommandHandlers>[0])

    await handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })

    expect(policy.snapshot()).toEqual({
      proxy: 'http://bridge-user:bridge-pass@127.0.0.1:43123',
      noProxy: 'localhost',
    })
  })

  it('leaves the route unavailable when proxy hot-apply throws', async () => {
    const ctx = makeFakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSettings(PROXY_OFF))
      .mockReturnValue(makeSettings(PROXY_ON))
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('RPC failed')
    )
    const handlers = buildServerCommandHandlers({
      ...ctx,
      appliedDownloadProxyPolicy: policy,
    } as Parameters<typeof buildServerCommandHandlers>[0])

    await expect(
      handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })
    ).rejects.toThrow('RPC failed')
    expect(policy.snapshot()).toBeNull()
  })

  it('force-reapplies the same proxy after a failed hot apply', async () => {
    const ctx = makeFakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    const before = makeSettings(PROXY_OFF)
    const after = makeSettings(PROXY_ON)
    let current = before
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockImplementation(
      () => current
    )
    ;(
      ctx.settingsManager.update as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      current = after
      return { ok: true, requiresRestart: false, changedRestartKeys: [] }
    })
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('RPC failed'))
      .mockResolvedValueOnce({
        downloadProxy: 'applied',
        appliedProxy: {
          allProxy: 'http://p.example:80',
          noProxy: '',
        },
      })
    const handlers = buildServerCommandHandlers({
      ...ctx,
      appliedDownloadProxyPolicy: policy,
    } as Parameters<typeof buildServerCommandHandlers>[0])

    await expect(
      handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })
    ).rejects.toThrow('RPC failed')
    expect(policy.snapshot()).toBeNull()

    await expect(
      handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })
    ).resolves.toBeDefined()
    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
    expect(ctx.proxyApplier.applyAll).toHaveBeenCalledTimes(2)
    expect(ctx.proxyApplier.applyAll).toHaveBeenLastCalledWith(PROXY_ON)
    expect(policy.snapshot()).toEqual({
      proxy: 'http://p.example:80',
      noProxy: '',
    })
  })

  it('does not lose a download proxy when concurrent updates change different scopes', async () => {
    const ctx = makeFakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    const proxyA = {
      ...PROXY_ON,
      scopes: { download: true, updateApp: false, updateTrackers: false },
    }
    const proxyB = {
      ...proxyA,
      scopes: { download: true, updateApp: true, updateTrackers: false },
    }
    const before = makeSettings(PROXY_OFF)
    const afterA = makeSettings(proxyA)
    const afterB = makeSettings(proxyB)
    let current = before
    let releaseReader!: () => void
    let readerStarted = false
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    const reader = policy.runWithSnapshot(async () => {
      readerStarted = true
      await readerGate
    })
    await vi.waitFor(() => expect(readerStarted).toBe(true))
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockImplementation(
      () => current
    )
    ;(
      ctx.settingsManager.update as ReturnType<typeof vi.fn>
    ).mockImplementation(async (partial: { proxy?: { scopes?: object } }) => {
      current = partial.proxy?.scopes === proxyA.scopes ? afterA : afterB
      return { ok: true, requiresRestart: false, changedRestartKeys: [] }
    })
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>).mockImplementation(
      async (next) => ({
        downloadProxy: 'applied',
        appliedProxy: {
          allProxy: `http://${next.host}:${next.port}`,
          noProxy: '',
        },
      })
    )
    const handlers = buildServerCommandHandlers({
      ...ctx,
      appliedDownloadProxyPolicy: policy,
    } as Parameters<typeof buildServerCommandHandlers>[0])

    const first = handlers[Commands.UpdateSettings]?.({ proxy: proxyA })
    await vi.waitFor(() => expect(current).toBe(afterA))
    const second = handlers[Commands.UpdateSettings]?.({ proxy: proxyB })
    await vi.waitFor(() => expect(current).toBe(afterB))
    releaseReader()
    await Promise.all([reader, first, second])

    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
    expect(ctx.proxyApplier.applyAll).toHaveBeenCalledExactlyOnceWith(proxyB)
    expect(policy.snapshot()).toEqual({
      proxy: 'http://p.example:80',
      noProxy: '',
    })
  })

  it('hot-applies a changed default save directory', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {}, {}, { defaultSaveDir: '/downloads/old' })
      )
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {}, {}, { defaultSaveDir: '/downloads/new' })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.UpdateSettings]?.({
      app: { defaultSaveDir: '/downloads/new' },
    })

    expect(ctx.supervisor.applyDefaultSaveDir).toHaveBeenCalledExactlyOnceWith(
      '/downloads/new'
    )
  })

  it('hot-applies the browser bridge master switch', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {}, {}, { browserBridgeEnabled: true })
      )
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {}, {}, { browserBridgeEnabled: false })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.UpdateSettings]?.({
      app: { browserBridgeEnabled: false },
    })

    expect(ctx.bridgeControl.setEnabled).toHaveBeenCalledExactlyOnceWith(false)
    expect(ctx.bridgeControl.restart).not.toHaveBeenCalled()
  })

  it('restarts an enabled bridge when its fixed port changes', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSettings(PROXY_OFF))
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {}, {}, {}, { fixedPort: 18080 })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.UpdateSettings]?.({ bridge: { fixedPort: 18080 } })

    expect(ctx.bridgeControl.restart).toHaveBeenCalledOnce()
  })

  it('hot-applies async-dns and resets the fallback latch when dnsMode changes', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSettings(PROXY_OFF, {}, { dnsMode: 'auto' }))
      .mockReturnValueOnce(makeSettings(PROXY_OFF, {}, { dnsMode: 'system' }))
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({ engine: { dnsMode: 'system' } })
    expect(ctx.supervisor.applyAsyncDns).toHaveBeenCalledExactlyOnceWith(false)
    expect(ctx.dnsFallback.reset).toHaveBeenCalledOnce()
    expect(ctx.supervisor.stop).not.toHaveBeenCalled()
  })

  it('leaves async-dns alone when dnsMode is unchanged', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSettings(PROXY_OFF)
    )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({})
    expect(ctx.supervisor.applyAsyncDns).not.toHaveBeenCalled()
    expect(ctx.dnsFallback.reset).not.toHaveBeenCalled()
  })

  it('publishes a restart reminder without stopping the engine', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSettings(PROXY_OFF)
    )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: true, changedRestartKeys: ['rpcPort'] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({ engine: { rpcPort: 9000 } })
    expect(ctx.supervisor.stop).not.toHaveBeenCalled()
    expect(ctx.supervisor.start).not.toHaveBeenCalled()
    expect(ctx.notificationCenter.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'engine-restart-required',
        severity: 'warning',
      })
    )
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.EngineRestartRequired,
      { changedKeys: ['rpcPort'] }
    )
  })

  it('hot-applies runtime engine settings without a restart reminder', async () => {
    const ctx = makeFakeCtx()
    const before = makeSettings(PROXY_OFF, {}, { dnsMode: 'auto', split: 16 })
    const after = makeSettings(PROXY_OFF, {}, { dnsMode: 'auto', split: 32 })
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(before)
      .mockReturnValueOnce(after)
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.UpdateSettings]?.({ engine: { split: 32 } })

    expect(ctx.supervisor.applyEngineSettings).toHaveBeenCalledWith(
      before.engine,
      after.engine
    )
    expect(ctx.notificationCenter.notify).not.toHaveBeenCalled()
  })

  it('calls trackerManager.applySourcesChange when sourcesEnabled changes', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {
          sourcesEnabled: true,
          blacklistEnabled: true,
        })
      )
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {
          sourcesEnabled: false,
          blacklistEnabled: true,
        })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({
      tracker: { sourcesEnabled: false },
    })
    expect(ctx.trackerManager.applySourcesChange).toHaveBeenCalledWith(false)
    expect(ctx.trackerManager.applyBlacklistChange).not.toHaveBeenCalled()
  })

  it('calls trackerManager.applyBlacklistChange when blacklistEnabled changes', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {
          sourcesEnabled: true,
          blacklistEnabled: true,
        })
      )
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {
          sourcesEnabled: true,
          blacklistEnabled: false,
        })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({
      tracker: { blacklistEnabled: false },
    })
    expect(ctx.trackerManager.applyBlacklistChange).toHaveBeenCalledWith(false)
    expect(ctx.trackerManager.applySourcesChange).not.toHaveBeenCalled()
  })

  it('calls both apply* methods when both toggle in one patch', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {
          sourcesEnabled: true,
          blacklistEnabled: true,
        })
      )
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, {
          sourcesEnabled: false,
          blacklistEnabled: false,
        })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({
      tracker: { sourcesEnabled: false, blacklistEnabled: false },
    })
    expect(ctx.trackerManager.applySourcesChange).toHaveBeenCalledWith(false)
    expect(ctx.trackerManager.applyBlacklistChange).toHaveBeenCalledWith(false)
  })

  it('does not call apply* methods when tracker toggles unchanged', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSettings(PROXY_OFF, { sourcesEnabled: true, blacklistEnabled: true })
    )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({})
    expect(ctx.trackerManager.applySourcesChange).not.toHaveBeenCalled()
    expect(ctx.trackerManager.applyBlacklistChange).not.toHaveBeenCalled()
    expect(ctx.trackerManager.applySyncScheduleChange).not.toHaveBeenCalled()
  })

  it('re-arms tracker auto-sync when its enablement or interval changes', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, { autoSync: true, syncIntervalHours: 24 })
      )
      .mockReturnValueOnce(
        makeSettings(PROXY_OFF, { autoSync: false, syncIntervalHours: 12 })
      )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.UpdateSettings]?.({
      tracker: { autoSync: false, syncIntervalHours: 12 },
    })

    expect(ctx.trackerManager.applySyncScheduleChange).toHaveBeenCalledOnce()
  })

  it('validates a default save directory before persisting settings', async () => {
    const ctx = makeFakeCtx()
    ;(
      ctx.downloadPathPolicy.prepareSaveDir as ReturnType<typeof vi.fn>
    ).mockResolvedValue('/downloads/media-canonical')
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSettings(PROXY_OFF)
    )
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.UpdateSettings]?.({
      app: { defaultSaveDir: '/downloads/media' },
    })

    expect(ctx.downloadPathPolicy.prepareSaveDir).toHaveBeenCalledWith(
      '/downloads/media'
    )
    expect(ctx.settingsManager.update).toHaveBeenCalledWith({
      app: { defaultSaveDir: '/downloads/media-canonical' },
    })
  })
})

describe('server Commands.UpdateGeoIPDatabase', () => {
  it('delegates the update to the shared GeoIP manager', async () => {
    const ctx = makeFakeCtx()
    const status = {
      enabled: true,
      hasDatabase: true,
      loaded: true,
      lastUpdatedAt: 1_800_000_000_000,
      databaseVersion: 'v1',
      sizeBytes: 9_000_000,
      isDownloading: false,
      lastError: null,
    }
    ctx.geoipManager.triggerUpdate.mockResolvedValue(status)
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(handlers[Commands.UpdateGeoIPDatabase]?.()).resolves.toBe(
      status
    )
    expect(ctx.geoipManager.triggerUpdate).toHaveBeenCalledOnce()
  })
})

describe('server Commands.CreateTask magnet metadata selection', () => {
  it('submits bare magnet to metadata selection when enabled', async () => {
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    const result = await handlers[Commands.CreateTask]?.({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc' },
      selectedFiles: [],
      saveDir: '/downloads',
    })

    expect(result).toEqual({ ok: true })
    expect(ctx.magnetTracker.submit).toHaveBeenCalledWith(
      'magnet:?xt=urn:btih:abc',
      '/downloads'
    )
    expect(ctx.downloadPathPolicy.prepareSaveDir).toHaveBeenCalledWith(
      '/downloads'
    )
  })

  it('admits a selection swap through the canonical task lock', async () => {
    const ctx = makeFakeCtx()
    ctx.motrixDatabase = {
      ...ctx.motrixDatabase,
      getTask: vi.fn(() => null),
    } as unknown as MotrixDatabase
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.CreateTask]?.({
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: 'AAAA' },
        selectedFiles: [0],
        saveDir: '/downloads',
        existingTaskId: 'metadata-task',
      })
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })

    expect(ctx.runTaskMutation).toHaveBeenCalledWith(
      ['metadata-task'],
      expect.any(Function)
    )
  })
})

describe('server plural task commands', () => {
  it('PauseTasks fans out per id and returns the IPC-safe bulk result', async () => {
    const ctx = makeFakeCtx()
    const tasks = new Map([
      [
        't-1',
        {
          id: 't-1',
          engineTaskId: 'gid-1',
          status: TaskStatus.Downloading,
          instances: [],
        },
      ],
      [
        't-2',
        {
          id: 't-2',
          engineTaskId: 'gid-2',
          status: TaskStatus.Downloading,
          instances: [],
        },
      ],
    ])
    vi.mocked(ctx.taskManager.getById).mockImplementation(
      (id: string) => tasks.get(id) as never
    )
    ;(ctx.taskManager as unknown as { set: unknown }).set = vi.fn()
    ctx.adapter.pauseTask = vi.fn(async (gid: string) => {
      if (gid === 'gid-2') throw new Error('engine rejected')
    })
    ctx.adapter.getTaskStatus = vi.fn().mockResolvedValue(null)
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.PauseTasks]?.(['t-1', 't-2'])
    ).resolves.toEqual({
      succeeded: ['t-1'],
      failed: [{ taskId: 't-2', reason: 'engine rejected' }],
    })
  })

  it('PauseTasks rejects a malformed payload', async () => {
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(handlers[Commands.PauseTasks]?.([])).rejects.toThrow()
  })

  it('RetryTasks routes unresolved magnet metadata to MagnetTracker', async () => {
    const ctx = makeFakeCtx()
    vi.mocked(ctx.taskManager.getById).mockReturnValue({
      id: 'magnet-timeout',
      status: TaskStatus.Error,
      type: TaskType.Magnet,
      torrentMetaPath: null,
      instances: [
        {
          phase: TaskInstancePhase.MagnetMetadataResolution,
          uris: ['magnet:?xt=urn:btih:timeout'],
        },
      ],
    } as never)
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.RetryTasks]?.(['magnet-timeout'])
    ).resolves.toEqual({ succeeded: ['magnet-timeout'], failed: [] })

    expect(ctx.magnetTracker.retryMetadata).toHaveBeenCalledWith(
      'magnet-timeout'
    )
  })
})

describe('server Commands.StopSeedingTask', () => {
  it('stops seeding and persists Completed (web parity with desktop)', async () => {
    const persistTask = vi.fn(async () => {})
    const ctx = { ...makeFakeCtx(), persistTask }
    vi.mocked(ctx.taskManager.getById).mockReturnValue({
      id: 't-seed',
      engineTaskId: 'gid-seed',
      status: TaskStatus.Seeding,
      type: TaskType.Bt,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      instances: [],
    } as never)
    ;(ctx.taskManager as unknown as { set: unknown }).set = vi.fn()
    ctx.adapter.forceRemoveTask = vi.fn().mockResolvedValue(undefined)
    ctx.adapter.getTaskStatus = vi.fn().mockResolvedValue(null)
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.StopSeedingTask]?.('t-seed')
    ).resolves.toEqual({ ok: true })

    expect(ctx.adapter.forceRemoveTask).toHaveBeenCalledWith('gid-seed')
    expect(persistTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-seed', status: TaskStatus.Completed })
    )
  })
})

describe('server Commands.RemoveTask mutation admission', () => {
  it('routes removal through the mutation lock and Session persistence queue', async () => {
    const ctx = makeFakeCtx()
    ctx.taskManager = {
      getById: vi.fn(() => ({
        id: 'remove-me',
        engineTaskId: 'gid-remove',
        diskPath: '/downloads/remove-me',
        type: TaskType.Http,
        status: TaskStatus.Completed,
        torrentMetaPath: null,
        instances: [],
      })),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
    } as unknown as TaskManager
    ctx.adapter = {
      removeDownloadResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAdapter
    ctx.fileCleanupService = {
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileCleanupService
    ctx.torrentMetaStore = {
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as TorrentMetaStore
    ctx.motrixDatabase = {
      deleteTask: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      saveTaskWithInstances: vi.fn(),
    } as unknown as MotrixDatabase
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.RemoveTask]?.({
        taskId: 'remove-me',
        deleteWithFiles: false,
      })
    ).resolves.toEqual({ ok: true })

    expect(ctx.runTaskMutation).toHaveBeenCalledWith(
      ['remove-me'],
      expect.any(Function)
    )
    expect(ctx.taskPersistence.runExclusivePersistence).toHaveBeenCalledOnce()
  })
})

describe('server Commands.ReAddTask', () => {
  it('is registered and drives reAddTask through the mutation lock', async () => {
    const ctx = makeFakeCtx()
    ctx.taskManager = {
      getById: vi.fn(() => ({
        id: 'retry-me',
        engineTaskId: 'gid-retry',
        kind: TaskKind.Bt,
        type: TaskType.Bt,
        status: TaskStatus.Error,
        torrentMetaPath: '/sidecar/retry-me.torrent',
        diskPath: '/downloads/retry-me.motrix',
        finalPath: '/downloads/retry-me',
        finalName: 'retry-me',
        uris: [],
        bt: null,
        instances: [],
      })),
      getAll: vi.fn(() => []),
      reserveEngineTaskId: vi.fn(),
      setReservedEngineTaskOwner: vi.fn(),
      releaseEngineTaskIdReservation: vi.fn(() => true),
      retireEngineTaskIdReservation: vi.fn(() => true),
      set: vi.fn(),
    } as unknown as TaskManager
    ctx.adapter = {
      getEngineTaskOptions: vi.fn().mockResolvedValue(null),
      forceRemoveTask: vi.fn().mockResolvedValue(undefined),
      removeDownloadResult: vi.fn().mockResolvedValue(undefined),
      addTorrent: vi.fn(async ({ gid }: { gid?: string }) => gid ?? ''),
    } as unknown as EngineAdapter
    ctx.torrentMetaStore = {
      read: vi.fn().mockResolvedValue(new Uint8Array([0x64, 0x38])),
    } as unknown as TorrentMetaStore
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    expect(handlers[Commands.ReAddTask]).toBeDefined()
    await expect(handlers[Commands.ReAddTask]?.('retry-me')).resolves.toEqual({
      ok: true,
    })

    expect(ctx.runTaskMutation).toHaveBeenCalledWith(
      ['retry-me'],
      expect.any(Function)
    )
    expect(ctx.adapter.addTorrent).toHaveBeenCalledOnce()
  })
})

describe('server Commands.UpdatePluginConfig', () => {
  function makePluginCtx(
    opts: {
      secretFields?: string[]
      priorConfig?: Record<string, unknown>
    } = {}
  ) {
    const { secretFields = [], priorConfig = {} } = opts
    const properties: Record<string, { secret?: boolean }> = {}
    for (const key of secretFields) {
      properties[key] = { secret: true }
    }
    const manifest = {
      id: 'test-plugin',
      contributes: {
        configuration: {
          schema: { properties },
        },
      },
    }
    const applyExternalChange = vi.fn()
    const configFor = vi.fn(() => ({ applyExternalChange }))
    const encrypt = vi.fn(async (v: string) => `cipher:${v}`)
    const capabilityHost = {
      secrets: {
        available: vi.fn(() => true),
        encrypt,
      },
      configFor,
    }
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
      plugins: { 'test-plugin': priorConfig },
    })
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }
    )
    const pluginRegistry = {
      get: vi.fn((id: string) =>
        id === 'test-plugin' ? { manifest } : undefined
      ),
    }
    return {
      ctx: {
        ...ctx,
        pluginRegistry: pluginRegistry as unknown as PluginRegistry,
        capabilityHost: capabilityHost as unknown as CapabilityHost,
      } as ServerCommandContext,
      settingsManager: ctx.settingsManager,
      eventBus: ctx.eventBus,
      applyExternalChange,
      encrypt,
    }
  }

  it('persists config and emits PluginConfigChanged', async () => {
    const { ctx, settingsManager, eventBus, applyExternalChange } =
      makePluginCtx()
    const handlers = buildServerCommandHandlers(ctx)
    const result = await handlers[Commands.UpdatePluginConfig]?.({
      pluginId: 'test-plugin',
      patch: { timeout: 60 },
    })
    expect(result).toEqual({ ok: true })
    expect(settingsManager.update).toHaveBeenCalledWith({
      plugins: { 'test-plugin': { timeout: 60 } },
    })
    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.PluginConfigChanged,
      expect.objectContaining({ pluginId: 'test-plugin' })
    )
    expect(applyExternalChange).toHaveBeenCalledWith([
      { key: 'timeout', value: 60, previous: undefined },
    ])
  })

  it('encrypts secret-flagged string fields before persisting', async () => {
    const { ctx, settingsManager, encrypt } = makePluginCtx({
      secretFields: ['apiKey'],
    })
    const handlers = buildServerCommandHandlers(ctx)
    await handlers[Commands.UpdatePluginConfig]?.({
      pluginId: 'test-plugin',
      patch: { apiKey: 'plaintext', timeout: 60 },
    })
    expect(encrypt).toHaveBeenCalledWith('plaintext')
    expect(settingsManager.update).toHaveBeenCalledWith({
      plugins: {
        'test-plugin': { apiKey: 'cipher:plaintext', timeout: 60 },
      },
    })
  })

  it('throws when plugin not found in registry', async () => {
    const { ctx } = makePluginCtx()
    const handlers = buildServerCommandHandlers(ctx)
    await expect(
      handlers[Commands.UpdatePluginConfig]?.({
        pluginId: 'no-such-plugin',
        patch: {},
      })
    ).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
  })
})

describe('server plugin enable/disable commands', () => {
  it('emits contribution index changes when enabling a plugin', async () => {
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.EnablePlugin]?.('test-plugin')

    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.PluginStatusChanged,
      expect.objectContaining({ id: 'test-plugin', enabled: true })
    )
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.ContributionIndexChanged
    )
  })

  it('refreshes the registry state after enabling so list() returns fresh data', async () => {
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.EnablePlugin]?.('test-plugin')

    expect(ctx.pluginStateStore.setEnabled).toHaveBeenCalledWith(
      'test-plugin',
      true
    )
    expect(
      (
        ctx.pluginRegistry as unknown as {
          refreshState: ReturnType<typeof vi.fn>
        }
      ).refreshState
    ).toHaveBeenCalledWith('test-plugin')
  })

  it('emits contribution index changes when disabling a plugin', async () => {
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.DisablePlugin]?.('test-plugin')

    expect(ctx.pluginHost.deactivate).toHaveBeenCalledWith('test-plugin')
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.PluginStatusChanged,
      expect.objectContaining({ id: 'test-plugin', enabled: false })
    )
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.ContributionIndexChanged
    )
  })

  it('refreshes the registry state after disabling so list() returns fresh data', async () => {
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.DisablePlugin]?.('test-plugin')

    expect(ctx.pluginStateStore.setEnabled).toHaveBeenCalledWith(
      'test-plugin',
      false
    )
    expect(
      (
        ctx.pluginRegistry as unknown as {
          refreshState: ReturnType<typeof vi.fn>
        }
      ).refreshState
    ).toHaveBeenCalledWith('test-plugin')
  })
})

describe('server plugin lifecycle commands', () => {
  it('stages an install and publishes the consent request', async () => {
    const ctx = makeFakeCtx()
    ;(
      ctx.pluginInstallService.stage as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      stagingId: 's1',
      consent: { manifest: { id: 'test.plugin' } },
      committed: false,
    })
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.InstallPlugin]?.({
        sourceType: 'registry',
        pluginId: 'test.plugin',
      })
    ).resolves.toMatchObject({ stagingId: 's1', committed: false })
    expect(ctx.pluginInstallService.stage).toHaveBeenCalledWith(
      {
        sourceType: 'registry',
        pluginId: 'test.plugin',
      },
      ctx.pluginHost
    )
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.PluginInstallConsentRequested,
      expect.objectContaining({ stagingId: 's1' })
    )
  })

  it('commits consent grants and publishes installation', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.pluginInstaller.commit as ReturnType<typeof vi.fn>).mockResolvedValue(
      { pluginId: 'test.plugin' }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await expect(
      handlers[Commands.ConfirmPluginInstall]?.({
        stagingId: 's1',
        grants: { notify: 'denied' },
      })
    ).resolves.toEqual({ ok: true, pluginId: 'test.plugin' })
    expect(ctx.pluginInstaller.commit).toHaveBeenCalledWith(
      's1',
      { notify: 'denied' },
      ctx.pluginHost
    )
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(Events.PluginInstalled, {
      pluginId: 'test.plugin',
    })
  })

  it('cancels staging, updates grants, and uninstalls through the installer', async () => {
    const ctx = makeFakeCtx()
    ;(
      ctx.pluginGrants.updateGrants as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ notify: 'granted' })
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )

    await handlers[Commands.CancelPluginInstall]?.({ stagingId: 's1' })
    await expect(
      handlers[Commands.UpdatePluginGrants]?.({
        pluginId: 'test.plugin',
        patch: { notify: 'granted' },
      })
    ).resolves.toEqual({ ok: true, grants: { notify: 'granted' } })
    await handlers[Commands.UninstallPlugin]?.({ pluginId: 'test.plugin' })

    expect(ctx.pluginInstaller.cancel).toHaveBeenCalledWith('s1')
    expect(ctx.pluginInstaller.uninstall).toHaveBeenCalledWith(
      'test.plugin',
      ctx.pluginHost
    )
    expect(ctx.settingsManager.removePluginConfig).toHaveBeenCalledWith(
      'test.plugin'
    )
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(Events.PluginUninstalled, {
      pluginId: 'test.plugin',
    })
  })
})

describe('buildServerCommandHandlers — notification center', () => {
  let db: MotrixDatabase
  let notificationCenter: NotificationCenter

  beforeEach(() => {
    db = new MotrixDatabase(':memory:')
    db.init()
    notificationCenter = new NotificationCenter({
      store: db,
      emit: vi.fn(),
      log: { warn: vi.fn(), error: vi.fn() },
    })
  })

  afterEach(() => {
    db.close()
  })

  it('MarkNotificationRead and MarkAllNotificationsRead round-trip against a real center', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const [row] = notificationCenter.list()
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers({
      ...ctx,
      notificationCenter,
    } as unknown as ServerCommandContext)

    await expect(
      handlers[Commands.MarkNotificationRead]?.(row?.id)
    ).resolves.toBe(true)
    expect(notificationCenter.unreadCount()).toBe(0)

    notificationCenter.notify({
      sourceKey: 'src-2',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    await expect(handlers[Commands.MarkAllNotificationsRead]?.()).resolves.toBe(
      1
    )
    expect(notificationCenter.unreadCount()).toBe(0)
  })

  it('DeleteNotification and ClearNotifications round-trip against a real center', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const [row] = notificationCenter.list()
    const ctx = makeFakeCtx()
    const handlers = buildServerCommandHandlers({
      ...ctx,
      notificationCenter,
    } as unknown as ServerCommandContext)

    await expect(
      handlers[Commands.DeleteNotification]?.(row?.id)
    ).resolves.toBe(true)
    expect(notificationCenter.list()).toHaveLength(0)

    notificationCenter.notify({
      sourceKey: 'src-2',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    await expect(handlers[Commands.ClearNotifications]?.()).resolves.toBe(1)
    expect(notificationCenter.list()).toHaveLength(0)
  })
})
