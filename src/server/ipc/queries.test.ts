import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskActivityService, type TaskActivityStore } from '@core/activity'
import { createTaskInspectorActivityQuery } from '@core/inspector-activity'
import { NotificationCenter } from '@core/notifications/notification-center'
import { MotrixDatabase } from '@core/session/motrix-database'
import { ErrorCode } from '@shared/errors'
import { Queries } from '@shared/protocol/queries'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServerQueryHandlers, type ServerQueryContext } from './queries'

vi.mock('../plugin/ffmpeg-detect-server', () => ({
  makeServerFfmpegDetect: vi.fn(() => async () => ({
    active: null,
    candidates: [],
  })),
}))

const NOW = 1_800_000_000_000
const WINDOW_MS = 24 * 60 * 60 * 1000
const TRANSFER_PARAMS = {
  dayStartMs: NOW - WINDOW_MS,
  dayEndMs: NOW,
}
const TRANSFER_SNAPSHOT = {
  today: {
    downloadBytes: '1200',
    uploadBytes: '300',
    totalBytes: '1500',
    startedAt: TRANSFER_PARAMS.dayStartMs,
    endsAt: TRANSFER_PARAMS.dayEndMs,
    coverageStartedAt: TRANSFER_PARAMS.dayStartMs,
  },
  allTime: {
    downloadBytes: '9007199254740993',
    uploadBytes: '7',
    totalBytes: '9007199254741000',
    startedAt: TRANSFER_PARAMS.dayStartMs - WINDOW_MS,
    coverageStartedAt: TRANSFER_PARAMS.dayStartMs - WINDOW_MS,
  },
  updatedAt: NOW - 1_000,
  accuracy: 'estimated' as const,
}
const ACTIVITY_PARAMS = {
  days: [
    {
      dateKey: '2027-01-15',
      fromMs: NOW - WINDOW_MS,
      toMs: NOW,
    },
  ],
}
const ACTIVITY_SNAPSHOT = {
  generation: 'activity-generation',
  revision: 4,
  coverage: {
    trackingStartedAt: NOW - 2 * WINDOW_MS,
    coverageGapAt: null,
  },
  days: [
    {
      dateKey: '2027-01-15',
      submitted: 3,
      downloadCompleted: 2,
      recoveredDownloadCompleted: 1,
    },
  ],
}
const COMMAND_GRAPH_RECORDS = [
  {
    ts: NOW - 2_000,
    type: 'command.invoke',
    caller: 'plugin.source',
    callee: 'plugin.target',
    commandId: 'plugin.target.run',
    argsSize: 2,
    resultSize: 4,
    durMs: 3,
    depth: 1,
    ok: true,
  },
  {
    ts: NOW - 1_000,
    type: 'command.invoke',
    caller: 'plugin.source',
    callee: 'plugin.target',
    commandId: 'plugin.target.run',
    argsSize: 2,
    resultSize: 4,
    durMs: 5,
    depth: 1,
    ok: true,
  },
]

