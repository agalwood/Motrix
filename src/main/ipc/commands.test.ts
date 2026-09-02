import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { Aria2Adapter } from '@core/engine/aria2/aria2-adapter'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type { AppImageIntegrationView } from '@shared/types/appimage-integration'
import { CliPackageManager } from '@shared/types/cli-tool'
import { TaskInstancePhase, TaskStatus, TaskType } from '@shared/types/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainProcessWorkCoordinator } from '../main-process-work-coordinator'
import { WINDOWS_DEFAULT_APPS_SETTINGS_URL } from '../platform/windows-default-apps'
import type { CommandContext } from './commands'
import { buildCommandHandlers, registerCommandHandlers } from './commands'

const { resolveWindowsDefaultAppsSettingsUrlMock } = vi.hoisted(() => ({
  resolveWindowsDefaultAppsSettingsUrlMock: vi.fn(
    async () => 'ms-settings:defaultapps'
  ),
}))
const { reconcileAppImageIntegrationFromSettingsMock } = vi.hoisted(() => ({
  reconcileAppImageIntegrationFromSettingsMock: vi.fn(
    async (_options: {
      getMagnetEnabled: () => boolean
    }): Promise<AppImageIntegrationView> => ({ supported: false })
  ),
}))

vi.mock('../platform/appimage-integration-host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reconcileAppImageIntegrationFromSettings:
    reconcileAppImageIntegrationFromSettingsMock,
}))

vi.mock('../platform/windows-default-apps', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWindowsDefaultAppsSettingsUrl:
    resolveWindowsDefaultAppsSettingsUrlMock,
}))

// Mock electron so BrowserWindow.fromWebContents can be stubbed in the
// Window-bound command tests. ipcMain/dialog are not invoked by buildCommandHandlers,
// but we stub them for safety.
const fromWebContentsMock = vi.fn()
const ipcHandleMock = vi.fn()
const ipcRemoveHandlerMock = vi.fn()
const openExternalMock = vi.fn()
const showOpenDialogMock = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (...args: unknown[]) => fromWebContentsMock(...args),
  },
  ipcMain: {
    handle: (...args: unknown[]) => ipcHandleMock(...args),
    removeHandler: (...args: unknown[]) => ipcRemoveHandlerMock(...args),
  },
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args),
  },
  shell: {
    openExternal: (...args: unknown[]) => openExternalMock(...args),
    showItemInFolder: vi.fn(),
  },
}))

// Sender trust is covered by trusted-ipc.test.ts. Keep these handler tests
// focused on command dispatch while preserving the same registration seam.
vi.mock('./trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    listener: (...args: unknown[]) => unknown
  ) => ipcHandleMock(channel, listener),
}))

