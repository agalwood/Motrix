import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginListDTO } from '@shared/types/plugin'
import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginMetadata } from './use-plugin-metadata'

type Listener = (...args: unknown[]) => void

const { listeners, transportMock } = vi.hoisted(() => {
  const listenerMap = new Map<string, Set<Listener>>()
  return {
    listeners: listenerMap,
    transportMock: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: Listener) => {
        let channelListeners = listenerMap.get(channel)
        if (!channelListeners) {
          channelListeners = new Set()
          listenerMap.set(channel, channelListeners)
        }
        channelListeners.add(listener)
      }),
      off: vi.fn((channel: string, listener: Listener) => {
        listenerMap.get(channel)?.delete(listener)
      }),
      platform: 'darwin' as const,
    },
  }
})

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

const PLUGINS: PluginListDTO[] = [
  {
    id: 'plugin.one',
    name: 'Plugin One',
    version: '1.0.0',
    description: 'First plugin',
    status: 'active',
    enabled: true,
    permissions: ['notify'],
    optionalPermissions: [],
    errorCount: 0,
  },
]

const REFRESHED_PLUGINS: PluginListDTO[] = [
  ...PLUGINS,
  {
    id: 'plugin.two',
    name: 'Plugin Two',
    version: '2.0.0',
    description: 'Second plugin',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: ['http'],
    errorCount: 0,
  },
]

const STATUS_CHANGED_PLUGINS: PluginListDTO[] = [
  {
    id: 'plugin.one',
    name: 'Plugin One',
    version: '1.0.0',
    description: 'First plugin',
    status: 'error',
    enabled: false,
    permissions: ['notify'],
    optionalPermissions: [],
    errorCount: 1,
    lastError: 'activation failed',
  },
]

const LATEST_PLUGINS: PluginListDTO[] = [
  ...STATUS_CHANGED_PLUGINS,
  {
    id: 'plugin.two',
    name: 'Plugin Two',
    version: '2.0.0',
    description: 'Second plugin',
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: ['http'],
    errorCount: 0,
  },
]

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

function emit(channel: string, ...args: unknown[]) {
  listeners.get(channel)?.forEach((listener) => {
    listener(...args)
  })
}