function serializeCommandGraphRecords(): string {
  return `${COMMAND_GRAPH_RECORDS.map((record) => JSON.stringify(record)).join(
    '\n'
  )}\n`
}

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    taskManager: { getAll: vi.fn(() => []), getById: vi.fn() },
    statsAggregator: { getStats: vi.fn() },
    speedHistoryStore: { snapshot: vi.fn(() => []) },
    transferStats: { snapshot: vi.fn(() => TRANSFER_SNAPSHOT) },
    taskActivityService: { snapshot: vi.fn(() => ACTIVITY_SNAPSHOT) },
    taskSpeedHistoryStore: { snapshot: vi.fn(() => []) },
    taskInspectorActivityRuntime: { snapshot: vi.fn() },
    supervisor: { getState: vi.fn(), getFeatureReport: vi.fn() },
    settingsManager: {
      get: vi.fn(() => ({ tracker: { sources: [] } })),
      getApp: vi.fn(() => ({ defaultSaveDir: '' })),
    },
    trackerManager: { getCuratedList: vi.fn(() => []) },
    engineAdapter: { getTaskBtTracker: vi.fn(), getTaskPeers: vi.fn() },
    geoipManager: {
      getStatus: vi.fn(() => ({
        enabled: false,
        hasDatabase: false,
        loaded: false,
        lastUpdatedAt: 0,
        databaseVersion: '',
        sizeBytes: 0,
        isDownloading: false,
        lastError: null,
      })),
      isEnabled: vi.fn(() => false),
      lookupCountry: vi.fn(() => null),
    },
    notificationCenter: {
      list: vi.fn(() => []),
      unreadCount: vi.fn(() => 0),
    },
    pluginRegistry: { list: vi.fn(() => []), entries: vi.fn(() => []) },
    capabilityHost: { getTail: vi.fn(() => []) },
    pluginGrants: {
      getGrants: vi.fn(async () => ({})),
      listAllGrants: vi.fn(async () => ({})),
    },
    pluginsDir: '',
    hostVersion: '2.0',
    motrixDatabase: { getMetadata: vi.fn() },
    userDataDir: '',
    speedLimitController: { getState: vi.fn() },
    downloadPathPolicy: {
      allowedSaveDirs: [],
      prepareSaveDir: vi.fn(),
    },
    environment: {},
    ...over,
  }
}

describe('buildServerQueryHandlers — allowed save directories', () => {
  it('reports the proxy inherited by the Server process', async () => {
    const handlers = buildServerQueryHandlers(
      makeCtx({
        environment: {
          HTTPS_PROXY: 'http://proxy.internal:3128',
          NO_PROXY: 'localhost,.lan',
        },
      }) as never
    )

    await expect(handlers[Queries.GetSystemProxy]?.()).resolves.toEqual({
      protocol: 'http',
      host: 'proxy.internal',
      port: 3128,
      bypass: ['localhost', '.lan'],
    })
  })

  it('reports Linux associations as unsupported on the web server', async () => {
    const handlers = buildServerQueryHandlers(makeCtx() as never)

    await expect(
      handlers[Queries.GetLinuxDefaultAssociations]?.()
    ).resolves.toEqual({
      supported: false,
      packageKind: null,
      registered: false,
      canSetTorrentDefault: false,
      torrent: null,
      magnet: null,
    })
  })

  it('reports Windows associations as unsupported on the web server', async () => {
    const handlers = buildServerQueryHandlers(makeCtx() as never)

    await expect(
      handlers[Queries.GetWindowsDefaultAssociations]?.()
    ).resolves.toEqual({
      supported: false,
      registered: false,
      scope: null,
      torrent: false,
      magnet: false,
    })
  })

  it('publishes the validated path policy instead of reparsing the environment', async () => {
    const handlers = buildServerQueryHandlers(
      makeCtx({
        settingsManager: {
          get: vi.fn(() => ({ tracker: { sources: [] } })),
          getApp: vi.fn(() => ({ defaultSaveDir: '/downloads' })),
        },
        downloadPathPolicy: {
          allowedSaveDirs: ['/downloads', '/media'],
          prepareSaveDir: vi.fn(),
        },
      }) as never
    )

    await expect(handlers[Queries.ListAllowedSaveDirs]?.()).resolves.toEqual({
      paths: [{ path: '/downloads' }, { path: '/media' }],
      defaultPath: '/downloads',
      allowCustom: false,
    })
  })
})

