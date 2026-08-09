import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import type { EventBus } from '@core/events/event-bus'
import { NotificationCenter } from '@core/notifications/notification-center'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import type { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import type { PluginStateStore } from '@core/plugin/state/plugin-state-store'
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
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    } as unknown as EngineSupervisor,
    settingsManager: {
      get: vi.fn(),
      update: vi.fn(),
      getApp: vi.fn(() => ({
        defaultSaveDir: '/tmp',
        magnetFileSelection: true,
      })),
    } as unknown as SettingsManager,
    rpcClient: {} as Aria2RpcClient,
    adapter: {} as EngineAdapter,
    trackerManager: {
      applySourcesChange: vi.fn().mockResolvedValue(undefined),
      applyBlacklistChange: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrackerManager,
    aria2BinaryPath: '/usr/bin/aria2c',
    finalNamePicker: {} as FinalNamePicker,
    torrentMetaStore: {} as TorrentMetaStore,
    taskManager: {
      getById: vi.fn(() => undefined),
    } as unknown as TaskManager,
    fileCleanupService: {} as FileCleanupService,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    proxyApplier: {
      apply: vi.fn().mockResolvedValue(undefined),
      applyAll: vi.fn().mockResolvedValue(undefined),
    },
    motrixDatabase: {
      deleteMetadata: vi.fn(),
    } as unknown as MotrixDatabase,
    notificationCenter: {
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
    } as unknown as PluginRegistry,
    pluginStateStore: {
      setEnabled: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as PluginStateStore,
    pluginHost: {
      deactivate: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginHost,
    capabilityHost: {
      secrets: {
        available: vi.fn(() => false),
        encrypt: vi.fn(),
      },
      configFor: vi.fn(() => ({ applyExternalChange: vi.fn() })),
    } as unknown as CapabilityHost,
    userDataDir: '/tmp/userdata',
    pluginsDir: '/tmp/userdata/plugins',
    pluginActivation: {
      dispatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActivationDispatcher,
    magnetTracker: {
      submit: vi.fn().mockResolvedValue(undefined),
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
  }
}

function makeSettings(
  proxy: typeof PROXY_OFF,
  tracker: { sourcesEnabled?: boolean; blacklistEnabled?: boolean } = {}
) {
  return {
    proxy,
    tracker: {
      sourcesEnabled: true,
      blacklistEnabled: true,
      ...tracker,
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

  it('invokes proxyApplier.apply when proxy fields changed', async () => {
    const ctx = makeFakeCtx()
    ;(ctx.settingsManager.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSettings(PROXY_OFF))
      .mockReturnValueOnce(makeSettings(PROXY_ON))
    ;(ctx.settingsManager.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, requiresRestart: false, changedRestartKeys: [] }
    )
    const handlers = buildServerCommandHandlers(
      ctx as Parameters<typeof buildServerCommandHandlers>[0]
    )
    await handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })
    expect(ctx.proxyApplier.apply).toHaveBeenCalledWith(PROXY_OFF, PROXY_ON)
  })

  it('restarts engine via stop+start when requiresRestart is true', async () => {
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
    expect(ctx.supervisor.stop).toHaveBeenCalledOnce()
    expect(ctx.supervisor.start).toHaveBeenCalledWith('/usr/bin/aria2c')
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
