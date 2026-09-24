import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import type {
  MagnetFileSelectionPayload,
  TaskCreateCommandResult,
  TaskCreateRequest,
} from '@shared/schemas/add-task'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import {
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MagnetSelectionTimeout } from './magnet-selection-timeout'

function selection(taskId = 'magnet-1'): MagnetFileSelectionPayload {
  return {
    taskId,
    magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    torrentBase64: 'dG9ycmVudA==',
    saveDir: '/downloads',
    meta: {
      name: 'demo',
      infoHash: 'a'.repeat(40),
      totalSize: 30,
      files: [
        { index: 0, path: 'demo/a', size: 10, extension: '' },
        { index: 2, path: 'demo/b', size: 20, extension: '' },
      ],
    },
  }
}

function fixture() {
  const bus = new EventBus()
  let settings = {
    ...DEFAULT_APP_SETTINGS,
    magnetFileSelectionAutoDownload: true,
  }
  let tasks = [
    makeDownloadTask({
      id: 'magnet-1',
      name: 'demo',
      type: TaskType.Magnet,
      status: TaskStatus.MetadataReady,
      updatedAt: Date.now(),
    }),
  ]
  let engineReady = true
  const getSelection = vi.fn(async (taskId: string) => selection(taskId))
  const createTask = vi.fn(
    async (_request: TaskCreateRequest): Promise<TaskCreateCommandResult> => {
      tasks[0] = { ...tasks[0], status: TaskStatus.Downloading }
      bus.emit(Events.TaskUpdated)
      return { outcome: 'created', taskId: 'magnet-1', gid: 'bt-gid' }
    }
  )
  const notify = vi.fn()
  const settled = vi.fn()
  bus.on(Events.MagnetFileSelectionSettled, settled)
  const service = new MagnetSelectionTimeout({
    eventBus: bus,
    getSettings: () => settings,
    getTasks: () => tasks,
    isEngineReady: () => engineReady,
    getSelection,
    createTask,
    notify,
    log: { warn: vi.fn() },
  })
  services.push(service)
  return {
    bus,
    service,
    getSelection,
    createTask,
    notify,
    settled,
    get tasks() {
      return tasks
    },
    set tasks(value) {
      tasks = value
      bus.emit(Events.TaskUpdated)
    },
    get settings() {
      return settings
    },
    set settings(value) {
      settings = value
      bus.emit(Events.SettingsChanged)
    },
    set engineReady(value: boolean) {
      engineReady = value
      bus.emit(Events.EngineStateChanged)
    },
  }
}

const services: MagnetSelectionTimeout[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stopAndDrain()))
  vi.useRealTimers()
})