describe('usePluginMetadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listeners.clear()
    transportMock.invoke.mockReset()
    transportMock.on.mockClear()
    transportMock.off.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('moves from idle through loading to delayed ListPlugins success', async () => {
    const request = deferred<PluginListDTO[]>()
    transportMock.invoke.mockReturnValue(request.promise)
    const observedStatuses: string[] = []
    const { result } = renderHook(() => {
      const state = usePluginMetadata()
      observedStatuses.push(state.status)
      return state
    })

    expect(observedStatuses).toEqual(
      expect.arrayContaining(['idle', 'loading'])
    )
    expect(result.current).toMatchObject({
      data: null,
      status: 'loading',
      error: null,
      isRefreshing: false,
    })
    expect(transportMock.invoke).toHaveBeenCalledWith(Queries.ListPlugins)

    await act(async () => {
      request.resolve(PLUGINS)
      await request.promise
    })
    expect(result.current).toMatchObject({
      data: PLUGINS,
      status: 'success',
      error: null,
      isRefreshing: false,
    })
  })

  it('normalizes rejection and succeeds when retried', async () => {
    transportMock.invoke
      .mockRejectedValueOnce(17)
      .mockResolvedValueOnce(PLUGINS)
    const { result } = renderHook(() => usePluginMetadata())

    await act(flushMicrotasks)
    expect(result.current).toMatchObject({
      data: null,
      status: 'error',
      error: {
        code: 'PLUGIN_METADATA_LOAD_FAILED',
        message: 'Plugin metadata request failed',
      },
      isRefreshing: false,
    })

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current).toMatchObject({
      data: PLUGINS,
      status: 'success',
      error: null,
    })
  })

  it('retains prior metadata while refresh is in flight', async () => {
    transportMock.invoke.mockResolvedValueOnce(PLUGINS)
    const { result } = renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    const refreshRequest = deferred<PluginListDTO[]>()
    transportMock.invoke.mockReturnValueOnce(refreshRequest.promise)
    act(() => {
      void result.current.refresh()
    })
    expect(result.current).toMatchObject({
      data: PLUGINS,
      status: 'success',
      isRefreshing: true,
    })

    await act(async () => {
      refreshRequest.resolve(REFRESHED_PLUGINS)
      await refreshRequest.promise
    })
    expect(result.current).toMatchObject({
      data: REFRESHED_PLUGINS,
      status: 'success',
      isRefreshing: false,
    })
  })

  it('shares one in-flight ListPlugins request', async () => {
    transportMock.invoke.mockResolvedValueOnce(PLUGINS)
    const { result } = renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    const refreshRequest = deferred<PluginListDTO[]>()
    transportMock.invoke.mockReturnValueOnce(refreshRequest.promise)
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.refresh()
      second = result.current.refresh()
    })

    expect(second).toBe(first)
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    await act(async () => {
      refreshRequest.resolve(REFRESHED_PLUGINS)
      await first
    })
    expect(result.current.data).toEqual(REFRESHED_PLUGINS)
  })

  it('trails an initial load when status and install events arrive', async () => {
    const initialRequest = deferred<PluginListDTO[]>()
    const trailingRequest = deferred<PluginListDTO[]>()
    transportMock.invoke
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(trailingRequest.promise)
    const { result } = renderHook(() => usePluginMetadata())

    act(() => {
      emit(Events.PluginStatusChanged, {
        pluginId: 'plugin.one',
        status: 'error',
        enabled: false,
        lastError: 'activation failed',
      })
      emit(Events.PluginInstalled)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      initialRequest.resolve(PLUGINS)
      await initialRequest.promise
      await flushMicrotasks()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      trailingRequest.resolve(LATEST_PLUGINS)
      await trailingRequest.promise
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)
    expect(result.current.data).toEqual(LATEST_PLUGINS)
  })

  it('restores a visible status patch after an older refresh settles', async () => {
    transportMock.invoke.mockResolvedValueOnce(PLUGINS)
    const { result } = renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    const staleRefresh = deferred<PluginListDTO[]>()
    const trailingRequest = deferred<PluginListDTO[]>()
    transportMock.invoke
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(trailingRequest.promise)
    act(() => {
      void result.current.refresh()
      emit(Events.PluginStatusChanged, {
        pluginId: 'plugin.one',
        status: 'error',
        enabled: false,
        lastError: 'activation failed',
      })
    })
    expect(result.current.data?.[0]).toMatchObject({
      status: 'error',
      enabled: false,
      lastError: 'activation failed',
    })

    await act(async () => {
      staleRefresh.resolve(PLUGINS)
      await staleRefresh.promise
      await flushMicrotasks()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)

    await act(async () => {
      trailingRequest.resolve(STATUS_CHANGED_PLUGINS)
      await trailingRequest.promise
    })
    expect(result.current.data).toEqual(STATUS_CHANGED_PLUGINS)
  })

  it('coalesces an event storm into one trailing request', async () => {
    transportMock.invoke.mockResolvedValueOnce(PLUGINS)
    const { result } = renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    const staleRefresh = deferred<PluginListDTO[]>()
    const trailingRequest = deferred<PluginListDTO[]>()
    transportMock.invoke
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(trailingRequest.promise)
    act(() => {
      void result.current.refresh()
      emit(Events.PluginStatusChanged, {
        pluginId: 'plugin.one',
        status: 'error',
      })
      emit(Events.PluginInstalled)
      emit(Events.PluginUninstalled)
      emit(Events.LocaleChanged, { language: 'zh-CN' })
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      staleRefresh.resolve(PLUGINS)
      await staleRefresh.promise
      await flushMicrotasks()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)

    await act(flushMicrotasks)
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)

    await act(async () => {
      trailingRequest.resolve(LATEST_PLUGINS)
      await trailingRequest.promise
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(3)
    expect(result.current.data).toEqual(LATEST_PLUGINS)
  })

  it('does not trail a dirty request after unmount', async () => {
    const initialRequest = deferred<PluginListDTO[]>()
    transportMock.invoke.mockReturnValue(initialRequest.promise)
    const { unmount } = renderHook(() => usePluginMetadata())
    act(() => {
      emit(Events.PluginInstalled)
      emit(Events.PluginUninstalled)
    })

    unmount()
    await act(async () => {
      initialRequest.resolve(PLUGINS)
      await initialRequest.promise
      await flushMicrotasks()
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale StrictMode request overwrite newer metadata', async () => {
    const staleRequest = deferred<PluginListDTO[]>()
    const currentRequest = deferred<PluginListDTO[]>()
    transportMock.invoke
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    const { result } = renderHook(() => usePluginMetadata(), {
      wrapper: StrictMode,
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      currentRequest.resolve(REFRESHED_PLUGINS)
      await currentRequest.promise
    })
    expect(result.current.data).toEqual(REFRESHED_PLUGINS)

    await act(async () => {
      staleRequest.resolve(PLUGINS)
      await staleRequest.promise
    })
    expect(result.current.data).toEqual(REFRESHED_PLUGINS)
  })

  it('patches status events and refreshes on lifecycle and locale events', async () => {
    transportMock.invoke.mockResolvedValueOnce(PLUGINS)
    const { result } = renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    transportMock.invoke.mockResolvedValueOnce(STATUS_CHANGED_PLUGINS)
    act(() => {
      emit(Events.PluginStatusChanged, {
        pluginId: 'plugin.one',
        status: 'error',
        enabled: false,
        lastError: 'activation failed',
      })
    })
    expect(result.current.data?.[0]).toMatchObject({
      id: 'plugin.one',
      status: 'error',
      enabled: false,
      lastError: 'activation failed',
    })
    await act(flushMicrotasks)
    expect(transportMock.invoke).toHaveBeenCalledTimes(2)

    for (const channel of [
      Events.PluginInstalled,
      Events.PluginUninstalled,
      Events.LocaleChanged,
    ]) {
      transportMock.invoke.mockResolvedValueOnce(REFRESHED_PLUGINS)
      await act(async () => {
        emit(channel)
        await flushMicrotasks()
      })
    }

    expect(transportMock.invoke).toHaveBeenCalledTimes(5)
    expect(result.current.data).toEqual(REFRESHED_PLUGINS)
  })

  it('uses no grants queries and has no polling timer', async () => {
    transportMock.invoke.mockResolvedValue(PLUGINS)
    renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    })
    expect(transportMock.invoke).toHaveBeenCalledTimes(1)
    const invokedChannels = transportMock.invoke.mock.calls.map(
      ([channel]) => channel
    )
    expect(invokedChannels).not.toContain(Queries.ListPluginGrants)
    expect(invokedChannels).not.toContain(Queries.GetPluginGrants)
  })

  it('removes every event listener on unmount', async () => {
    transportMock.invoke.mockResolvedValue(PLUGINS)
    const { unmount } = renderHook(() => usePluginMetadata())
    await act(flushMicrotasks)

    const expectedChannels = [
      Events.PluginStatusChanged,
      Events.PluginInstalled,
      Events.PluginUninstalled,
      Events.LocaleChanged,
    ]
    expect(transportMock.on.mock.calls.map(([channel]) => channel)).toEqual(
      expectedChannels
    )

    unmount()
    expect(transportMock.off.mock.calls.map(([channel]) => channel)).toEqual(
      expectedChannels
    )
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
  })

  it('does not update state after unmount', async () => {
    const request = deferred<PluginListDTO[]>()
    transportMock.invoke.mockReturnValue(request.promise)
    const observedStatuses: string[] = []
    const { unmount } = renderHook(() => {
      const state = usePluginMetadata()
      observedStatuses.push(state.status)
      return state
    })
    const renderCountBeforeUnmount = observedStatuses.length

    unmount()
    await act(async () => {
      request.resolve(PLUGINS)
      await request.promise
    })
    expect(observedStatuses).toHaveLength(renderCountBeforeUnmount)
  })
})
