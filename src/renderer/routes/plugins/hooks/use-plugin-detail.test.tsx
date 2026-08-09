import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginDetail } from './use-plugin-detail'

type Listener = (...args: unknown[]) => void

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

function emit(channel: string, payload: unknown) {
  for (const listener of listeners.get(channel) ?? []) listener(payload)
}

describe('usePluginDetail', () => {
  // Mutable backing state the mocked GetPluginManifest reads, so a refetch
  // observes a new version the same way main does after a builtin update
  // hot-swap re-runs discover().
  let manifestVersion: string

  beforeEach(() => {
    listeners.clear()
    manifestVersion = '1.0.1'
    transportMock.invoke.mockReset()
    transportMock.invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetPluginManifest) {
        return Promise.resolve({ id: 'test.demo', version: manifestVersion })
      }
      return Promise.resolve({})
    })
  })

  it('refetches the manifest when the plugin is (re)installed', async () => {
    const { result } = renderHook(() => usePluginDetail('test.demo'))
    await waitFor(() => expect(result.current?.manifest.version).toBe('1.0.1'))

    // A builtin update commit emits PluginInstalled after hot-swap; the
    // detail snapshot must follow to the new effective manifest.
    manifestVersion = '1.1.1'
    act(() => {
      emit(Events.PluginInstalled, { pluginId: 'test.demo' })
    })

    await waitFor(() => expect(result.current?.manifest.version).toBe('1.1.1'))
  })

  it('ignores install events for other plugins', async () => {
    const { result } = renderHook(() => usePluginDetail('test.demo'))
    await waitFor(() => expect(result.current?.manifest.version).toBe('1.0.1'))
    const callsAfterMount = transportMock.invoke.mock.calls.length

    act(() => {
      emit(Events.PluginInstalled, { pluginId: 'other.plugin' })
    })

    expect(transportMock.invoke.mock.calls.length).toBe(callsAfterMount)
    expect(result.current?.manifest.version).toBe('1.0.1')
  })

  it('refetches the localized manifest on the unified locale event', async () => {
    const { result } = renderHook(() => usePluginDetail('test.demo'))
    await waitFor(() => expect(result.current?.manifest.version).toBe('1.0.1'))
    const callsAfterMount = transportMock.invoke.mock.calls.length

    act(() => {
      emit(Events.LocaleChanged, { language: 'zh-CN' })
    })

    await waitFor(() =>
      expect(transportMock.invoke.mock.calls.length).toBeGreaterThan(
        callsAfterMount
      )
    )
  })

  it('drops an in-flight old-locale snapshot before replaying the refresh', async () => {
    const releaseOldSettings = deferred<unknown>()
    const releaseNewManifest = deferred<unknown>()
    let manifestRequests = 0
    let settingsRequests = 0
    transportMock.invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetPluginManifest) {
        manifestRequests += 1
        return manifestRequests === 1
          ? Promise.resolve({ id: 'test.demo', version: 'old-locale' })
          : releaseNewManifest.promise
      }
      if (channel === Queries.GetSettings) {
        settingsRequests += 1
        return settingsRequests === 1
          ? releaseOldSettings.promise
          : Promise.resolve({})
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => usePluginDetail('test.demo'))
    await waitFor(() => expect(manifestRequests).toBe(1))

    act(() => {
      emit(Events.LocaleChanged, { language: 'zh-CN' })
    })
    expect(manifestRequests).toBe(1)

    await act(async () => {
      releaseOldSettings.resolve({})
      await releaseOldSettings.promise
    })
    await waitFor(() => expect(manifestRequests).toBe(2))

    // The invalidated result is never published while the new-locale request
    // is still pending.
    expect(result.current).toBeNull()

    await act(async () => {
      releaseNewManifest.resolve({ id: 'test.demo', version: 'new-locale' })
      await releaseNewManifest.promise
    })
    await waitFor(() =>
      expect(result.current?.manifest.version).toBe('new-locale')
    )
  })
})