describe('MagnetSelectionTimeout', () => {
  it('starts all files once at the deadline without a renderer', async () => {
    const f = fixture()
    f.service.start()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.createTask).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.createTask).toHaveBeenCalledExactlyOnceWith({
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: selection().torrentBase64 },
      selectedFiles: [0, 2],
      saveDir: '/downloads',
      displayName: 'demo',
      existingTaskId: 'magnet-1',
    })
    expect(f.settled).toHaveBeenCalledWith({
      taskId: 'magnet-1',
      downloadTaskId: 'magnet-1',
    })
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'info' })
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.createTask).toHaveBeenCalledTimes(1)
  })

  it.each(['magnetFileSelection', 'magnetFileSelectionAutoDownload'] as const)(
    'does nothing with %s disabled',
    async (field) => {
      const f = fixture()
      f.settings = { ...f.settings, [field]: false }
      f.service.start()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.getSelection).not.toHaveBeenCalled()
    }
  )

  it('starts the countdown when metadata becomes ready, not when a magnet is added', async () => {
    const f = fixture()
    f.tasks = [{ ...f.tasks[0], status: TaskStatus.FetchingMetadata }]
    f.service.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.createTask).not.toHaveBeenCalled()
    f.tasks = [
      {
        ...f.tasks[0],
        status: TaskStatus.MetadataReady,
        updatedAt: Date.now(),
      },
    ]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.createTask).toHaveBeenCalledTimes(1)
  })

  it('preserves elapsed waiting time on restore even if the task timestamp changed', async () => {
    const f = fixture()
    f.tasks[0].instances = [
      {
        instanceId: 'metadata-1',
        motrixId: 'magnet-1',
        phase: TaskInstancePhase.MagnetMetadataResolution,
        payload: { fileSelectionReadyAt: Date.now() - 50_000 },
        gid: null,
        status: TaskStatus.MetadataReady,
        progress: 1,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '',
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        createdAt: 0,
        updatedAt: Date.now(),
      },
    ]
    f.service.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.createTask).toHaveBeenCalledTimes(1)
  })

  it('cancels the countdown when disabled and applies a changed deadline', async () => {
    const f = fixture()
    f.service.start()
    await vi.advanceTimersByTimeAsync(30_000)
    f.settings = { ...f.settings, magnetFileSelectionAutoDownload: false }
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.createTask).not.toHaveBeenCalled()
    f.settings = {
      ...f.settings,
      magnetFileSelectionAutoDownload: true,
      magnetFileSelectionTimeoutSeconds: 90,
    }
    await vi.advanceTimersByTimeAsync(19_999)
    expect(f.createTask).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.createTask).toHaveBeenCalledTimes(1)
  })

  it.each([
    'confirmed',
    'removed',
    'disabled',
    'extended',
    'engine-down',
    'stopped',
  ])('rechecks %s during metadata IO', async (change) => {
    const f = fixture()
    const pending = Promise.withResolvers<MagnetFileSelectionPayload>()
    f.getSelection.mockReturnValueOnce(pending.promise)
    f.service.start()
    await vi.advanceTimersByTimeAsync(60_000)
    if (change === 'confirmed')
      f.tasks = [{ ...f.tasks[0], status: TaskStatus.Downloading }]
    if (change === 'removed') f.tasks = []
    if (change === 'disabled')
      f.settings = { ...f.settings, magnetFileSelectionAutoDownload: false }
    if (change === 'extended')
      f.settings = { ...f.settings, magnetFileSelectionTimeoutSeconds: 120 }
    if (change === 'engine-down') f.engineReady = false
    if (change === 'stopped') void f.service.stopAndDrain()
    pending.resolve(selection())
    await vi.advanceTimersByTimeAsync(0)
    expect(f.createTask).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('waits for engine recovery when the deadline expires offline', async () => {
    const f = fixture()
    f.engineReady = false
    f.service.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.getSelection).not.toHaveBeenCalled()
    f.engineReady = true
    await vi.advanceTimersByTimeAsync(1)
    expect(f.createTask).toHaveBeenCalledTimes(1)
  })

  it('leaves a failed selection available for manual retry without a hot loop', async () => {
    const f = fixture()
    f.getSelection.mockRejectedValue(new Error('Torrent file missing'))
    f.service.start()
    await vi.advanceTimersByTimeAsync(180_000)
    f.bus.emit(Events.TaskUpdated)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.getSelection).toHaveBeenCalledTimes(1)
    expect(f.createTask).not.toHaveBeenCalled()
    expect(f.tasks[0].status).toBe(TaskStatus.MetadataReady)
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ severity: 'warning' })
    )
    expect(f.settled).not.toHaveBeenCalled()
  })

  it('keeps duplicate conflicts pending for an explicit user decision', async () => {
    const f = fixture()
    f.createTask.mockResolvedValue({
      outcome: 'conflict',
      conflict: {
        reason: 'existing-files',
        infoHash: 'a'.repeat(40),
        targetDir: '/downloads/demo',
        existingTaskId: null,
        existingTaskName: null,
        existingTaskStatus: null,
        canCreateCopy: true,
      },
    })
    f.service.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.createTask).toHaveBeenCalledTimes(1)
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning' })
    )
    expect(f.settled).not.toHaveBeenCalled()
  })

  it('ignores a stale rejection when a manual selection wins the task mutation lock', async () => {
    const f = fixture()
    f.createTask.mockImplementation(async () => {
      f.tasks = [{ ...f.tasks[0], status: TaskStatus.Downloading }]
      throw new Error('Task is no longer awaiting selection')
    })
    f.service.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('advances multiple ready tasks once each, even when one metadata read is delayed', async () => {
    const f = fixture()
    f.tasks = [f.tasks[0], { ...f.tasks[0], id: 'magnet-2' }]
    const pending = Promise.withResolvers<MagnetFileSelectionPayload>()
    f.getSelection.mockReturnValueOnce(pending.promise)
    f.createTask.mockImplementation(async (request) => {
      const taskId = request.type === 'bt' ? request.existingTaskId : undefined
      if (!taskId) throw new Error('Expected an existing magnet task')
      f.tasks = f.tasks.map((task) =>
        task.id === taskId ? { ...task, status: TaskStatus.Downloading } : task
      )
      return { outcome: 'created', taskId, gid: `bt-${taskId}` }
    })
    f.service.start()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(f.createTask).toHaveBeenCalledTimes(1)
    expect(f.tasks[1].status).toBe(TaskStatus.Downloading)
    pending.resolve(selection())
    await vi.advanceTimersByTimeAsync(1)
    expect(f.createTask).toHaveBeenCalledTimes(2)
    expect(f.tasks[0].status).toBe(TaskStatus.Downloading)
  })

  it('drains an accepted download before shutdown completes', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<TaskCreateCommandResult>()
    f.createTask.mockReturnValueOnce(pending.promise)
    f.service.start()
    await vi.advanceTimersByTimeAsync(60_000)
    let drained = false
    const shutdown = f.service.stopAndDrain().then(() => {
      drained = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)
    pending.resolve({ outcome: 'created', taskId: 'magnet-1', gid: 'bt-gid' })
    await shutdown
    expect(drained).toBe(true)
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.settled).not.toHaveBeenCalled()
  })
})