describe('buildServerQueryHandlers — GetTransferStats parity', () => {
  it('exposes CLI installation as an unsupported web query', async () => {
    const handlers = buildServerQueryHandlers(makeCtx() as never)

    await expect(handlers[Queries.GetCliToolStatus]?.()).resolves.toEqual({
      phase: 'manual-only',
      capability: 'manual-only',
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: 'unknown',
      managerOptions: [
        {
          manager: 'npm',
          installCommand: 'npm install -g @motrix/cli@latest',
          available: false,
        },
        {
          manager: 'pnpm',
          installCommand: 'pnpm add -g @motrix/cli@latest',
          available: false,
        },
        {
          manager: 'yarn',
          installCommand: 'yarn global add @motrix/cli@latest',
          available: false,
        },
        {
          manager: 'bun',
          installCommand: 'bun add -g @motrix/cli@latest',
          available: false,
        },
        {
          manager: 'volta',
          installCommand: 'volta install @motrix/cli@latest',
          available: false,
        },
      ],
      version: null,
      executablePath: null,
      nodeVersion: null,
      reason: 'unsupported-web',
      detail: null,
    })
  })

  it('delegates the exact day bounds and preserves the runtime snapshot', async () => {
    const transferStats = {
      snapshot: vi.fn(() => TRANSFER_SNAPSHOT),
    }
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(makeCtx({ transferStats }))

    await expect(
      handlers[Queries.GetTransferStats]?.(TRANSFER_PARAMS)
    ).resolves.toBe(TRANSFER_SNAPSHOT)
    expect(transferStats.snapshot).toHaveBeenCalledOnce()
    expect(transferStats.snapshot).toHaveBeenCalledWith(TRANSFER_PARAMS)
  })

  it('propagates invalid-bound errors to the HTTP caller', async () => {
    const error = new RangeError('Transfer range must align to UTC buckets')
    const transferStats = {
      snapshot: vi.fn(() => {
        throw error
      }),
    }
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(makeCtx({ transferStats }))
    const invalidParams = {
      dayStartMs: TRANSFER_PARAMS.dayStartMs + 1,
      dayEndMs: TRANSFER_PARAMS.dayEndMs + 1,
    }

    await expect(
      handlers[Queries.GetTransferStats]?.(invalidParams)
    ).rejects.toBe(error)
    expect(transferStats.snapshot).toHaveBeenCalledWith(invalidParams)
  })
})

describe('buildServerQueryHandlers — GetTaskActivity parity', () => {
  it('validates and delegates the local-day boundaries', async () => {
    const taskActivityService = {
      snapshot: vi.fn(() => ACTIVITY_SNAPSHOT),
    }
    const handlers = buildServerQueryHandlers(
      makeCtx({ taskActivityService }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskActivity]?.(ACTIVITY_PARAMS)
    ).resolves.toBe(ACTIVITY_SNAPSHOT)
    expect(taskActivityService.snapshot).toHaveBeenCalledOnce()
    expect(taskActivityService.snapshot).toHaveBeenCalledWith(ACTIVITY_PARAMS)
  })

  it('rejects malformed input before reaching the store', async () => {
    // Validation ownership lives in TaskActivityService (shared by both
    // shells); the handler passes params through, so exercise the real
    // service against a stubbed store.
    const store = { snapshot: vi.fn() }
    const taskActivityService = new TaskActivityService(
      store as unknown as TaskActivityStore,
      { emit: vi.fn() }
    )
    const handlers = buildServerQueryHandlers(
      makeCtx({ taskActivityService }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskActivity]?.({
        days: [{ ...ACTIVITY_PARAMS.days[0], dateKey: '2027-1-15' }],
      })
    ).rejects.toThrow()
    expect(store.snapshot).not.toHaveBeenCalled()
  })

  it('propagates service read failures to the HTTP caller', async () => {
    const error = new Error('activity read unavailable')
    const taskActivityService = {
      snapshot: vi.fn(() => {
        throw error
      }),
    }
    const handlers = buildServerQueryHandlers(
      makeCtx({ taskActivityService }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskActivity]?.(ACTIVITY_PARAMS)
    ).rejects.toBe(error)
  })
})

describe('buildServerQueryHandlers — GetTaskDetail parity', () => {
  it('exposes GetTaskDetail (mirrors the Electron shell)', () => {
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(makeCtx())
    expect(handlers[Queries.GetTaskDetail]).toBeInstanceOf(Function)
  })

  it('returns the task by id', async () => {
    const task = { id: 't1' }
    const ctx = makeCtx({
      taskManager: {
        getAll: vi.fn(() => [task]),
        getById: vi.fn((id: string) => (id === 't1' ? task : undefined)),
      },
    })
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(ctx)
    expect(await handlers[Queries.GetTaskDetail]?.('t1')).toBe(task)
  })

  it('returns null for an absent task (never undefined)', async () => {
    const ctx = makeCtx({
      taskManager: { getAll: vi.fn(() => []), getById: vi.fn(() => undefined) },
    })
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(ctx)
    expect(await handlers[Queries.GetTaskDetail]?.('missing')).toBeNull()
  })
})

