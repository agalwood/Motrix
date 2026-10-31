import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { TaskKind, TaskStatus } from '@shared/types/task'
import { makeMediaProgress } from '@test-utils/media-progress'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  create: vi.fn(),
  progress: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('electron', () => ({
  BaseWindow: class {
    private destroyed = false
    constructor(options: unknown) {
      native.create(options)
    }
    setProgressBar = native.progress
    excludedFromShownWindowsMenu = false
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      native.destroy()
    }
  },
}))

import {
  getDownloadProgressValue,
  setupDownloadProgress,
} from './download-progress'

const download = (downloadedBytes = 25, totalBytes = 100) =>
  makeDownloadTask({ downloadedBytes, totalBytes })

describe('Dock download progress', () => {
  it('weights current downloads by bytes instead of averaging percentages', () => {
    expect(
      getDownloadProgressValue([download(50, 100), download(90, 900)])
    ).toBe(0.14)
  })

  it.each([
    TaskStatus.Queued,
    TaskStatus.MetadataReady,
    TaskStatus.Paused,
    TaskStatus.Completed,
    TaskStatus.Error,
    TaskStatus.Removed,
    TaskStatus.Seeding,
  ])('excludes %s tasks, even when their counters are nonzero', (status) => {
    const task = { ...download(900, 1000), status }
    expect(getDownloadProgressValue([task])).toBe(-1)
    expect(getDownloadProgressValue([task, download()])).toBe(0.25)
  })

  it('does not treat transient storage operations as downloads', () => {
    expect(
      getDownloadProgressValue([{ ...download(), storageOperation: true }])
    ).toBe(-1)
  })

  it('shows an empty bar for metadata or unknown sizes, never a full indeterminate bar', () => {
    expect(getDownloadProgressValue([download(100, 0)])).toBe(0)
    expect(
      getDownloadProgressValue([
        { ...download(100, 100), status: TaskStatus.FetchingMetadata },
      ])
    ).toBe(0)
    expect(getDownloadProgressValue([download(), download(100, 0)])).toBe(0.25)
  })

  it('keeps a not-quite-complete bar during finalization and media processing', () => {
    expect(
      getDownloadProgressValue([
        { ...download(100, 100), status: TaskStatus.Finalizing },
      ])
    ).toBe(0.99)
    expect(
      getDownloadProgressValue([
        makeDownloadTask({
          kind: TaskKind.Hls,
          mediaProgress: makeMediaProgress({
            phase: 'muxing',
            download: {
              progress: 1,
              completedParts: 10,
              totalParts: 10,
              totalBytes: null,
            },
            muxProgress: 0.1,
          }),
        }),
      ])
    ).toBe(0.99)
  })

  it('uses media segment progress when the final download size is unknown', () => {
    expect(
      getDownloadProgressValue([
        makeDownloadTask({
          kind: TaskKind.Hls,
          progress: 0,
          mediaProgress: makeMediaProgress({
            download: {
              progress: 0.4,
              completedParts: 4,
              totalParts: 10,
              totalBytes: null,
            },
          }),
        }),
      ])
    ).toBe(0.4)
  })

  it('bounds malformed counters and handles an empty task list', () => {
    expect(getDownloadProgressValue([])).toBe(-1)
    expect(getDownloadProgressValue([download(-10, 100)])).toBe(0)
    expect(getDownloadProgressValue([download(200, 100)])).toBe(0.99)
    expect(getDownloadProgressValue([download(Number.NaN, 100)])).toBe(0)
    expect(
      getDownloadProgressValue([download(10, Number.POSITIVE_INFINITY)])
    ).toBe(0)
  })
})