function fakeCtx() {
  // Build the rpc spies first, then wrap them in a real Aria2Adapter so the
  // create path (handleCreateTask → adapter.createDownload/addTorrent)
  // produces the same aria2 wire the tests assert on via ctx.rpcClient.
  const rpcClient = {
    addTorrent: vi.fn(
      async (
        _metadata: string,
        _uris: string[],
        options?: Record<string, string>
      ) => options?.gid ?? 'gid1'
    ),
    addUri: vi.fn(
      async (_uris: string[], options?: Record<string, string>) =>
        options?.gid ?? 'gid2'
    ),
    remove: vi.fn(async () => {}),
    forceRemove: vi.fn(async () => {}),
    removeDownloadResult: vi.fn(async () => {}),
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  }
  // The mock rpc covers the subset Aria2Adapter touches in these handler
  // tests (addUri/addTorrent/remove + the three on* subscriptions).
  const adapter = new Aria2Adapter(rpcClient as never)
  const base = {
    cliToolService: {
      install: vi.fn().mockResolvedValue({ phase: 'installed' }),
    },
    supervisor: {
      restart: vi.fn(),
      applyEngineSettings: vi.fn().mockResolvedValue(undefined),
      applyAsyncDns: vi.fn().mockResolvedValue(undefined),
      applyDefaultSaveDir: vi.fn().mockResolvedValue(undefined),
      recover: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      // createDeps wires waitForEngineReady -> supervisor.waitUntilReady
      // (engine-ready gate); the handler tests must stub it or task
      // creation throws "supervisor.waitUntilReady is not a function".
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      assertReady: vi.fn(),
    },
    sessionManager: {
      save: vi.fn().mockResolvedValue(undefined),
      requestSave: vi.fn().mockResolvedValue(undefined),
      runExclusivePersistence: vi.fn(
        async (operation: () => unknown | Promise<unknown>) => operation()
      ),
    },
    settingsManager: {
      getApp: () => ({ defaultSaveDir: '/tmp', magnetFileSelection: true }),
      getEngine: () => ({ maxConnectionPerServer: 5 }),
      removePluginConfig: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    },
    protocolManager: {
      resetDialogState: vi.fn(),
      register: vi.fn(),
      nextTorrent: vi.fn(),
      downloadAllTorrents: vi.fn(() => []),
    },
    windowManager: {
      open: vi.fn(),
      get: vi.fn(() => null),
      close: vi.fn(),
      show: vi.fn(),
      closeAndRecycle: vi.fn(),
      getWindowIdBySender: vi.fn((): string | null => null),
    },
    natManager: {
      start: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      forceRemap: vi.fn(),
      runDiagnostic: vi.fn(),
      exportBundle: vi.fn().mockResolvedValue({ mappings: [] }),
    },
    torrentParser: { parse: vi.fn(async () => ({ name: 't' })) },
    rpcClient,
    adapter,
    taskManager: {
      getById: vi.fn(),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      set: vi.fn(),
      add: vi.fn(),
      reserveEngineTaskId: vi.fn(),
      setReservedEngineTaskOwner: vi.fn(),
      releaseEngineTaskIdReservation: vi.fn(() => true),
      retireEngineTaskIdReservation: vi.fn(() => true),
    },
    updateManager: {
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
      setChannel: vi.fn(),
    },
    trackerManager: {
      applySourcesChange: vi.fn().mockResolvedValue(undefined),
      applyBlacklistChange: vi.fn().mockResolvedValue(undefined),
      applySyncScheduleChange: vi.fn(),
      syncAndCurate: vi.fn().mockResolvedValue({
        totalFetched: 2,
        totalHealthy: 1,
        totalCurated: 1,
      }),
    },
    contextStore: { merge: vi.fn() },
    finalNamePicker: {
      pick: vi.fn(async (_dir: string, name: string) => name),
    },
    torrentMetaStore: {
      persist: vi.fn(async () => '/tmp/x.torrent'),
      read: vi.fn(),
      remove: vi.fn(async () => {}),
    },
    fileCleanupService: {
      cleanup: vi.fn(async () => {}),
    },
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeAll: vi.fn(),
    },
    notificationCenter: {
      notify: vi.fn(() => ({ fresh: true })),
    },
    proxyApplier: {
      apply: vi.fn().mockResolvedValue({ downloadProxy: 'unchanged' }),
      applyAll: vi.fn().mockResolvedValue({ downloadProxy: 'unchanged' }),
    },
    appliedDownloadProxyPolicy: new AppliedDownloadProxyPolicy({ noProxy: '' }),
    motrixDatabase: {
      database: undefined,
      deleteTask: vi.fn(),
      getTask: vi.fn(),
      saveTaskWithInstances: vi.fn(),
    },
    pluginHost: {
      allActive: vi.fn(() => []),
      deactivate: vi.fn().mockResolvedValue(undefined),
      isQuiescent: vi.fn(() => true),
    },
    pluginInstaller: {
      stage: vi.fn(),
      commit: vi.fn().mockResolvedValue({ pluginId: 'test.plugin' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
    },
    userDataDir: '/tmp/userdata',
    pluginsDir: '/tmp/userdata/plugins',
    pluginActivation: {
      dispatch: vi.fn().mockResolvedValue(undefined),
    },
    bridgeManager: {
      current: null,
      setEnabled: vi.fn(),
      restart: vi.fn(),
    },
    magnetTracker: {
      submit: vi.fn().mockResolvedValue(undefined),
      retryMetadata: vi.fn().mockResolvedValue(undefined),
    },
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    persistTask: vi.fn().mockResolvedValue(undefined),
    recordTransition: vi.fn().mockResolvedValue(undefined),
    deleteParentTasks: vi.fn(
      async (_taskIds: string[], deleteParents: () => Promise<void>) => {
        await deleteParents()
      }
    ),
    runTaskMutation: vi.fn(
      async (_taskIds: readonly string[], operation: () => Promise<unknown>) =>
        operation()
    ),
    parentTaskCreated: vi.fn(
      async (_task: unknown, persistParent: () => Promise<void>) => {
        await persistParent()
      }
    ),
  }
  return { ...base, ...directTaskUpdatePublication(base) }
}

describe('buildCommandHandlers', () => {
  it('delegates CLI installation to the shared singleton service', async () => {
    const ctx = fakeCtx()
    const status = { phase: 'installed', version: '0.4.0' }
    ctx.cliToolService.install.mockResolvedValueOnce(status)
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    const request = { packageManager: CliPackageManager.Pnpm }
    await expect(handlers[Commands.InstallCliTool]?.(request)).resolves.toBe(
      status
    )
    expect(ctx.cliToolService.install).toHaveBeenCalledWith(request)
  })

  it.each([
    undefined,
    { packageManager: 'forged' },
    { packageManager: CliPackageManager.Npm, command: 'evil' },
  ])(
    'rejects an invalid CLI install payload before delegation',
    async (payload) => {
      const ctx = fakeCtx()
      const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

      await expect(
        handlers[Commands.InstallCliTool]?.(payload)
      ).rejects.toThrow()
      expect(ctx.cliToolService.install).not.toHaveBeenCalled()
    }
  )

  it('passes PluginHost through commit and uninstall lifecycle commands', async () => {
    const ctx = fakeCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    await expect(
      handlers[Commands.ConfirmPluginInstall]?.({
        stagingId: 's1',
        grants: { notify: 'denied' },
      })
    ).resolves.toEqual({ ok: true, pluginId: 'test.plugin' })
    await expect(
      handlers[Commands.UninstallPlugin]?.({ pluginId: 'test.plugin' })
    ).resolves.toEqual({ ok: true })

    expect(ctx.pluginInstaller.commit).toHaveBeenCalledWith(
      's1',
      { notify: 'denied' },
      ctx.pluginHost
    )
    expect(ctx.pluginInstaller.uninstall).toHaveBeenCalledWith(
      'test.plugin',
      ctx.pluginHost
    )
  })

  it('returns a map keyed by Commands channels', () => {
    // @ts-expect-error — fake ctx is partial; handler map keys are what we care about
    const handlers = buildCommandHandlers(fakeCtx())
    expect(handlers[Commands.ParseTorrent]).toBeInstanceOf(Function)
    expect(handlers[Commands.AddTorrentTask]).toBeInstanceOf(Function)
    expect(handlers[Commands.AddMagnetTask]).toBeInstanceOf(Function)
  })

  it('routes RetryTasks for unresolved magnet metadata to MagnetTracker', async () => {
    const ctx = fakeCtx()
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
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    await expect(
      handlers[Commands.RetryTasks]?.(['magnet-timeout'])
    ).resolves.toEqual({ succeeded: ['magnet-timeout'], failed: [] })

    expect(ctx.magnetTracker.retryMetadata).toHaveBeenCalledWith(
      'magnet-timeout'
    )
  })

  it('admits RemoveTask through the mutation lock and Session persistence queue', async () => {
    const ctx = fakeCtx()
    vi.mocked(ctx.taskManager.getById).mockReturnValue({
      id: 'remove-me',
      engineTaskId: 'gid-remove',
      diskPath: '/downloads/remove-me',
      type: TaskType.Http,
      status: TaskStatus.Completed,
      torrentMetaPath: null,
      instances: [],
    } as never)
    ctx.adapter.removeDownloadResult = vi.fn().mockResolvedValue(undefined)
    ctx.motrixDatabase.deleteTask = vi.fn()
    ctx.motrixDatabase.getTask = vi.fn().mockReturnValue(null)
    ctx.motrixDatabase.saveTaskWithInstances = vi.fn()
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)

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
    expect(ctx.sessionManager.runExclusivePersistence).toHaveBeenCalledOnce()
  })

  it('PauseTasks fans out per id and returns the IPC-safe bulk result', async () => {
    const ctx = fakeCtx()
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
    ctx.adapter.pauseTask = vi.fn(async (gid: string) => {
      if (gid === 'gid-2') throw new Error('engine rejected')
    }) as never
    ctx.adapter.getTaskStatus = vi.fn().mockResolvedValue(null)
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.PauseTasks]?.(['t-1', 't-2'])
    ).resolves.toEqual({
      succeeded: ['t-1'],
      failed: [{ taskId: 't-2', reason: 'engine rejected' }],
    })
  })

  it('PauseTasks rejects an empty or malformed payload', async () => {
    const ctx = fakeCtx()
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(handlers[Commands.PauseTasks]?.([])).rejects.toThrow()
    await expect(handlers[Commands.PauseTasks]?.('t-1')).rejects.toThrow()
  })

  it('RemoveTasks threads deleteWithFiles and returns the bulk result', async () => {
    const ctx = fakeCtx()
    vi.mocked(ctx.taskManager.getById).mockImplementation(
      (id: string) =>
        ({
          id,
          engineTaskId: `gid-${id}`,
          diskPath: '/d/foo.mp4',
          type: TaskType.Http,
          status: TaskStatus.Completed,
          torrentMetaPath: null,
          instances: [],
        }) as never
    )
    ctx.adapter.removeDownloadResult = vi.fn().mockResolvedValue(undefined)
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.RemoveTasks]?.({
        taskIds: ['r-1', 'r-2'],
        deleteWithFiles: false,
      })
    ).resolves.toEqual({ succeeded: ['r-1', 'r-2'], failed: [] })
    expect(ctx.taskManager.remove).toHaveBeenCalledWith('r-1')
    expect(ctx.taskManager.remove).toHaveBeenCalledWith('r-2')
  })

  it('StopSeedingTask awaits candidate persistence before emitting success state', async () => {
    const ctx = fakeCtx()
    vi.mocked(ctx.taskManager.getById).mockReturnValue({
      id: 'm-seeding',
      engineTaskId: 'g-seeding',
      status: TaskStatus.Seeding,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      instances: [],
    } as never)
    ctx.adapter.forceRemoveTask = vi.fn().mockResolvedValue(undefined)
    ctx.adapter.getTaskStatus = vi.fn().mockResolvedValue(null)
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.StopSeedingTask]?.('m-seeding')
    ).resolves.toEqual({ ok: true })

    expect(ctx.persistTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm-seeding',
        status: TaskStatus.Completed,
      })
    )
    expect(vi.mocked(ctx.persistTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.eventBus.emit).mock.invocationCallOrder[0]
    )
  })

  it('AddMagnetTask uses fallback save dir when none provided', async () => {
    const ctx = fakeCtx()
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)
    const result = (await handlers[Commands.AddMagnetTask]?.({
      uri: 'magnet:?xt=x',
      selectedFiles: [0],
      saveDir: '',
    })) as { gid: string; taskId?: string } | undefined
    // createAndPersist now propagates handleCreateTask's full result
    // ({ gid, taskId }) — use a subset match so the test stays focused on
    // the gid being routed correctly through the IPC handler.
    expect(result).toMatchObject({
      gid: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    // createTaskHandler writes BT tasks to <saveDir>/<finalName>.motrix as
    // the container dir (incomplete-suffix). Assert the dir is rooted at
    // the fallback /tmp path.
    expect(ctx.rpcClient.addUri).toHaveBeenCalledWith(
      ['magnet:?xt=x'],
      expect.objectContaining({
        dir: expect.stringMatching(/^\/tmp\/.+\.motrix$/) as unknown as string,
        gid: result?.gid,
      })
    )
  })

  it('rolls back the durable Activity parent when engine creation rejects', async () => {
    const ctx = fakeCtx()
    const engineFailure = new Error('engine transport rejected create')
    ctx.rpcClient.addUri.mockRejectedValueOnce(engineFailure)
    // @ts-expect-error — partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.CreateTask]?.({
        type: 'http',
        uris: ['https://example.com/file.bin'],
        saveDir: '/downloads',
        headers: [],
      })
    ).rejects.toBe(engineFailure)

    expect(ctx.sessionManager.runExclusivePersistence).toHaveBeenCalled()
    expect(ctx.deleteParentTasks).toHaveBeenCalledWith(
      [expect.any(String)],
      expect.any(Function)
    )
    expect(ctx.motrixDatabase.deleteTask).toHaveBeenCalledOnce()
  })

  it('CreateTask submits bare magnet to metadata selection when enabled', async () => {
    const ctx = fakeCtx()
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)

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
    expect(ctx.rpcClient.addUri).not.toHaveBeenCalled()
  })

  it('admits a magnet selection swap through the canonical task lock', async () => {
    const ctx = fakeCtx()
    ctx.motrixDatabase = {
      ...ctx.motrixDatabase,
      getTask: vi.fn(() => null),
    } as never
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)

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

  it('CloseCurrentWindow receives sender as first arg and resolves window id', async () => {
    const ctx = fakeCtx()
    const getWindowIdBySender = vi.fn(() => 'win-1')
    const closeAndRecycle = vi.fn()
    const show = vi.fn()
    ctx.windowManager = {
      ...ctx.windowManager,
      getWindowIdBySender,
      closeAndRecycle,
      show,
    } as any
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const fakeSender = {} as never
    const result = await handlers[Commands.CloseCurrentWindow]?.(fakeSender, {
      showMain: true,
    })
    expect(getWindowIdBySender).toHaveBeenCalledWith(fakeSender)
    expect(closeAndRecycle).toHaveBeenCalledWith('win-1')
    expect(show).toHaveBeenCalledWith('main')
    expect(result).toEqual({ ok: true })
  })

  it('CloseCurrentWindow resets protocol dialog state for add-task', async () => {
    const ctx = fakeCtx()
    const getWindowIdBySender = vi.fn(() => 'add-task')
    const closeAndRecycle = vi.fn()
    ctx.windowManager = {
      ...ctx.windowManager,
      getWindowIdBySender,
      closeAndRecycle,
    } as any
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const fakeSender = {} as never
    await handlers[Commands.CloseCurrentWindow]?.(fakeSender)

    expect(ctx.protocolManager.resetDialogState).toHaveBeenCalled()
    expect(closeAndRecycle).toHaveBeenCalledWith('add-task')
  })

  it('CloseCurrentWindow emits NavigateTo when navigateMainTo is set', async () => {
    const ctx = fakeCtx()
    const getWindowIdBySender = vi.fn(() => 'add-task')
    const closeAndRecycle = vi.fn()
    const show = vi.fn()
    ctx.windowManager = {
      ...ctx.windowManager,
      getWindowIdBySender,
      closeAndRecycle,
      show,
    } as any
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const fakeSender = {} as never
    await handlers[Commands.CloseCurrentWindow]?.(fakeSender, {
      showMain: true,
      navigateMainTo: '/downloads',
    })

    expect(closeAndRecycle).toHaveBeenCalledWith('add-task')
    expect(show).toHaveBeenCalledWith('main')
    expect(ctx.eventBus.emit).toHaveBeenCalledWith(
      Events.NavigateTo,
      '/downloads'
    )
  })

  it('CloseCurrentWindow does not emit NavigateTo without navigateMainTo', async () => {
    const ctx = fakeCtx()
    const getWindowIdBySender = vi.fn(() => 'add-task')
    ctx.windowManager = {
      ...ctx.windowManager,
      getWindowIdBySender,
      closeAndRecycle: vi.fn(),
      show: vi.fn(),
    } as any
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const fakeSender = {} as never
    await handlers[Commands.CloseCurrentWindow]?.(fakeSender, {
      showMain: true,
    })

    // Handler emits exactly one event (NavigateTo) and only when
    // navigateMainTo is set — so a blanket not-called check is enough.
    expect(ctx.eventBus.emit).not.toHaveBeenCalled()
  })

  it('ShowAddTaskWindow opens the add-task window', async () => {
    const ctx = fakeCtx()
    const send = vi.fn()
    ;(ctx.windowManager as any).open = vi.fn(() => ({
      isDestroyed: vi.fn(() => false),
      webContents: {
        isLoading: vi.fn(() => false),
        once: vi.fn(),
        send,
      },
    }))
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const result = await handlers[Commands.ShowAddTaskWindow]?.()
    expect(ctx.windowManager.open).toHaveBeenCalledWith('add-task')
    expect(send).toHaveBeenCalledWith(Events.SetAddTaskMode, { mode: 'links' })
    expect(result).toEqual({ ok: true })
  })

  it('ResizeWindow uses bounds so non-resizable windows can shrink', async () => {
    const setBounds = vi.fn()
    const getSize = vi.fn(() => [800, 600])
    const isDestroyed = vi.fn(() => false)
    fromWebContentsMock.mockReturnValueOnce({
      isDestroyed,
      getSize,
      setBounds,
    })
    const ctx = fakeCtx()
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const fakeSender = {} as never
    const result = await handlers[Commands.ResizeWindow]?.(fakeSender, {
      width: 400,
      height: 300,
    })
    expect(fromWebContentsMock).toHaveBeenCalledWith(fakeSender)
    expect(setBounds).toHaveBeenCalledWith({ width: 400, height: 300 }, true)
    expect(result).toEqual({ ok: true })
  })

  it('MinimizeCurrentWindow minimizes only its sender window', async () => {
    const minimize = vi.fn()
    fromWebContentsMock.mockReturnValueOnce({
      isDestroyed: vi.fn(() => false),
      isMinimizable: vi.fn(() => true),
      minimize,
    })
    const ctx = fakeCtx()
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const fakeSender = {} as never

    await expect(
      handlers[Commands.MinimizeCurrentWindow]?.(fakeSender)
    ).resolves.toEqual({ ok: true })
    expect(fromWebContentsMock).toHaveBeenCalledWith(fakeSender)
    expect(minimize).toHaveBeenCalledOnce()
  })

  it('ToggleMaximizeCurrentWindow maximizes and restores only its sender window', async () => {
    const maximize = vi.fn()
    const unmaximize = vi.fn()
    const fakeSender = {} as never
    fromWebContentsMock
      .mockReturnValueOnce({
        isDestroyed: vi.fn(() => false),
        isMaximizable: vi.fn(() => true),
        isMaximized: vi.fn(() => false),
        maximize,
        unmaximize,
      })
      .mockReturnValueOnce({
        isDestroyed: vi.fn(() => false),
        isMaximizable: vi.fn(() => true),
        isMaximized: vi.fn(() => true),
        maximize,
        unmaximize,
      })
    const ctx = fakeCtx()
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.ToggleMaximizeCurrentWindow]?.(fakeSender)
    ).resolves.toEqual({ ok: true })
    await expect(
      handlers[Commands.ToggleMaximizeCurrentWindow]?.(fakeSender)
    ).resolves.toEqual({ ok: true })

    expect(fromWebContentsMock).toHaveBeenNthCalledWith(1, fakeSender)
    expect(fromWebContentsMock).toHaveBeenNthCalledWith(2, fakeSender)
    expect(maximize).toHaveBeenCalledOnce()
    expect(unmaximize).toHaveBeenCalledOnce()
  })

  it('routes direct shell commands to their owning collaborators', async () => {
    const ctx = fakeCtx()
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(handlers[Commands.RestartEngine]?.()).resolves.toEqual({
      ok: true,
    })
    await expect(
      handlers[Commands.ConfirmPortSwitch]?.(16801)
    ).resolves.toEqual({ ok: true })
    await handlers[Commands.NextTorrent]?.()
    await handlers[Commands.DownloadAllTorrents]?.({
      selectedFiles: [0],
      saveDir: '/tmp',
      dlLimit: 1024,
      ulLimit: 512,
      seedRatio: 1.5,
    })
    await handlers[Commands.ShowMainWindow]?.()
    await handlers[Commands.CheckForUpdates]?.()
    await handlers[Commands.DownloadUpdate]?.()
    await handlers[Commands.InstallUpdate]?.()
    const mainSender = {} as never
    ctx.windowManager.getWindowIdBySender.mockReturnValue('main')
    await handlers[Commands.UpdateMenuContext]?.(mainSender, {
      currentRoute: '/downloads',
    })

    expect(ctx.supervisor.restart).toHaveBeenCalledOnce()
    expect(ctx.settingsManager.update).toHaveBeenCalledWith({
      engine: { rpcPort: 16801 },
    })
    expect(ctx.protocolManager.nextTorrent).toHaveBeenCalledOnce()
    expect(ctx.protocolManager.downloadAllTorrents).toHaveBeenCalledOnce()
    expect(ctx.windowManager.show).toHaveBeenCalledWith('main')
    expect(ctx.updateManager.check).toHaveBeenCalledOnce()
    expect(ctx.updateManager.download).toHaveBeenCalledOnce()
    expect(ctx.updateManager.install).toHaveBeenCalledOnce()
    expect(ctx.contextStore.merge).toHaveBeenCalledWith({
      currentRoute: '/downloads',
    })
  })

  it('applies the current form options when creating an App torrent batch', async () => {
    const ctx = fakeCtx()
    ctx.protocolManager.downloadAllTorrents.mockResolvedValueOnce([
      {
        payload: { name: 'first.torrent', dataBase64: 'Zmlyc3Q=' },
        meta: {
          name: 'first.bin',
          files: [
            { index: 0, path: 'skip.bin' },
            { index: 1, path: 'keep.bin' },
          ],
        },
      },
      {
        payload: { name: 'second.torrent', dataBase64: 'c2Vjb25k' },
        meta: {
          name: 'second.bin',
          files: [
            { index: 0, path: 'one.bin' },
            { index: 1, path: 'two.bin' },
          ],
        },
      },
    ] as never)
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.DownloadAllTorrents]?.({
        selectedFiles: [1],
        saveDir: '/tmp/batch',
        dlLimit: 2048,
        ulLimit: 1024,
        seedRatio: 1.5,
      })
    ).resolves.toEqual({
      total: 2,
      succeeded: 2,
      failed: 0,
      firstTaskId: expect.any(String),
    })
    expect(ctx.rpcClient.addTorrent).toHaveBeenNthCalledWith(
      1,
      'Zmlyc3Q=',
      [],
      expect.objectContaining({
        'select-file': '2',
        'max-download-limit': '2048K',
        'max-upload-limit': '1024K',
        'seed-ratio': '1.5',
      })
    )
    expect(ctx.rpcClient.addTorrent).toHaveBeenNthCalledWith(
      2,
      'c2Vjb25k',
      [],
      expect.objectContaining({
        'select-file': '1,2',
        'max-download-limit': '2048K',
        'max-upload-limit': '1024K',
        'seed-ratio': '1.5',
      })
    )
  })

  it('rejects menu-context updates from auxiliary windows', async () => {
    const ctx = fakeCtx()
    ctx.windowManager.getWindowIdBySender.mockReturnValue('add-task')
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)

    await expect(
      handlers[Commands.UpdateMenuContext]?.({} as never, {
        selectedTaskId: 'victim-task',
      })
    ).rejects.toThrow('non-main window')
    expect(ctx.contextStore.merge).not.toHaveBeenCalled()
  })

  it('returns a picked save directory and handles cancellation', async () => {
    showOpenDialogMock.mockReset()
    fromWebContentsMock.mockReset()
    const sender = {} as never
    const parent = { isDestroyed: () => false }
    fromWebContentsMock.mockReturnValue(parent)
    showOpenDialogMock
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/downloads'] })
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(fakeCtx())

    await expect(
      handlers[Commands.PickSaveDir]?.(sender, { defaultPath: '/tmp' })
    ).resolves.toBeNull()
    await expect(
      handlers[Commands.PickSaveDir]?.(sender, { defaultPath: '/tmp' })
    ).resolves.toEqual({ path: '/downloads' })
    expect(showOpenDialogMock).toHaveBeenCalledWith(parent, {
      properties: ['openDirectory'],
      defaultPath: '/tmp',
    })
  })

  it('ignores concurrent save-directory picks from the same window', async () => {
    showOpenDialogMock.mockReset()
    fromWebContentsMock.mockReset()
    const sender = {} as never
    const parent = { isDestroyed: () => false }
    fromWebContentsMock.mockReturnValue(parent)
    let resolvePick!: (result: {
      canceled: boolean
      filePaths: string[]
    }) => void
    showOpenDialogMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePick = resolve
        })
    )
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(fakeCtx())

    const first = handlers[Commands.PickSaveDir]?.(sender, {
      defaultPath: '/first',
    })
    await expect(
      handlers[Commands.PickSaveDir]?.(sender, { defaultPath: '/second' })
    ).resolves.toBeNull()
    expect(showOpenDialogMock).toHaveBeenCalledOnce()

    resolvePick({ canceled: false, filePaths: ['/picked'] })
    await expect(first).resolves.toEqual({ path: '/picked' })

    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(
      handlers[Commands.PickSaveDir]?.(sender, { defaultPath: '/third' })
    ).resolves.toBeNull()
    expect(showOpenDialogMock).toHaveBeenCalledTimes(2)
  })

  it('opens only allow-listed external URL schemes', async () => {
    openExternalMock.mockReset()
    openExternalMock.mockResolvedValue(undefined)
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(fakeCtx())

    await handlers[Commands.OpenExternal]?.(EXTERNAL_URLS.motrix.home)
    await handlers[Commands.OpenExternal]?.('mailto:support@motrix.app')
    await handlers[Commands.OpenExternal]?.('file:///tmp/private')

    expect(openExternalMock).toHaveBeenCalledTimes(2)
    expect(openExternalMock).toHaveBeenNthCalledWith(
      1,
      EXTERNAL_URLS.motrix.home
    )
    expect(openExternalMock).toHaveBeenNthCalledWith(
      2,
      'mailto:support@motrix.app'
    )
  })

  it('opens the compatible Default Apps page on Windows', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform'
    )
    if (!platformDescriptor) throw new Error('process.platform is unavailable')

    openExternalMock.mockReset()
    openExternalMock.mockResolvedValue(undefined)
    resolveWindowsDefaultAppsSettingsUrlMock.mockReset()
    resolveWindowsDefaultAppsSettingsUrlMock.mockResolvedValue(
      WINDOWS_DEFAULT_APPS_SETTINGS_URL
    )
    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: 'win32',
    })

    try {
      const handlers = buildCommandHandlers(
        fakeCtx() as unknown as CommandContext
      )

      await expect(
        handlers[Commands.RequestDefaultTorrentHandler]?.()
      ).resolves.toEqual({ ok: true, action: 'opened-settings' })
      expect(openExternalMock).toHaveBeenCalledOnce()
      expect(openExternalMock).toHaveBeenCalledWith(
        WINDOWS_DEFAULT_APPS_SETTINGS_URL
      )
      expect(resolveWindowsDefaultAppsSettingsUrlMock).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('forwards add-task prefill only after the window finishes loading', async () => {
    let didFinishLoad: (() => void) | undefined
    const send = vi.fn()
    const ctx = fakeCtx()
    ctx.windowManager.open.mockReturnValue({
      isDestroyed: vi.fn(() => false),
      webContents: {
        isLoading: vi.fn(() => true),
        once: vi.fn((_event: string, handler: () => void) => {
          didFinishLoad = handler
        }),
        send,
      },
    })
    // @ts-expect-error partial ctx
    const handlers = buildCommandHandlers(ctx)
    const prefill = { url: 'https://example.com/file.zip' }

    await handlers[Commands.ShowAddTaskWindow]?.({ prefill })

    expect(send).not.toHaveBeenCalled()
    didFinishLoad?.()
    expect(send).toHaveBeenCalledWith(Events.SetAddTaskMode, prefill)
  })

  it.each([
    [Commands.EnableNat, 'enable'],
    [Commands.DisableNat, 'disable'],
    [Commands.ForceRemapNat, 'forceRemap'],
    [Commands.RunNatDiagnostic, 'runDiagnostic'],
    [Commands.ExportNatBundle, 'exportBundle'],
  ] as const)(
    'routes %s through the rate-limited NAT facade',
    async (channel, method) => {
      const ctx = fakeCtx()
      // @ts-expect-error partial ctx
      const handlers = buildCommandHandlers(ctx)

      const result = await handlers[channel]?.()

      expect(ctx.natManager[method]).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ ok: true })
    }
  )

  it('registers sender-aware and ordinary IPC wrappers', async () => {
    ipcHandleMock.mockReset()
    ipcRemoveHandlerMock.mockReset()
    const ctx = fakeCtx()
    const sender = { id: 1 }
    ctx.windowManager.getWindowIdBySender.mockReturnValue('main')

    const dispose = registerCommandHandlers(ctx as unknown as CommandContext)

    const closeRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.CloseCurrentWindow
    )
    const minimizeRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.MinimizeCurrentWindow
    )
    const toggleMaximizeRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.ToggleMaximizeCurrentWindow
    )
    const menuContextRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.UpdateMenuContext
    )
    const pickSaveDirRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.PickSaveDir
    )
    const restartRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.RestartEngine
    )
    expect(closeRegistration).toBeDefined()
    expect(minimizeRegistration).toBeDefined()
    expect(toggleMaximizeRegistration).toBeDefined()
    expect(menuContextRegistration).toBeDefined()
    expect(pickSaveDirRegistration).toBeDefined()
    expect(restartRegistration).toBeDefined()

    await closeRegistration?.[1]({ sender }, { showMain: true })
    fromWebContentsMock.mockReturnValueOnce({
      isDestroyed: () => false,
      isMinimizable: () => true,
      minimize: vi.fn(),
    })
    await minimizeRegistration?.[1]({ sender })
    fromWebContentsMock.mockReturnValueOnce({
      isDestroyed: () => false,
      isMaximizable: () => true,
      isMaximized: () => false,
      maximize: vi.fn(),
    })
    await toggleMaximizeRegistration?.[1]({ sender })
    await menuContextRegistration?.[1]({ sender }, { currentRoute: '/tasks' })
    const pickerWindow = { isDestroyed: () => false }
    fromWebContentsMock.mockReturnValueOnce(pickerWindow)
    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await pickSaveDirRegistration?.[1]({ sender }, { defaultPath: '/tmp' })
    await restartRegistration?.[1]({})

    expect(ctx.windowManager.getWindowIdBySender).toHaveBeenCalledWith(sender)
    expect(ctx.windowManager.closeAndRecycle).toHaveBeenCalledWith('main')
    expect(fromWebContentsMock).toHaveBeenCalledWith(sender)
    expect(showOpenDialogMock).toHaveBeenCalledWith(pickerWindow, {
      properties: ['openDirectory'],
      defaultPath: '/tmp',
    })
    expect(ctx.contextStore.merge).toHaveBeenCalledWith({
      currentRoute: '/tasks',
    })
    expect(ctx.supervisor.restart).toHaveBeenCalledOnce()

    dispose()
    expect(ipcRemoveHandlerMock).toHaveBeenCalledWith(
      Commands.CloseCurrentWindow
    )
    expect(ipcRemoveHandlerMock).toHaveBeenCalledWith(
      Commands.MinimizeCurrentWindow
    )
    expect(ipcRemoveHandlerMock).toHaveBeenCalledWith(
      Commands.ToggleMaximizeCurrentWindow
    )
    expect(ipcRemoveHandlerMock).toHaveBeenCalledWith(Commands.RestartEngine)
  })

  it('keeps an accepted command inside the shutdown drain', async () => {
    ipcHandleMock.mockReset()
    ipcRemoveHandlerMock.mockReset()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new MainProcessWorkCoordinator()
    const ctx = fakeCtx()
    ctx.supervisor.restart.mockImplementation(() => pending)
    const dispose = registerCommandHandlers({
      ...ctx,
      trackAsyncWork: <T>(operation: () => Promise<T>) =>
        coordinator.run(operation),
    } as unknown as CommandContext)
    const restartRegistration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === Commands.RestartEngine
    )

    const result = restartRegistration?.[1]({})
    const drain = coordinator.stopAndDrain()
    let drained = false
    void drain.then(() => {
      drained = true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(drained).toBe(false)

    release()
    await expect(result).resolves.toEqual({ ok: true })
    await drain
    dispose()
  })
})

