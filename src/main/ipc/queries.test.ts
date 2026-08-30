import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskActivityService, type TaskActivityStore } from '@core/activity'
import { createTaskInspectorActivityQuery } from '@core/inspector-activity'
import { ErrorCode } from '@shared/errors'
import { PROTOCOL_ENVELOPE_VERSION } from '@shared/protocol/errors'
import { Queries } from '@shared/protocol/queries'
import {
  type EngineDiagnosticReport,
  EngineFailureReason,
  EngineRecoveryRecommendation,
  EngineState,
} from '@shared/types/engine'
import { makeTaskInspectorActivitySnapshot } from '@test-utils/task-inspector-activity'
import { ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainProcessWorkCoordinator } from '../main-process-work-coordinator'
import { makeElectronFfmpegDetect } from '../plugin/ffmpeg-detect-electron'
import type { QueryContext } from './queries'
import { buildQueryHandlers, registerQueryHandlers } from './queries'

const ipcMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  defaultResolveProxy: vi.fn(),
  systemProxySession: {
    setProxy: vi.fn(),
    forceReloadProxyConfig: vi.fn(),
    resolveProxy: vi.fn(),
  },
  fromPartition: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMocks.handle,
    removeHandler: ipcMocks.removeHandler,
  },
  session: {
    defaultSession: { resolveProxy: ipcMocks.defaultResolveProxy },
    fromPartition: ipcMocks.fromPartition.mockReturnValue(
      ipcMocks.systemProxySession
    ),
  },
}))

vi.mock('./trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    listener: (...args: unknown[]) => unknown
  ) => ipcMocks.handle(channel, listener),
}))

vi.mock('../plugin/ffmpeg-detect-electron', () => ({
  makeElectronFfmpegDetect: vi.fn(() => async () => ({
    active: null,
    candidates: [],
  })),
}))

const mockedFfmpegFactory = vi.mocked(makeElectronFfmpegDetect)

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

