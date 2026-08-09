import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { PluginListDTO } from '@shared/types/plugin'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginsStore } from '../store'
import { usePlugins } from './use-plugins'

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

function emit(channel: string, payload: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener(payload)
}

function plugin(name: string): PluginListDTO {
  return {
    id: 'test.demo',
    name,
    version: '1.0.0',
    description: name,
    status: 'inactive',
    enabled: true,
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
  }
}

describe('usePlugins', () => {
  beforeEach(() => {
    listeners.clear()
    vi.clearAllMocks()
    usePluginsStore.setState({ list: [], grants: {}, loaded: false })
  })

  it('drops an in-flight old-locale list before replaying the refresh', async () => {
    const releaseOldList = deferred<unknown>()
    const releaseNewList = deferred<unknown>()
    let listRequests = 0
    transportMock.invoke.mockImplementation((channel: string) => {
      if (channel === Queries.ListPlugins) {
        listRequests += 1
        return listRequests === 1
          ? releaseOldList.promise
          : releaseNewList.promise
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(listRequests).toBe(1))

    act(() => {
      emit(Events.LocaleChanged, { language: 'zh-CN' })
    })
    expect(listRequests).toBe(1)

    await act(async () => {
      releaseOldList.resolve([plugin('Old locale')])
      await releaseOldList.promise
    })
    await waitFor(() => expect(listRequests).toBe(2))

    // The stale list is never committed while the new-locale request waits.
    expect(result.current).toEqual([])
    expect(usePluginsStore.getState().list).toEqual([])

    await act(async () => {
      releaseNewList.resolve([plugin('New locale')])
      await releaseNewList.promise
    })
    await waitFor(() => expect(result.current[0]?.name).toBe('New locale'))
  })
})