describe('SetTaskBtTracker handler', () => {
  it('looks up taskId from engineGid and calls trackerManager.setBtTracker', async () => {
    const trackerManager = {
      setBtTracker: vi.fn().mockResolvedValue(undefined),
    }
    const taskManager = {
      ...fakeCtx().taskManager,
      getByEngineTaskId: vi.fn().mockReturnValue({ id: 'task-1' }),
    }
    const handlers = buildCommandHandlers({
      ...fakeCtx(),
      trackerManager,
      taskManager,
    } as unknown as CommandContext)
    await handlers[Commands.SetTaskBtTracker]?.({
      engineGid: 'gid-1',
      trackers: ['http://a'],
    })
    expect(trackerManager.setBtTracker).toHaveBeenCalledWith(
      'task-1',
      'gid-1',
      ['http://a']
    )
  })

  it('no-ops when task not found', async () => {
    const trackerManager = { setBtTracker: vi.fn() }
    const taskManager = {
      ...fakeCtx().taskManager,
      getByEngineTaskId: vi.fn().mockReturnValue(undefined),
    }
    const handlers = buildCommandHandlers({
      ...fakeCtx(),
      trackerManager,
      taskManager,
    } as unknown as CommandContext)
    await handlers[Commands.SetTaskBtTracker]?.({
      engineGid: 'gid-x',
      trackers: [],
    })
    expect(trackerManager.setBtTracker).not.toHaveBeenCalled()
  })
})

