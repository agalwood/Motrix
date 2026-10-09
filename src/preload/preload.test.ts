import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
} from '@shared/protocol/bridge'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcListener = (event: unknown, ...args: unknown[]) => void

const mocks = vi.hoisted(() => ({
  exposed: undefined as Window['motrix'] | undefined,
  invoke: vi.fn(),
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
    invoke: mocks.invoke,
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

describe('preload latest-value replay buffers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.exposed = undefined
    mocks.listeners.clear()
  })

  it('replays cold-start protocol navigation exactly once to the first subscriber', async () => {
    await import('./preload')
    emit(Events.NavigateTo, '/downloads/active')
    const callback = vi.fn()
    mocks.exposed?.on(Events.NavigateTo, callback)
    await Promise.resolve()
    expect(callback).toHaveBeenCalledExactlyOnceWith('/downloads/active')
    mocks.exposed?.off(Events.NavigateTo, callback)
    const remounted = vi.fn()
    mocks.exposed?.on(Events.NavigateTo, remounted)
    await Promise.resolve()
    expect(remounted).not.toHaveBeenCalled()
    emit(Events.NavigateTo, '/settings/about')
    expect(remounted).toHaveBeenCalledExactlyOnceWith('/settings/about')
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

  it('cancels queued cold-start replay when the subscriber unmounts', async () => {
    await import('./preload')
    emit(Events.NavigateTo, '/downloads/active')
    const callback = vi.fn()

    mocks.exposed?.on(Events.NavigateTo, callback)
    mocks.exposed?.off(Events.NavigateTo, callback)
    await Promise.resolve()
    emit(Events.NavigateTo, '/settings/about')

    expect(callback).not.toHaveBeenCalled()
  })

  it('replays only the latest window state before chrome subscribes', async () => {
    await import('./preload')
    emit(Events.WindowMaximizedChanged, {
      maximized: false,
      fullscreen: false,
    })
    emit(Events.WindowMaximizedChanged, {
      maximized: false,
      fullscreen: true,
    })

    const callback = vi.fn()
    mocks.exposed?.on(Events.WindowMaximizedChanged, callback)
    await Promise.resolve()

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({
      maximized: false,
      fullscreen: true,
    })
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

describe('preload IPC channel allowlist', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.exposed = undefined
    mocks.listeners.clear()
    await import('./preload')
  })

  it('forwards each declared invoke channel with its arguments and result intact', async () => {
    const channels = [
      ...Object.values(Commands),
      ...Object.values(Queries),
      ...Object.values(BridgeCommands),
      ...Object.values(BridgeQueries),
    ]

    mocks.invoke.mockImplementation(async (channel, ...args) => ({
      channel,
      args,
    }))
    for (const [index, channel] of channels.entries()) {
      await expect(
        mocks.exposed?.invoke(channel, { index }, 'argument')
      ).resolves.toEqual({ channel, args: [{ index }, 'argument'] })
    }

    expect(mocks.invoke.mock.calls).toEqual(
      channels.map((channel, index) => [channel, { index }, 'argument'])
    )
  })

  it('blocks undeclared invoke channels before Electron sees them', () => {
    expect(() => mocks.exposed?.invoke('command:notDeclared' as never)).toThrow(
      'undeclared IPC invoke channel'
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('propagates an invoke failure back to the renderer', async () => {
    const error = new Error('engine unavailable')
    mocks.invoke.mockRejectedValueOnce(error)

    await expect(mocks.exposed?.invoke(Queries.GetEngineStatus)).rejects.toBe(
      error
    )
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.GetEngineStatus
    )
  })

  it('delivers each declared event only to its subscriber and stops after off', () => {
    const channels = [...Object.values(Events), ...Object.values(BridgeEvents)]
    const callbacks = channels.map(() => vi.fn())

    for (const [index, channel] of channels.entries()) {
      mocks.exposed?.on(channel, callbacks[index])
    }

    for (const [index, channel] of channels.entries()) {
      emit(channel, { index }, 'event-payload')
    }
    for (const [index, channel] of channels.entries()) {
      expect(callbacks[index]).toHaveBeenCalledExactlyOnceWith(
        { index },
        'event-payload'
      )
      mocks.exposed?.off(channel, callbacks[index])
      emit(channel, 'after-unsubscribe')
      expect(callbacks[index]).toHaveBeenCalledOnce()
    }
  })

  it('allows valid plugin log channels and rejects malformed events', () => {
    const callback = vi.fn()

    mocks.exposed?.on(`${Events.PluginLog}:example.contract`, callback)
    expect(
      mocks.listeners.get(`${Events.PluginLog}:example.contract`)?.size
    ).toBe(1)

    expect(() =>
      mocks.exposed?.on('event:notDeclared' as never, callback)
    ).toThrow('undeclared IPC event channel')
    expect(() =>
      mocks.exposed?.on(`${Events.PluginLog}:not-namespaced` as never, callback)
    ).toThrow('undeclared IPC event channel')
  })
})