describe('buildQueryHandlers', () => {
  it('reads the OS proxy through an isolated system-mode session', async () => {
    ipcMocks.systemProxySession.setProxy.mockResolvedValue(undefined)
    ipcMocks.systemProxySession.forceReloadProxyConfig.mockResolvedValue(
      undefined
    )
    ipcMocks.systemProxySession.resolveProxy.mockResolvedValue(
      'PROXY 10.0.0.1:8080'
    )
    const handlers = buildQueryHandlers({} as QueryContext)

    await expect(handlers[Queries.GetSystemProxy]?.()).resolves.toEqual({
      protocol: 'http',
      host: '10.0.0.1',
      port: 8080,
    })
    expect(ipcMocks.fromPartition).toHaveBeenCalledWith(
      'motrix-system-proxy-probe',
      { cache: false }
    )
    expect(ipcMocks.systemProxySession.setProxy).toHaveBeenCalledWith({
      mode: 'system',
    })
    expect(
      ipcMocks.systemProxySession.forceReloadProxyConfig
    ).toHaveBeenCalledOnce()
    expect(ipcMocks.systemProxySession.resolveProxy).toHaveBeenCalledWith(
      'https://example.com'
    )
    expect(ipcMocks.defaultResolveProxy).not.toHaveBeenCalled()
  })

  it('delegates CLI status to the shared singleton service', async () => {
    const status = { phase: 'ready', installCommand: 'npm install -g x' }
    const cliToolService = {
      getStatus: vi.fn().mockResolvedValue(status),
    }
    const handlers = buildQueryHandlers({
      cliToolService,
    } as unknown as QueryContext)

    await expect(handlers[Queries.GetCliToolStatus]?.()).resolves.toBe(status)
    expect(cliToolService.getStatus).toHaveBeenCalledOnce()
  })

  it('exposes ListTasks as a handler', async () => {
    const ctx = {
      taskManager: { getAll: vi.fn(() => [{ id: 't1' }]) },
      statsAggregator: { getStats: vi.fn(() => ({ down: 0, up: 0 })) },
      supervisor: {
        getStatus: vi.fn(),
        diagnose: vi.fn(),
        getFeatureReport: vi.fn(),
      },
      settingsManager: { get: vi.fn(() => ({})) },
      natManager: { getStatus: vi.fn() },
      trackerManager: { getCuratedList: vi.fn(() => []) },
    }
    // @ts-expect-error partial ctx
    const handlers = buildQueryHandlers(ctx)
    expect(handlers[Queries.ListTasks]).toBeInstanceOf(Function)
    expect(await handlers[Queries.ListTasks]?.()).toEqual([{ id: 't1' }])
    expect(ctx.taskManager.getAll).toHaveBeenCalled()
  })

  it('waits for startup recovery before reading tasks', async () => {
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const task = { id: 'restored-task' }
    const taskManager = {
      getAll: vi.fn(() => [task]),
      getById: vi.fn(() => task),
    }
    const handlers = buildQueryHandlers({
      taskManager,
      waitForTasksReady: () => ready,
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)

    const list = handlers[Queries.ListTasks]?.()
    const detail = handlers[Queries.GetTaskDetail]?.('restored-task')
    await Promise.resolve()

    expect(taskManager.getAll).not.toHaveBeenCalled()
    expect(taskManager.getById).not.toHaveBeenCalled()

    release()
    await expect(list).resolves.toEqual([task])
    await expect(detail).resolves.toBe(task)
  })

  it('returns a map with all query channels', () => {
    const ctx = {
      taskManager: { getAll: vi.fn(), getById: vi.fn() },
      statsAggregator: { getStats: vi.fn() },
      speedHistoryStore: { snapshot: vi.fn(() => []) },
      transferStats: {
        snapshot: vi.fn(() => TRANSFER_SNAPSHOT),
      },
      taskSpeedHistoryStore: { snapshot: vi.fn(() => []) },
      supervisor: {
        getStatus: vi.fn(),
        diagnose: vi.fn(),
        getFeatureReport: vi.fn(),
      },
      settingsManager: { get: vi.fn(() => ({ tracker: { sources: [] } })) },
      natManager: { getStatus: vi.fn(() => ({ lastDiagnostic: null })) },
      trackerManager: { getCuratedList: vi.fn(() => []) },
    }
    // @ts-expect-error partial ctx
    const handlers = buildQueryHandlers(ctx)
    expect(handlers[Queries.ListTasks]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTaskDetail]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetStats]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetSpeedHistory]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTransferStats]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTaskActivity]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTaskSpeedHistory]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTaskInspectorActivity]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetSettings]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetUpdateState]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetEngineStatus]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetEngineDiagnostics]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetLinuxDefaultAssociations]).toBeInstanceOf(
      Function
    )
    expect(handlers[Queries.GetWindowsDefaultAssociations]).toBeInstanceOf(
      Function
    )
    expect(handlers[Queries.GetTaskFiles]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetNatStatus]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetNatDiagnostic]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTuningRecommendation]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTrackerList]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTrackerSources]).toBeInstanceOf(Function)
    expect(handlers[Queries.GetTaskBtTracker]).toBeInstanceOf(Function)
  })

  it('returns task speed history with the requested limit', async () => {
    const snapshot = vi.fn(() => [{ t: 1, down: 10, up: 2 }])
    const handlers = buildQueryHandlers({
      taskSpeedHistoryStore: { snapshot },
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)

    await expect(
      handlers[Queries.GetTaskSpeedHistory]?.({ taskId: 'task-1', limit: 30 })
    ).resolves.toEqual([{ t: 1, down: 10, up: 2 }])
    expect(snapshot).toHaveBeenCalledWith('task-1', 30)
  })

  it('delegates the complete inspector snapshot by task id', async () => {
    const snapshot = vi.fn(() => makeTaskInspectorActivitySnapshot('task-1', 8))
    const handlers = buildQueryHandlers({
      taskInspectorActivityRuntime: { snapshot },
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)

    await expect(
      handlers[Queries.GetTaskInspectorActivity]?.({ taskId: 'task-1' })
    ).resolves.toEqual(makeTaskInspectorActivitySnapshot('task-1', 8))
    expect(snapshot).toHaveBeenCalledWith({ taskId: 'task-1' })
  })

  it('waits for startup recovery before reading inspector Activity', async () => {
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const snapshot = vi.fn(() => makeTaskInspectorActivitySnapshot('task-1', 8))
    const handlers = buildQueryHandlers({
      taskInspectorActivityRuntime: { snapshot },
      waitForTasksReady: () => ready,
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)

    const result = handlers[Queries.GetTaskInspectorActivity]?.({
      taskId: 'task-1',
    })
    await Promise.resolve()
    expect(snapshot).not.toHaveBeenCalled()

    release()
    await expect(result).resolves.toEqual(
      makeTaskInspectorActivitySnapshot('task-1', 8)
    )
    expect(snapshot).toHaveBeenCalledOnce()
  })

  it('keeps a query waiting on startup inside the shutdown drain', async () => {
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new MainProcessWorkCoordinator()
    const snapshot = vi.fn(() => makeTaskInspectorActivitySnapshot('task-1', 8))
    const dispose = registerQueryHandlers({
      taskInspectorActivityRuntime: { snapshot },
      waitForTasksReady: () => ready,
      trackAsyncWork: <T>(operation: () => Promise<T>) =>
        coordinator.run(operation),
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)
    const registration = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(
        ([channel]) => channel === Queries.GetTaskInspectorActivity
      )

    const result = registration?.[1]({} as never, { taskId: 'task-1' })
    const drain = coordinator.stopAndDrain()
    let drained = false
    void drain.then(() => {
      drained = true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(snapshot).not.toHaveBeenCalled()
    expect(drained).toBe(false)

    release()
    await expect(result).resolves.toMatchObject({ ok: true })
    await drain
    expect(snapshot).toHaveBeenCalledOnce()
    dispose()
  })
})

describe('registerQueryHandlers — inspector error envelope', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
  })

  it('catches before Electron serializes AppError', async () => {
    const dispose = registerQueryHandlers({
      taskInspectorActivityRuntime: createTaskInspectorActivityQuery({
        snapshot: () => null,
      }),
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)
    const registration = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(
        ([channel]) => channel === Queries.GetTaskInspectorActivity
      )
    expect(registration).toBeDefined()
    const handler = registration?.[1]
    const value = await handler?.({} as never, { taskId: 'missing' })
    expect(value).toEqual({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: false,
      error: {
        code: ErrorCode.TaskNotFound,
        message: 'Task not found: missing',
      },
    })

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      Queries.GetTaskInspectorActivity
    )
  })

  it.each([
    { label: 'zero arguments', args: [] },
    {
      label: 'extra arguments',
      args: [{ taskId: 'task-1' }, { poison: true }],
    },
  ])('rejects $label before invoking the Activity reader', async ({ args }) => {
    const snapshot = vi.fn(() => ({ revision: 1 }))
    const dispose = registerQueryHandlers({
      taskInspectorActivityRuntime: { snapshot },
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)
    const registration = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(
        ([channel]) => channel === Queries.GetTaskInspectorActivity
      )
    const handler = registration?.[1]

    const value = await handler?.({} as never, ...args)

    expect(value).toMatchObject({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: false,
      error: { code: ErrorCode.IpcInvalidPayload },
    })
    expect(snapshot).not.toHaveBeenCalled()
    dispose()
  })

  it('maps a poisoned Activity success DTO before Electron serialization', async () => {
    const poisoned = makeTaskInspectorActivitySnapshot('task-1') as ReturnType<
      typeof makeTaskInspectorActivitySnapshot
    > & {
      self?: unknown
    }
    poisoned.self = poisoned
    const dispose = registerQueryHandlers({
      taskInspectorActivityRuntime: { snapshot: () => poisoned },
      settingsManager: { get: vi.fn() },
      userDataDir: '/data',
    } as unknown as QueryContext)
    const registration = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(
        ([channel]) => channel === Queries.GetTaskInspectorActivity
      )

    const value = await registration?.[1]({} as never, { taskId: 'task-1' })

    expect(value).toEqual({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: false,
      error: {
        code: ErrorCode.EngineProtocolError,
        message: 'Request failed',
      },
    })
    dispose()
  })
})

describe('GetTransferStats handler', () => {
  it('delegates the exact day bounds and preserves the runtime snapshot', async () => {
    const transferStats = {
      snapshot: vi.fn(() => TRANSFER_SNAPSHOT),
    }
    const handlers = buildQueryHandlers({
      transferStats,
    } as unknown as QueryContext)

    await expect(
      handlers[Queries.GetTransferStats]?.(TRANSFER_PARAMS)
    ).resolves.toBe(TRANSFER_SNAPSHOT)
    expect(transferStats.snapshot).toHaveBeenCalledOnce()
    expect(transferStats.snapshot).toHaveBeenCalledWith(TRANSFER_PARAMS)
  })

  it('propagates invalid-bound errors to the IPC caller', async () => {
    const error = new RangeError('Transfer range must align to UTC buckets')
    const transferStats = {
      snapshot: vi.fn(() => {
        throw error
      }),
    }
    const handlers = buildQueryHandlers({
      transferStats,
    } as unknown as QueryContext)
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

describe('GetTaskActivity handler', () => {
  it('validates and delegates the local-day boundaries', async () => {
    const taskActivityService = {
      snapshot: vi.fn(() => ACTIVITY_SNAPSHOT),
    }
    const handlers = buildQueryHandlers({
      taskActivityService,
    } as unknown as QueryContext)

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
    const handlers = buildQueryHandlers({
      taskActivityService,
    } as unknown as QueryContext)

    await expect(
      handlers[Queries.GetTaskActivity]?.({
        days: [{ ...ACTIVITY_PARAMS.days[0], dateKey: '2027-1-15' }],
      })
    ).rejects.toThrow()
    expect(store.snapshot).not.toHaveBeenCalled()
  })

  it('propagates service read failures to the IPC caller', async () => {
    const error = new Error('activity read unavailable')
    const taskActivityService = {
      snapshot: vi.fn(() => {
        throw error
      }),
    }
    const handlers = buildQueryHandlers({
      taskActivityService,
    } as unknown as QueryContext)

    await expect(
      handlers[Queries.GetTaskActivity]?.(ACTIVITY_PARAMS)
    ).rejects.toBe(error)
  })
})

describe('GetUpdateState handler', () => {
  it('returns the latest update-manager snapshot', async () => {
    const state = { phase: 'idle', currentVersion: '2.0.0' }
    const updateManager = { getState: vi.fn(() => state) }
    const handlers = buildQueryHandlers({
      updateManager,
    } as unknown as QueryContext)

    await expect(handlers[Queries.GetUpdateState]?.()).resolves.toBe(state)
    expect(updateManager.getState).toHaveBeenCalledOnce()
  })
})

describe('GetPluginCommandGraph handler', () => {
  let pluginsDir: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    pluginsDir = await mkdtemp(path.join(tmpdir(), 'main-command-graph-'))
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
    const handlers = buildQueryHandlers({
      pluginsDir,
    } as unknown as QueryContext)

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
    const handlers = buildQueryHandlers({
      pluginsDir,
    } as unknown as QueryContext)

    await expect(handlers[Queries.GetPluginCommandGraph]?.()).resolves.toEqual({
      edges: [],
      cutoff: NOW - WINDOW_MS,
      generatedAt: NOW,
      truncated: false,
    })
  })
})

describe('GetEngineDiagnostics handler', () => {
  it('returns the diagnostic report produced by the supervisor', async () => {
    const diagnostics = {
      state: EngineState.Failed,
      generatedAt: 1_234,
      failure: {
        reason: EngineFailureReason.PortInUse,
        occurredAt: 1_000,
        technicalMessage: 'address already in use',
      },
      managedPid: null,
      featureReport: null,
      binary: { name: 'aria2c', available: true, version: '1.37.0' },
      rpc: { port: 16800, available: false, expectedListener: false },
      process: null,
      defaultRpc: {
        port: 16800,
        isCurrent: true,
        available: false,
        process: null,
        canRestore: false,
        requiresTermination: false,
      },
      suggestedRpcPort: 16801,
      canRetry: false,
      canForceTerminate: false,
      canSwitchPort: true,
      recommendation: EngineRecoveryRecommendation.SwitchPort,
    } satisfies EngineDiagnosticReport
    const supervisor = {
      diagnose: vi.fn().mockResolvedValue(diagnostics),
    }
    const handlers = buildQueryHandlers({
      supervisor,
    } as unknown as QueryContext)

    await expect(handlers[Queries.GetEngineDiagnostics]?.()).resolves.toBe(
      diagnostics
    )
    expect(supervisor.diagnose).toHaveBeenCalledOnce()
    expect(supervisor.diagnose).toHaveBeenCalledWith()
  })

  it('propagates diagnostic failures to the IPC caller', async () => {
    const error = new Error('diagnostics unavailable')
    const supervisor = {
      diagnose: vi.fn().mockRejectedValue(error),
    }
    const handlers = buildQueryHandlers({
      supervisor,
    } as unknown as QueryContext)

    await expect(handlers[Queries.GetEngineDiagnostics]?.()).rejects.toBe(error)
  })
})

describe('GetTaskBtTracker handler', () => {
  it('delegates to engineAdapter.getTaskBtTracker', async () => {
    const engineAdapter = {
      getTaskBtTracker: vi.fn().mockResolvedValue(['http://a']),
    }
    const handlers = buildQueryHandlers({
      engineAdapter,
    } as unknown as QueryContext)
    const result = await handlers[Queries.GetTaskBtTracker]?.({
      engineGid: 'gid-1',
    })
    expect(engineAdapter.getTaskBtTracker).toHaveBeenCalledWith('gid-1')
    expect(result).toEqual(['http://a'])
  })
})

describe('GetFfmpegDetection handler', () => {
  beforeEach(() => {
    mockedFfmpegFactory.mockClear()
  })

  it('returns the enriched detection result from the factory', async () => {
    const fakeDetection = {
      active: { path: '/u/ffmpeg', version: '6.0.1' },
      candidates: [
        {
          kind: 'manual' as const,
          path: '/u/ffmpeg',
          state: 'active' as const,
          version: '6.0.1',
        },
        {
          kind: 'userData' as const,
          path: '/d/binaries/ffmpeg',
          state: 'missing' as const,
        },
        { kind: 'env' as const, path: null, state: 'unconfigured' as const },
        {
          kind: 'path' as const,
          path: 'ffmpeg',
          state: 'available' as const,
          version: '4.0',
        },
      ],
    }
    mockedFfmpegFactory.mockReturnValueOnce(async () => fakeDetection)

    const settingsManager = {
      get: vi.fn(() => ({ media: { ffmpegBinaryPath: '/u/ffmpeg' } })),
    }
    const ctx = {
      settingsManager,
      userDataDir: '/data',
    } as unknown as QueryContext

    const handlers = buildQueryHandlers(ctx)
    const result = await handlers[Queries.GetFfmpegDetection]?.()
    expect(result).toEqual(fakeDetection)
    expect(mockedFfmpegFactory).toHaveBeenCalledWith({
      settingsManager,
      userDataDir: '/data',
    })
  })

  it('registers GetFfmpegDetection as a handler', () => {
    const handlers = buildQueryHandlers({
      settingsManager: { get: vi.fn() },
      userDataDir: '/d',
    } as unknown as QueryContext)
    expect(handlers[Queries.GetFfmpegDetection]).toBeInstanceOf(Function)
  })
})