describe('Commands.UpdateSettings', () => {
  // Namespaces come in as one named object, not as trailing positional
  // parameters: five defaulted `object` slots in a row means a call site can
  // silently put its override in the wrong namespace and still type-check.
  function makeSettingsLike(
    proxy: object,
    {
      app = {},
      nat = {},
      tracker = {},
      engine = {},
      bridge = {},
    }: {
      app?: object
      nat?: object
      tracker?: object
      engine?: object
      bridge?: object
    } = {}
  ) {
    return {
      app: {
        launchAtStartup: false,
        protocols: { magnet: false },
        defaultSaveDir: '/downloads',
        ...app,
      },
      nat: {
        natTypeDetectionEnabled: false,
        portReachabilityCheckEnabled: false,
        ...nat,
      },
      proxy,
      engine,
      tracker: {
        sourcesEnabled: true,
        blacklistEnabled: true,
        ...tracker,
      },
      bridge: {
        fixedPort: 'auto',
        instanceId: 'instance-1',
        ...bridge,
      },
    }
  }

  const PROXY_OFF = {
    enabled: false,
    protocol: 'http',
    host: '',
    port: 8080,
    user: '',
    password: '',
    bypass: [],
    scopes: { download: false, updateApp: false, updateTrackers: false },
  }
  const PROXY_ON = { ...PROXY_OFF, enabled: true, host: 'p.example', port: 80 }

  it('applies a saved magnet preference immediately to protocol owners', async () => {
    reconcileAppImageIntegrationFromSettingsMock.mockClear()
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      app: { protocols: { magnet: false } },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      app: { protocols: { magnet: true } },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const protocolManager = {
      register: vi.fn(() => ({ magnetMatchesSetting: true })),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager,
    } as unknown as CommandContext)

    const updateResult = await handlers[Commands.UpdateSettings]?.({
      app: { protocols: { magnet: true } },
    })

    expect(protocolManager.register).toHaveBeenCalledOnce()
    expect(reconcileAppImageIntegrationFromSettingsMock).toHaveBeenCalledOnce()
    const options =
      reconcileAppImageIntegrationFromSettingsMock.mock.calls[0]?.[0]
    expect(options?.getMagnetEnabled()).toBe(true)
    expect(updateResult).toMatchObject({ protocolAssociationApplied: true })
  })

  it('returns an explicit association failure after saving the preference', async () => {
    reconcileAppImageIntegrationFromSettingsMock.mockResolvedValueOnce({
      supported: true,
      decision: 'accepted',
      owner: 'self',
      status: 'failed',
    })
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      app: { protocols: { magnet: true } },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      app: { protocols: { magnet: false } },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: {
        register: vi.fn(() => ({ magnetMatchesSetting: null })),
      },
    } as unknown as CommandContext)

    await expect(
      handlers[Commands.UpdateSettings]?.({
        app: { protocols: { magnet: false } },
      })
    ).resolves.toMatchObject({ protocolAssociationApplied: false })
    expect(settingsManager.update).toHaveBeenCalledOnce()
  })

  it('retries an explicitly submitted magnet preference even when already saved', async () => {
    reconcileAppImageIntegrationFromSettingsMock.mockClear()
    const ctx = fakeCtx()
    const settings = makeSettingsLike(PROXY_OFF, {
      app: { protocols: { magnet: false } },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValue(settings),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const protocolManager = {
      register: vi.fn(() => ({ magnetMatchesSetting: true })),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager,
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({
      app: { protocols: { magnet: false } },
    })

    expect(protocolManager.register).toHaveBeenCalledOnce()
    expect(reconcileAppImageIntegrationFromSettingsMock).toHaveBeenCalled()
  })

  it('does not invoke proxyApplier when proxy unchanged', async () => {
    const ctx = fakeCtx()
    const settings = makeSettingsLike(PROXY_OFF)
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValue(settings),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
      protocolManager: { register: vi.fn() },
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({
      app: { launchAtStartup: false },
    })
    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
    expect(ctx.supervisor.restart).not.toHaveBeenCalled()
  })

  it('reasserts every proxy scope when proxy fields changed', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF)
    const after = makeSettingsLike(PROXY_ON)
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValue(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })
    expect(ctx.proxyApplier.applyAll).toHaveBeenCalledWith(PROXY_ON)
    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
    expect(ctx.supervisor.restart).not.toHaveBeenCalled()
  })

  it('commits the exact route returned by a proxy hot-apply', async () => {
    const ctx = fakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    const before = makeSettingsLike(PROXY_OFF)
    const after = makeSettingsLike(PROXY_ON)
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValue(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      downloadProxy: 'applied',
      appliedProxy: {
        allProxy: 'http://127.0.0.1:43123',
        noProxy: '.internal',
      },
    })
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      appliedDownloadProxyPolicy: policy,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({ proxy: PROXY_ON })

    expect(policy.snapshot()).toEqual({
      proxy: 'http://127.0.0.1:43123',
      noProxy: '.internal',
    })
  })

  it('force-reapplies the same proxy after a failed hot apply', async () => {
    const ctx = fakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    const before = makeSettingsLike(PROXY_OFF)
    const after = makeSettingsLike(PROXY_ON)
    let current = before
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn(() => current),
      update: vi.fn(async () => {
        current = after
        return {
          ok: true,
          requiresRestart: false,
          changedRestartKeys: [],
        }
      }),
    }
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('RPC failed'))
      .mockResolvedValueOnce({
        downloadProxy: 'applied',
        appliedProxy: {
          allProxy: 'http://p.example:80',
          noProxy: '',
        },
      })
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      appliedDownloadProxyPolicy: policy,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

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
    const ctx = fakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    const proxyA = {
      ...PROXY_ON,
      scopes: { download: true, updateApp: false, updateTrackers: false },
    }
    const proxyB = {
      ...proxyA,
      scopes: { download: true, updateApp: true, updateTrackers: false },
    }
    const before = makeSettingsLike(PROXY_OFF)
    const afterA = makeSettingsLike(proxyA)
    const afterB = makeSettingsLike(proxyB)
    let current = before
    let releaseReader!: () => void
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    const reader = policy.runWithSnapshot(async () => readerGate)
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn(() => current),
      update: vi.fn(async (partial: { proxy?: { scopes?: object } }) => {
        current = partial.proxy?.scopes === proxyA.scopes ? afterA : afterB
        return {
          ok: true,
          requiresRestart: false,
          changedRestartKeys: [],
        }
      }),
    }
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>).mockImplementation(
      async (next) => ({
        downloadProxy: 'applied',
        appliedProxy: {
          allProxy: `http://${next.host}:${next.port}`,
          noProxy: '',
        },
      })
    )
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      appliedDownloadProxyPolicy: policy,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

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

  it('applies proxy state before a later bridge side effect can fail', async () => {
    const ctx = fakeCtx()
    const policy = new AppliedDownloadProxyPolicy({ noProxy: '' })
    const proxy = {
      ...PROXY_ON,
      scopes: { download: true, updateApp: false, updateTrackers: false },
    }
    const before = makeSettingsLike(PROXY_OFF, {
      app: { browserBridgeEnabled: false },
    })
    const after = makeSettingsLike(proxy, {
      app: { browserBridgeEnabled: true },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValue(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    ;(ctx.proxyApplier.applyAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      downloadProxy: 'applied',
      appliedProxy: {
        allProxy: 'http://p.example:80',
        noProxy: '',
      },
    })
    ctx.bridgeManager.setEnabled.mockRejectedValueOnce(
      new Error('bridge failed')
    )
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      appliedDownloadProxyPolicy: policy,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await expect(
      handlers[Commands.UpdateSettings]?.({
        proxy,
        app: { browserBridgeEnabled: true },
      })
    ).rejects.toThrow('bridge failed')

    expect(ctx.proxyApplier.applyAll).toHaveBeenCalledWith(proxy)
    expect(policy.snapshot()).toEqual({
      proxy: 'http://p.example:80',
      noProxy: '',
    })
  })

  it('hot-applies a changed default save directory', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      app: { defaultSaveDir: '/downloads/old' },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      app: { defaultSaveDir: '/downloads/new' },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({
      app: { defaultSaveDir: '/downloads/new' },
    })

    expect(ctx.supervisor.applyDefaultSaveDir).toHaveBeenCalledExactlyOnceWith(
      '/downloads/new'
    )
  })

  it('saves restart-required settings and publishes a reminder without restarting', async () => {
    const ctx = fakeCtx()
    const settings = makeSettingsLike(PROXY_OFF)
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValue(settings),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: true,
        changedRestartKeys: ['rpcPort'],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({ engine: { rpcPort: 9000 } })
    expect(ctx.supervisor.restart).not.toHaveBeenCalled()
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
    expect(ctx.proxyApplier.apply).not.toHaveBeenCalled()
  })

  it('hot-applies runtime engine settings without a restart reminder', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, { engine: { split: 16 } })
    const after = makeSettingsLike(PROXY_OFF, { engine: { split: 32 } })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({ engine: { split: 32 } })

    expect(ctx.supervisor.applyEngineSettings).toHaveBeenCalledWith(
      before.engine,
      after.engine
    )
    expect(ctx.notificationCenter.notify).not.toHaveBeenCalled()
  })

  it('calls trackerManager.applySourcesChange when sourcesEnabled changes', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: true, blacklistEnabled: true },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: false, blacklistEnabled: true },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({
      tracker: { sourcesEnabled: false },
    })
    expect(ctx.trackerManager.applySourcesChange).toHaveBeenCalledWith(false)
    expect(ctx.trackerManager.applyBlacklistChange).not.toHaveBeenCalled()
  })

  it('calls trackerManager.applyBlacklistChange when blacklistEnabled changes', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: true, blacklistEnabled: true },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: true, blacklistEnabled: false },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({
      tracker: { blacklistEnabled: false },
    })
    expect(ctx.trackerManager.applyBlacklistChange).toHaveBeenCalledWith(false)
    expect(ctx.trackerManager.applySourcesChange).not.toHaveBeenCalled()
  })

  it('calls both apply* methods when both toggle in one patch', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: true, blacklistEnabled: true },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: false, blacklistEnabled: false },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({
      tracker: { sourcesEnabled: false, blacklistEnabled: false },
    })
    expect(ctx.trackerManager.applySourcesChange).toHaveBeenCalledWith(false)
    expect(ctx.trackerManager.applyBlacklistChange).toHaveBeenCalledWith(false)
  })

  it('does not call apply* methods when tracker toggles unchanged', async () => {
    const ctx = fakeCtx()
    const settings = makeSettingsLike(PROXY_OFF, {
      tracker: { sourcesEnabled: true, blacklistEnabled: true },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValue(settings),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)
    await handlers[Commands.UpdateSettings]?.({
      app: { launchAtStartup: false },
    })
    expect(ctx.trackerManager.applySourcesChange).not.toHaveBeenCalled()
    expect(ctx.trackerManager.applyBlacklistChange).not.toHaveBeenCalled()
  })

  it('calls bridgeManager.restart when bridge.fixedPort changes', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      bridge: { fixedPort: 'auto' },
    })
    const after = makeSettingsLike(PROXY_OFF, { bridge: { fixedPort: 16900 } })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const bridgeManager = {
      current: null,
      setEnabled: vi.fn(),
      restart: vi.fn(),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      bridgeManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({
      bridge: { fixedPort: 16900 },
    })

    expect(bridgeManager.restart).toHaveBeenCalledOnce()
    expect(bridgeManager.setEnabled).not.toHaveBeenCalled()
  })

  it('does not call bridgeManager.restart when bridge.fixedPort is unchanged', async () => {
    const ctx = fakeCtx()
    const settings = makeSettingsLike(PROXY_OFF, {
      bridge: { fixedPort: 'auto' },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValue(settings),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const bridgeManager = {
      current: null,
      setEnabled: vi.fn(),
      restart: vi.fn(),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      bridgeManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({
      app: { launchAtStartup: false },
    })

    expect(bridgeManager.restart).not.toHaveBeenCalled()
  })

  it('reconfigures the updater after the persisted channel changes', async () => {
    const ctx = fakeCtx()
    const before = makeSettingsLike(PROXY_OFF, {
      app: { updateChannel: 'stable' },
    })
    const after = makeSettingsLike(PROXY_OFF, {
      app: { updateChannel: 'beta' },
    })
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after),
      update: vi.fn().mockResolvedValue({
        saved: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...ctx,
      settingsManager,
      protocolManager: { register: vi.fn() },
    } as unknown as CommandContext)

    await handlers[Commands.UpdateSettings]?.({
      app: { updateChannel: 'beta' },
    })

    expect(ctx.updateManager.setChannel).toHaveBeenCalledWith('beta')
  })
})

