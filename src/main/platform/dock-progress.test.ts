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

import { getDockProgress, setupDockProgress } from './dock-progress'

const download = (downloadedBytes = 25, totalBytes = 100) =>
  makeDownloadTask({ downloadedBytes, totalBytes })

describe('Dock download progress', () => {
  it('weights current downloads by bytes instead of averaging percentages', () => {
    expect(getDockProgress([download(50, 100), download(90, 900)])).toBe(0.14)
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
    expect(getDockProgress([task])).toBe(-1)
    expect(getDockProgress([task, download()])).toBe(0.25)
  })

  it('does not treat transient storage operations as downloads', () => {
    expect(getDockProgress([{ ...download(), storageOperation: true }])).toBe(
      -1
    )
  })

  it('shows an empty bar for metadata or unknown sizes, never a full indeterminate bar', () => {
    expect(getDockProgress([download(100, 0)])).toBe(0)
    expect(
      getDockProgress([
        { ...download(100, 100), status: TaskStatus.FetchingMetadata },
      ])
    ).toBe(0)
    expect(getDockProgress([download(), download(100, 0)])).toBe(0.25)
  })

  it('keeps a not-quite-complete bar during finalization and media processing', () => {
    expect(
      getDockProgress([
        { ...download(100, 100), status: TaskStatus.Finalizing },
      ])
    ).toBe(0.99)
    expect(
      getDockProgress([
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
      getDockProgress([
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
    expect(getDockProgress([])).toBe(-1)
    expect(getDockProgress([download(-10, 100)])).toBe(0)
    expect(getDockProgress([download(200, 100)])).toBe(0.99)
    expect(getDockProgress([download(Number.NaN, 100)])).toBe(0)
    expect(getDockProgress([download(10, Number.POSITIVE_INFINITY)])).toBe(0)
  })
})

describe('Dock progress lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())

  function fixture(enabled = false, platform = 'darwin') {
    const eventBus = new EventBus()
    const state = { enabled, tasks: [download()] }
    const getTasks = vi.fn(() => state.tasks)
    const dispose = setupDockProgress({
      eventBus,
      getTasks,
      isEnabled: () => state.enabled,
      platform,
    })
    return { eventBus, state, getTasks, dispose }
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

  it.each(['linux', 'win32'])(
    'does nothing on %s even with an imported enabled preference',
    (platform) => {
      const f = fixture(true, platform)
      f.eventBus.emit(Events.TaskUpdated)
      expect(f.getTasks).not.toHaveBeenCalled()
      expect(native.create).not.toHaveBeenCalled()
      f.dispose()
    }
  )
})
