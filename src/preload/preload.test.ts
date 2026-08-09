import { Events } from '@shared/protocol/events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcListener = (event: unknown, ...args: unknown[]) => void

const mocks = vi.hoisted(() => ({
  exposed: undefined as Window['motrix'] | undefined,
  listeners: new Map<string, Set<IpcListener>>(),
  on: vi.fn((channel: string, listener: IpcListener) => {
    let channelListeners = mocks.listeners.get(channel)
    if (!channelListeners) {
      channelListeners = new Set()
      mocks.listeners.set(channel, channelListeners)
    }
    channelListeners.add(listener)
  }),
  removeListener: vi.fn((channel: string, listener: IpcListener) => {
    mocks.listeners.get(channel)?.delete(listener)
  }),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_key: string, api: Window['motrix']) => {
      mocks.exposed = api
    }),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
  webUtils: {
    getPathForFile: vi.fn(),
  },
}))

function emit(channel: string, ...args: unknown[]): void {
  for (const listener of [...(mocks.listeners.get(channel) ?? [])]) {
    listener({}, ...args)
  }
}

describe('preload locale replay buffer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.exposed = undefined
    mocks.listeners.clear()
  })

  it('replays only the latest locale change before the renderer subscribes', async () => {
    await import('./preload')
    emit(Events.LocaleChanged, { language: 'zh-CN' })
    emit(Events.LocaleChanged, { language: 'en-US' })

    const callback = vi.fn()
    mocks.exposed?.on(Events.LocaleChanged, callback)
    await Promise.resolve()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenLastCalledWith({ language: 'en-US' })

    emit(Events.LocaleChanged, { language: 'zh-CN' })
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenLastCalledWith({ language: 'zh-CN' })
  })

  it('does not replay an older locale after an immediate live event', async () => {
    await import('./preload')
    emit(Events.LocaleChanged, { language: 'zh-CN' })

    const callback = vi.fn()
    mocks.exposed?.on(Events.LocaleChanged, callback)
    emit(Events.LocaleChanged, { language: 'en-US' })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenLastCalledWith({ language: 'en-US' })
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
  })
})

describe('preload wrapperMap (F10: same callback on two channels)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.exposed = undefined
    mocks.listeners.clear()
  })

  it("off() on channel A removes only channel A's own wrapper, leaving channel B's real listener intact", async () => {
    await import('./preload')
    const callback = vi.fn()
    // Neither channel is in BUFFERED_CHANNELS, so this exercises the plain
    // on()/off() path with no eager-replay interaction.
    const channelA = Events.NotificationAdded
    const channelB = Events.NotificationsChanged

    mocks.exposed?.on(channelA, callback)
    mocks.exposed?.on(channelB, callback)

    expect(mocks.listeners.get(channelA)?.size).toBe(1)
    expect(mocks.listeners.get(channelB)?.size).toBe(1)

    mocks.exposed?.off(channelA, callback)

    // The old single-level `WeakMap<Callback, CallbackSubscription>` would
    // have looked up channel B's wrapper here and called
    // `removeListener(channelA, thatWrapper)` — a no-op, since the real
    // ipcRenderer listener for channel A is a DIFFERENT function
    // reference. This asserts the real listener is actually gone.
    expect(mocks.removeListener).toHaveBeenCalledTimes(1)
    expect(mocks.listeners.get(channelA)?.size).toBe(0)
    expect(mocks.listeners.get(channelB)?.size).toBe(1)

    // Channel B must still be live — the old bug's second symptom was that
    // deleting the only wrapperMap entry after the first off() also lost
    // track of channel B's subscription.
    emit(channelB, 'still-alive')
    expect(callback).toHaveBeenCalledWith('still-alive')

    mocks.exposed?.off(channelB, callback)
    expect(mocks.removeListener).toHaveBeenCalledTimes(2)
    expect(mocks.listeners.get(channelA)?.size).toBe(0)
    expect(mocks.listeners.get(channelB)?.size).toBe(0)
  })
})