describe('SyncTaskBtTracker handler', () => {
  it('looks up isPrivate from motrixDatabase and forwards to syncBtTracker', async () => {
    const trackerManager = {
      syncBtTracker: vi.fn().mockResolvedValue(undefined),
    }
    const taskManager = {
      ...fakeCtx().taskManager,
      getByEngineTaskId: vi.fn().mockReturnValue({ id: 'task-1' }),
    }
    const motrixDatabase = {
      getTask: vi.fn().mockReturnValue({
        task: { motrixId: 'task-1', isPrivate: true },
        instances: [],
      }),
    }
    const handlers = buildCommandHandlers({
      ...fakeCtx(),
      trackerManager,
      taskManager,
      motrixDatabase,
    } as unknown as CommandContext)
    await handlers[Commands.SyncTaskBtTracker]?.({ engineGid: 'gid-1' })
    expect(trackerManager.syncBtTracker).toHaveBeenCalledWith(
      'task-1',
      'gid-1',
      true
    )
  })

  it('defaults isPrivate to false when metadata not found', async () => {
    const trackerManager = {
      syncBtTracker: vi.fn().mockResolvedValue(undefined),
    }
    const taskManager = {
      ...fakeCtx().taskManager,
      getByEngineTaskId: vi.fn().mockReturnValue({ id: 'task-1' }),
    }
    const motrixDatabase = {
      getTask: vi.fn().mockReturnValue(null),
    }
    const handlers = buildCommandHandlers({
      ...fakeCtx(),
      trackerManager,
      taskManager,
      motrixDatabase,
    } as unknown as CommandContext)
    await handlers[Commands.SyncTaskBtTracker]?.({ engineGid: 'gid-1' })
    expect(trackerManager.syncBtTracker).toHaveBeenCalledWith(
      'task-1',
      'gid-1',
      false
    )
  })
})