describe('Dock progress lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())

  function fixture(enabled = false, platform = 'darwin') {
    const eventBus = new EventBus()
    const state = { enabled, tasks: [download()] }
    const getTasks = vi.fn(() => state.tasks)
    const setTaskbarProgress = vi.fn()
    const dispose = setupDownloadProgress({
      eventBus,
      getTasks,
      setTaskbarProgress,
      isEnabled: () => state.enabled,
      platform,
    })
    return { eventBus, state, getTasks, setTaskbarProgress, dispose }
  }

  it('does no native work or task scanning until enabled, and applies settings immediately', () => {
    const f = fixture()
    f.eventBus.emit(Events.TaskUpdated)
    expect(f.getTasks).not.toHaveBeenCalled()
    expect(native.create).not.toHaveBeenCalled()
    f.state.enabled = true
    f.eventBus.emit(Events.SettingsChanged)
    expect(native.progress).toHaveBeenLastCalledWith(0.25)
    f.state.enabled = false
    f.eventBus.emit(Events.SettingsChanged)
    expect(native.progress).toHaveBeenLastCalledWith(-1)
    expect(native.destroy).toHaveBeenCalledOnce()
    f.dispose()
  })

  it('uses a hidden renderer-free window and skips unchanged native updates', () => {
    const f = fixture(true)
    expect(native.create).toHaveBeenCalledWith(
      expect.objectContaining({ show: false, focusable: false })
    )
    f.eventBus.emit(Events.TaskUpdated)
    f.eventBus.emit(Events.SettingsChanged)
    expect(native.progress).toHaveBeenCalledOnce()
    f.state.tasks = [download(60)]
    f.eventBus.emit(Events.TaskUpdated)
    expect(native.progress).toHaveBeenLastCalledWith(0.6)
    expect(native.create).toHaveBeenCalledOnce()
    f.dispose()
  })

  it.each([
    TaskStatus.Paused,
    TaskStatus.Completed,
    TaskStatus.Error,
    TaskStatus.Seeding,
  ])(
    'clears the native bar when the last transfer becomes %s and restores it on resume',
    (status) => {
      const f = fixture(true)
      f.state.tasks = [{ ...download(), status }]
      f.eventBus.emit(Events.TaskUpdated)
      expect(native.progress).toHaveBeenLastCalledWith(-1)
      expect(native.destroy).toHaveBeenCalledOnce()
      f.state.tasks = [download(50)]
      f.eventBus.emit(Events.TaskUpdated)
      expect(native.progress).toHaveBeenLastCalledWith(0.5)
      expect(native.create).toHaveBeenCalledTimes(2)
      f.dispose()
    }
  )

  it('clears and releases resources on shutdown and ignores subsequent events', () => {
    const f = fixture(true)
    f.dispose()
    f.dispose()
    expect(native.progress).toHaveBeenLastCalledWith(-1)
    expect(native.destroy).toHaveBeenCalledOnce()
    f.eventBus.emit(Events.TaskUpdated)
    f.eventBus.emit(Events.SettingsChanged)
    expect(native.create).toHaveBeenCalledOnce()
    expect(f.getTasks).toHaveBeenCalledOnce()
  })

  it('routes Windows progress to the main-window owner without creating a hidden window', () => {
    const f = fixture(false, 'win32')
    expect(f.getTasks).not.toHaveBeenCalled()
    expect(f.setTaskbarProgress).toHaveBeenLastCalledWith(-1)
    f.state.enabled = true
    f.eventBus.emit(Events.SettingsChanged)
    expect(f.setTaskbarProgress).toHaveBeenLastCalledWith(0.25)
    f.state.tasks = [download(70)]
    f.eventBus.emit(Events.TaskUpdated)
    expect(f.setTaskbarProgress).toHaveBeenLastCalledWith(0.7)
    f.state.tasks = []
    f.eventBus.emit(Events.TaskUpdated)
    expect(f.setTaskbarProgress).toHaveBeenLastCalledWith(-1)
    f.state.tasks = [download()]
    f.eventBus.emit(Events.TaskUpdated)
    f.state.enabled = false
    f.eventBus.emit(Events.SettingsChanged)
    expect(f.setTaskbarProgress).toHaveBeenLastCalledWith(-1)
    expect(native.create).not.toHaveBeenCalled()
    f.dispose()
    f.setTaskbarProgress.mockClear()
    f.eventBus.emit(Events.TaskUpdated)
    f.eventBus.emit(Events.SettingsChanged)
    expect(f.setTaskbarProgress).not.toHaveBeenCalled()
  })

  it.each(['linux', 'web'])(
    'does nothing on %s even with an imported enabled preference',
    (platform) => {
      const f = fixture(true, platform)
      f.eventBus.emit(Events.TaskUpdated)
      expect(f.getTasks).not.toHaveBeenCalled()
      expect(native.create).not.toHaveBeenCalled()
      expect(f.setTaskbarProgress).not.toHaveBeenCalled()
      f.dispose()
    }
  )
})