describe('buildServerQueryHandlers — GetTaskPieces parity', () => {
  it('uses the shared piece query handler in web mode', async () => {
    const task = makeDownloadTask({ id: 'task-http', engineTaskId: 'gid-http' })
    const getTaskPieces = vi.fn().mockResolvedValue({
      pieceLength: 1_048_576,
      numPieces: 8,
      bitfield: 'c0',
    })
    const handlers = buildServerQueryHandlers(
      makeCtx({
        taskManager: {
          getAll: vi.fn(() => [task]),
          getById: vi.fn(() => task),
        },
        engineAdapter: {
          getTaskBtTracker: vi.fn(),
          getTaskPieces,
        },
      }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskPieces]?.({ taskId: 'task-http' })
    ).resolves.toEqual({
      pieceLength: 1_048_576,
      numPieces: 8,
      bitfield: 'c0',
    })
    expect(getTaskPieces).toHaveBeenCalledWith('gid-http')
  })
})

describe('buildServerQueryHandlers — GeoIP parity', () => {
  it('exposes the manager status through the web transport', async () => {
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
    const getStatus = vi.fn(() => status)
    const handlers = buildServerQueryHandlers(
      makeCtx({
        geoipManager: {
          getStatus,
          isEnabled: vi.fn(() => true),
          lookupCountry: vi.fn(() => null),
        },
      }) as unknown as ServerQueryContext
    )

    await expect(handlers[Queries.GetGeoIPStatus]?.()).resolves.toBe(status)
    expect(getStatus).toHaveBeenCalledOnce()
  })

  it('enriches task peers with countries in web mode', async () => {
    const task = makeDownloadTask({ id: 'task-bt', engineTaskId: 'gid-bt' })
    const getTaskPeers = vi.fn().mockResolvedValue([
      {
        id: '1.2.3.4:6881',
        ip: '1.2.3.4',
        port: 6881,
        client: null,
        clientVersion: null,
        progress: 0.5,
        downSpeed: 1024,
        upSpeed: 0,
        seeder: false,
        amChoking: false,
        peerChoking: true,
      },
    ])
    const lookupCountry = vi.fn(() => ({
      code: 'US',
      name: 'United States',
    }))
    const handlers = buildServerQueryHandlers(
      makeCtx({
        taskManager: {
          getAll: vi.fn(() => [task]),
          getById: vi.fn(() => task),
        },
        engineAdapter: {
          getTaskBtTracker: vi.fn(),
          getTaskPeers,
        },
        geoipManager: {
          getStatus: vi.fn(),
          isEnabled: vi.fn(() => true),
          lookupCountry,
        },
      }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskPeers]?.({ taskId: 'task-bt' })
    ).resolves.toEqual([
      expect.objectContaining({
        ip: '1.2.3.4',
        country: { code: 'US', name: 'United States' },
      }),
    ])
    expect(getTaskPeers).toHaveBeenCalledWith('gid-bt')
    expect(lookupCountry).toHaveBeenCalledWith('1.2.3.4')
  })
})

describe('buildServerQueryHandlers — notification center', () => {
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

  it('ListNotifications and GetUnreadNotificationCount round-trip against a real center', async () => {
    notificationCenter.notify({
      sourceKey: 'src-1',
      kind: 'task-error',
      severity: 'error',
      titleKey: 'notification.title',
    })
    const handlers = buildServerQueryHandlers(
      makeCtx({ notificationCenter }) as unknown as ServerQueryContext
    )

    await expect(handlers[Queries.ListNotifications]?.()).resolves.toHaveLength(
      1
    )
    await expect(
      handlers[Queries.GetUnreadNotificationCount]?.()
    ).resolves.toBe(1)
  })
})