describe('Commands.UpdatePluginConfig', () => {
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
    const ctx = fakeCtx()
    const settingsManager = {
      ...ctx.settingsManager,
      get: vi.fn(() => ({ plugins: { 'test-plugin': priorConfig } })),
      update: vi.fn().mockResolvedValue({
        ok: true,
        requiresRestart: false,
        changedRestartKeys: [],
      }),
    }
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const pluginRegistry = {
      get: vi.fn((id: string) =>
        id === 'test-plugin' ? { manifest } : undefined
      ),
    }
    return {
      ctx: {
        ...ctx,
        settingsManager,
        eventBus,
        pluginRegistry,
        capabilityHost,
      },
      settingsManager,
      eventBus,
      pluginRegistry,
      applyExternalChange,
      configFor,
      encrypt,
    }
  }

  it('persists config and emits PluginConfigChanged', async () => {
    const { ctx, settingsManager, eventBus, applyExternalChange } =
      makePluginCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)
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
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)
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

  it('merges with prior stored config', async () => {
    const { ctx, settingsManager } = makePluginCtx({
      priorConfig: { existing: 'value' },
    })
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)
    await handlers[Commands.UpdatePluginConfig]?.({
      pluginId: 'test-plugin',
      patch: { timeout: 60 },
    })
    expect(settingsManager.update).toHaveBeenCalledWith({
      plugins: {
        'test-plugin': { existing: 'value', timeout: 60 },
      },
    })
  })

  it('throws when plugin not found in registry', async () => {
    const { ctx } = makePluginCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)
    await expect(
      handlers[Commands.UpdatePluginConfig]?.({
        pluginId: 'no-such-plugin',
        patch: {},
      })
    ).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
  })
})

