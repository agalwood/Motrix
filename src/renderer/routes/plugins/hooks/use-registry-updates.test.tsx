import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
}))

import { usePluginsStore } from '../store'
import { useRegistryUpdates } from './use-registry'

const UPDATES = [
  {
    pluginId: 'acme.speed-boost',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    channel: 'community',
  },
]

const MIXED_UPDATES = [
  ...UPDATES,
  {
    pluginId: 'motrix.scraper-hook',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    channel: 'builtin',
  },
]

describe('useRegistryUpdates', () => {
  beforeEach(() => {
    usePluginsStore.setState({
      updates: {},
      registry: [],
      registryStatus: null,
    })
    mockInvoke.mockReset()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Commands.CheckPluginUpdates) {
        return Promise.resolve(UPDATES)
      }
      if (channel === Queries.ListRegistryPlugins) {
        return Promise.resolve([])
      }
      return Promise.resolve(undefined)
    })
  })

  it('exposes cached refresh errors and clears them after recovery', async () => {
    let status = {
      cached: true,
      lastSuccessAt: 123,
      error: {
        reason: 'timeout',
        route: 'proxy',
        targetHost: 'dl.motrix.app',
        proxyEndpoint: '127.0.0.1:7897',
      } as unknown,
    }
    const original = mockInvoke.getMockImplementation()
    mockInvoke.mockImplementation((channel: string) =>
      channel === Queries.GetRegistryStatus
        ? Promise.resolve(status)
        : original?.(channel)
    )
    const { result } = renderHook(() => useRegistryUpdates(true))
    await act(async () => {
      await Promise.resolve()
    })
    expect(usePluginsStore.getState().registryStatus?.error?.reason).toBe(
      'timeout'
    )
    status = { ...status, error: null }
    await act(async () => result.current.refresh())
    expect(usePluginsStore.getState().registryStatus?.error).toBeNull()
  })

  it('never invokes CheckPluginUpdates when enabled=false, even via refresh()', async () => {
    const { result } = renderHook(() => useRegistryUpdates(false))

    expect(mockInvoke).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.refresh()
    })

    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('invokes CheckPluginUpdates with {} on mount when enabled=true and stores updates', async () => {
    const { result } = renderHook(() => useRegistryUpdates(true))

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(mockInvoke).toHaveBeenCalledWith(Queries.GetRegistryStatus)
    expect(mockInvoke).toHaveBeenCalledWith(Commands.CheckPluginUpdates, {})
    expect(usePluginsStore.getState().updates).toEqual({
      'acme.speed-boost': { latestVersion: '1.1.0', channel: 'community' },
    })
    expect(result.current.refreshing).toBe(false)
  })

  it('refresh() force-refetches updates and the registry list', async () => {
    const { result } = renderHook(() => useRegistryUpdates(true))
    await act(async () => {
      await Promise.resolve()
    })
    mockInvoke.mockClear()

    await act(async () => {
      await result.current.refresh()
    })

    expect(mockInvoke).toHaveBeenCalledWith(Commands.CheckPluginUpdates, {
      force: true,
    })
    expect(mockInvoke).toHaveBeenCalledWith(Queries.ListRegistryPlugins)
    expect(usePluginsStore.getState().updates).toEqual({
      'acme.speed-boost': { latestVersion: '1.1.0', channel: 'community' },
    })
    expect(usePluginsStore.getState().registry).toEqual([])
    expect(result.current.refreshing).toBe(false)
  })

  it('carries a channel:builtin entry through the toUpdatesMap round-trip', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Commands.CheckPluginUpdates) {
        return Promise.resolve(MIXED_UPDATES)
      }
      if (channel === Queries.ListRegistryPlugins) {
        return Promise.resolve([])
      }
      return Promise.resolve(undefined)
    })

    renderHook(() => useRegistryUpdates(true))

    await act(async () => {
      await Promise.resolve()
    })

    expect(usePluginsStore.getState().updates).toEqual({
      'acme.speed-boost': { latestVersion: '1.1.0', channel: 'community' },
      'motrix.scraper-hook': { latestVersion: '1.1.0', channel: 'builtin' },
    })
  })

  it('silently degrades when refresh() rejects', async () => {
    const { result } = renderHook(() => useRegistryUpdates(true))
    await act(async () => {
      await Promise.resolve()
    })
    mockInvoke.mockReset()
    mockInvoke.mockRejectedValue(new Error('transport down'))

    await expect(
      act(async () => {
        await result.current.refresh()
      })
    ).resolves.not.toThrow()

    expect(result.current.refreshing).toBe(false)
  })
})
