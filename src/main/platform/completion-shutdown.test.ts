import { EventBus } from '@core/events/event-bus'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type DownloadTask,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dialog: vi.fn(),
  poweroff: vi.fn(async () => {}),
  probe: vi.fn(async () => {}),
  start: vi.fn(() => 42),
  stop: vi.fn(),
  monitorOn: vi.fn(),
  monitorOff: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('electron', () => ({
  dialog: { showMessageBox: mocks.dialog, showErrorBox: vi.fn() },
  ipcMain: { removeHandler: mocks.remove },
  powerSaveBlocker: { start: mocks.start, stop: mocks.stop },
  powerMonitor: { on: mocks.monitorOn, off: mocks.monitorOff },
}))
vi.mock('../ipc/trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown
  ) => mocks.handlers.set(channel, handler),
}))
vi.mock('./system-shutdown', () => ({
  createSystemShutdown: () => ({
    supported: true,
    probe: mocks.probe,
    requestShutdown: mocks.poweroff,
  }),
}))

import { setupCompletionShutdown } from './completion-shutdown'

describe('desktop completion shutdown wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.handlers.clear()
  })
  afterEach(() => vi.useRealTimers())

  function setup(
    overrides: Partial<Parameters<typeof setupCompletionShutdown>[0]> = {}
  ) {
    const eventBus = new EventBus()
    const parent = { isDestroyed: () => false } as BrowserWindow
    let tasks = [
      {
        id: 'one',
        status: TaskStatus.Downloading,
        transitionPhase: TransitionPhase.Idle,
      },
    ] as DownloadTask[]
    const broadcast = vi.fn()
    const dispose = setupCompletionShutdown({
      eventBus,
      getTasks: () => tasks,
      isReady: () => true,
      waitForReady: async () => {},
      prepare: () => ({
        drain: async () => {},
        hasIncomingWork: () => false,
        release: () => {},
      }),
      save: async () => {},
      broadcast,
      translate: (key) => key,
      logError: vi.fn(),
      getMainWindow: () => parent,
      showMainWindow: vi.fn(),
      ...overrides,
    })
    return {
      parent,
      dispose,
      broadcast,
      finish: () => {
        tasks = tasks.map((task) => ({ ...task, status: TaskStatus.Completed }))
        eventBus.emit(Events.TaskUpdated, tasks)
      },
      enable: () =>
        mocks.handlers.get(Commands.SetCompletionShutdown)?.(
          {},
          { enabled: true }
        ),
    }
  }

  it('enrolls restored active work before waiting for system authorization', async () => {
    const restored = Promise.withResolvers<void>()
    const authorized = Promise.withResolvers<void>()
    mocks.probe.mockReturnValueOnce(authorized.promise)
    mocks.dialog.mockImplementation(() => new Promise(() => {}))
    const f = setup({ waitForReady: () => restored.promise })
    const enabling = f.enable()
    restored.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.probe).toHaveBeenCalledOnce()
    f.finish()
    authorized.resolve()
    await enabling
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.poweroff).toHaveBeenCalledOnce()
    f.dispose()
  })

  it.each(['missing', 'destroyed', 'show-failure'])(
    'cancels when the window is %s',
    async (failure) => {
      const f = setup(
        failure === 'missing'
          ? { getMainWindow: () => null }
          : failure === 'destroyed'
            ? {
                getMainWindow: () =>
                  ({ isDestroyed: () => true }) as BrowserWindow,
              }
            : {
                showMainWindow: () => {
                  throw new Error('window failed')
                },
              }
      )
      await f.enable()
      f.finish()
      await vi.advanceTimersByTimeAsync(65_000)
      expect(mocks.poweroff).not.toHaveBeenCalled()
      expect(mocks.dialog).not.toHaveBeenCalled()
      f.dispose()
    }
  )

  it('publishes the initial snapshot, validates IPC, and uses a cancellable parented dialog', async () => {
    let close!: () => void
    mocks.dialog.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          close = resolve
        })
    )
    const f = setup()
    expect(f.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'off' })
    )
    expect(() =>
      mocks.handlers.get(Commands.SetCompletionShutdown)?.(
        {},
        { enabled: 'yes' }
      )
    ).toThrow()
    await f.enable()
    f.finish()
    expect(mocks.dialog).toHaveBeenCalledWith(
      f.parent,
      expect.objectContaining({ signal: expect.any(AbortSignal), cancelId: 0 })
    )
    close()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(mocks.poweroff).not.toHaveBeenCalled()
    expect(mocks.stop).toHaveBeenCalledWith(42)
    f.dispose()
    expect(mocks.remove).toHaveBeenCalledWith(Commands.SetCompletionShutdown)
    expect(mocks.remove).toHaveBeenCalledWith(Queries.GetCompletionShutdown)
  })

  it('closes the native countdown at the deadline without interpreting its abort as user cancellation', async () => {
    let signal!: AbortSignal
    mocks.dialog.mockImplementation(
      (_parent, options) =>
        new Promise<void>((resolve) => {
          signal = options.signal
          signal.addEventListener('abort', () => resolve())
        })
    )
    const f = setup()
    await f.enable()
    f.finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signal.aborted).toBe(true)
    expect(mocks.poweroff).toHaveBeenCalledOnce()
    f.dispose()
  })

  it('honors cancellation on the last second of the countdown', async () => {
    const dismissed = Promise.withResolvers<void>()
    mocks.dialog.mockReturnValueOnce(dismissed.promise)
    const f = setup()
    await f.enable()
    f.finish()
    await vi.advanceTimersByTimeAsync(59_000)
    dismissed.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.poweroff).not.toHaveBeenCalled()
    expect(f.broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'off' })
    )
    f.dispose()
  })

  it('ignores the late result from a dialog aborted by suspend/resume', async () => {
    const oldDialog = Promise.withResolvers<void>()
    const newDialog = Promise.withResolvers<void>()
    mocks.dialog
      .mockReturnValueOnce(oldDialog.promise)
      .mockReturnValueOnce(newDialog.promise)
    const f = setup()
    await f.enable()
    f.finish()
    await vi.advanceTimersByTimeAsync(59_000)
    const suspend = mocks.monitorOn.mock.calls.find(
      ([event]) => event === 'suspend'
    )?.[1]
    expect(suspend).toBeTypeOf('function')
    suspend()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.dialog).toHaveBeenCalledTimes(2)
    oldDialog.resolve()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(mocks.poweroff).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.poweroff).toHaveBeenCalledOnce()
    newDialog.resolve()
    f.dispose()
  })

  it.each(['reject', 'throw'])(
    'cancels the power action if its dialog fails with %s',
    async (failure) => {
      if (failure === 'reject')
        mocks.dialog.mockRejectedValue(new Error('dialog failed'))
      else
        mocks.dialog.mockImplementation(() => {
          throw new Error('dialog failed')
        })
      const f = setup()
      await f.enable()
      f.finish()
      await vi.advanceTimersByTimeAsync(65_000)
      expect(mocks.poweroff).not.toHaveBeenCalled()
      f.dispose()
    }
  )
})