describe('plugin enable/disable commands', () => {
  function makePluginLifecycleCtx() {
    return {
      ...fakeCtx(),
      pluginStateStore: {
        setEnabled: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
      },
      pluginRegistry: {
        refreshState: vi.fn(),
      },
      pluginHost: {
        deactivate: vi.fn().mockResolvedValue(undefined),
      },
      eventBus: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        removeAll: vi.fn(),
      },
    }
  }

  it('emits contribution index changes when enabling a plugin', async () => {
    const ctx = makePluginLifecycleCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

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
    const ctx = makePluginLifecycleCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    await handlers[Commands.EnablePlugin]?.('test-plugin')

    expect(ctx.pluginStateStore.setEnabled).toHaveBeenCalledWith(
      'test-plugin',
      true
    )
    expect(ctx.pluginRegistry.refreshState).toHaveBeenCalledWith('test-plugin')
  })

  it('emits contribution index changes when disabling a plugin', async () => {
    const ctx = makePluginLifecycleCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

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
    const ctx = makePluginLifecycleCtx()
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    await handlers[Commands.DisablePlugin]?.('test-plugin')

    expect(ctx.pluginStateStore.setEnabled).toHaveBeenCalledWith(
      'test-plugin',
      false
    )
    expect(ctx.pluginRegistry.refreshState).toHaveBeenCalledWith('test-plugin')
  })
})