describe('buildServerQueryHandlers — plugin grants', () => {
  it('exposes persisted grants through both query shapes', async () => {
    const pluginGrants = {
      getGrants: vi.fn(async () => ({ notify: 'granted' })),
      listAllGrants: vi.fn(async () => ({
        'test.plugin': { notify: 'granted' },
      })),
    }
    const handlers = buildServerQueryHandlers(
      makeCtx({ pluginGrants }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetPluginGrants]?.('test.plugin')
    ).resolves.toEqual({ notify: 'granted' })
    await expect(handlers[Queries.ListPluginGrants]?.()).resolves.toEqual({
      'test.plugin': { notify: 'granted' },
    })
  })
})

describe('GetPluginCommandGraph handler', () => {
  let pluginsDir: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    pluginsDir = await mkdtemp(path.join(tmpdir(), 'server-command-graph-'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(pluginsDir, { recursive: true, force: true })
  })

  it('returns the normalized command graph DTO', async () => {
    const auditDir = path.join(pluginsDir, '_audit')
    await mkdir(auditDir)
    await writeFile(
      path.join(auditDir, 'command-invokes.ndjson'),
      serializeCommandGraphRecords()
    )
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(makeCtx({ pluginsDir }))

    await expect(handlers[Queries.GetPluginCommandGraph]?.()).resolves.toEqual({
      edges: [
        {
          sourcePluginId: 'plugin.source',
          targetPluginId: 'plugin.target',
          commandId: 'plugin.target.run',
          calls: 2,
          lastCalledAt: NOW - 1_000,
        },
      ],
      cutoff: NOW - WINDOW_MS,
      generatedAt: NOW,
      truncated: false,
    })
  })

  it('returns an empty complete graph when the audit directory is missing', async () => {
    // @ts-expect-error partial ctx for test
    const handlers = buildServerQueryHandlers(makeCtx({ pluginsDir }))

    await expect(handlers[Queries.GetPluginCommandGraph]?.()).resolves.toEqual({
      edges: [],
      cutoff: NOW - WINDOW_MS,
      generatedAt: NOW,
      truncated: false,
    })
  })
})

describe('buildServerQueryHandlers — GetTaskSpeedHistory parity', () => {
  it('returns task speed history with the requested limit', async () => {
    const snapshot = vi.fn(() => [{ t: 1, down: 10, up: 2 }])
    const handlers = buildServerQueryHandlers(
      // @ts-expect-error partial ctx for test
      makeCtx({ taskSpeedHistoryStore: { snapshot } })
    )

    await expect(
      handlers[Queries.GetTaskSpeedHistory]?.({ taskId: 'task-1', limit: 30 })
    ).resolves.toEqual([{ t: 1, down: 10, up: 2 }])
    expect(snapshot).toHaveBeenCalledWith('task-1', 30)
  })
})

describe('buildServerQueryHandlers — GetTaskInspectorActivity parity', () => {
  it('delegates the same complete snapshot by public task id', async () => {
    const snapshot = vi.fn(() => ({ taskId: 'task-1', revision: 8 }))
    const handlers = buildServerQueryHandlers(
      makeCtx({
        taskInspectorActivityRuntime: { snapshot },
      }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskInspectorActivity]?.({ taskId: 'task-1' })
    ).resolves.toEqual({ taskId: 'task-1', revision: 8 })
    expect(snapshot).toHaveBeenCalledWith({ taskId: 'task-1' })
  })

  it('surfaces the shared TaskNotFound AppError from the real facade', async () => {
    const handlers = buildServerQueryHandlers(
      makeCtx({
        taskInspectorActivityRuntime: createTaskInspectorActivityQuery({
          snapshot: () => null,
        }),
      }) as unknown as ServerQueryContext
    )

    await expect(
      handlers[Queries.GetTaskInspectorActivity]?.({ taskId: 'missing' })
    ).rejects.toMatchObject({
      code: ErrorCode.TaskNotFound,
      message: 'Task not found: missing',
    })
  })
})