describe('Commands.RevertBuiltinToBundled', () => {
  const overlayDirs: string[] = []

  afterEach(async () => {
    while (overlayDirs.length > 0) {
      const dir = overlayDirs.pop()
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  })

  async function makeRevertCtx(pluginId: string) {
    const overlayDir = await mkdtemp(
      path.join(tmpdir(), 'motrix-revert-overlay-')
    )
    overlayDirs.push(overlayDir)
    // Overlay present on disk for this plugin, as it would be after a
    // committed builtin update.
    await mkdir(path.join(overlayDir, pluginId), { recursive: true })

    // Mutable so pluginRegistry.list() reflects reality after deactivate()
    // runs, exactly like the real PluginRegistry/plugin-host pairing: the
    // plugin is ACTIVE going in, and flips to inactive once deactivated.
    // A test double that always reports 'active' would pass even with the
    // pre-fix ordering bug, since it never observes the state flip that
    // makes the bug visible.
    let status: 'active' | 'inactive' = 'active'
    const pluginRegistry = {
      list: vi.fn(() => [{ id: pluginId, status }]),
      discover: vi.fn().mockResolvedValue(undefined),
    }
    const pluginHost = {
      deactivate: vi.fn().mockImplementation(async () => {
        status = 'inactive'
      }),
      activate: vi.fn().mockImplementation(async () => {
        status = 'active'
      }),
    }
    const eventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeAll: vi.fn(),
    }
    const ctx = {
      ...fakeCtx(),
      pluginRegistry,
      pluginHost,
      eventBus,
      overlayDir,
    }
    return { ctx, pluginRegistry, pluginHost, eventBus, overlayDir }
  }

  it('reactivates a builtin that was active before the revert', async () => {
    const pluginId = 'motrix.filename-template'
    const { ctx, pluginRegistry, pluginHost, overlayDir } =
      await makeRevertCtx(pluginId)
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    const result = await handlers[Commands.RevertBuiltinToBundled]?.({
      pluginId,
    })

    // The plugin was active going in, so the handler must bring it back
    // up after the overlay is removed — this is the whole point of the fix:
    // before it, wasActive was sampled AFTER deactivate() had already run
    // and always came back false, so activate() was never called here.
    expect(pluginHost.activate).toHaveBeenCalledWith(pluginId)
    expect(result).toMatchObject({ ok: true, restartRequired: false })

    // Ordering must still hold: deactivate (so the worker releases overlay
    // files) strictly before the rescan/reactivate.
    const deactivateOrder = pluginHost.deactivate.mock.invocationCallOrder[0]
    const discoverOrder = pluginRegistry.discover.mock.invocationCallOrder[0]
    const activateOrder = pluginHost.activate.mock.invocationCallOrder[0]
    expect(deactivateOrder).toBeLessThan(discoverOrder)
    expect(discoverOrder).toBeLessThan(activateOrder)

    // The overlay directory itself is gone.
    await expect(access(path.join(overlayDir, pluginId))).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
  })

  it('reports restartRequired when reactivation fails after revert', async () => {
    const pluginId = 'motrix.filename-template'
    const { ctx, pluginHost } = await makeRevertCtx(pluginId)
    pluginHost.activate.mockRejectedValueOnce(new Error('worker crash'))
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    const result = await handlers[Commands.RevertBuiltinToBundled]?.({
      pluginId,
    })

    expect(pluginHost.activate).toHaveBeenCalledWith(pluginId)
    expect(result).toMatchObject({ ok: true, restartRequired: true })
  })

  it('does not reactivate a builtin that was already inactive', async () => {
    const pluginId = 'motrix.filename-template'
    const { ctx, pluginRegistry, pluginHost } = await makeRevertCtx(pluginId)
    pluginRegistry.list.mockReturnValue([{ id: pluginId, status: 'inactive' }])
    const handlers = buildCommandHandlers(ctx as unknown as CommandContext)

    const result = await handlers[Commands.RevertBuiltinToBundled]?.({
      pluginId,
    })

    expect(pluginHost.activate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, restartRequired: false })
  })
})
