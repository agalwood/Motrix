import { Events } from '@shared/protocol/events'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const removeConnectionListener = vi.fn()
const onConnectionChange = vi.fn(
  (..._args: unknown[]) => removeConnectionListener
)
const listeners = new Map<string, (...a: unknown[]) => void>()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
    onConnectionChange: (...args: unknown[]) => onConnectionChange(...args),
    platform: 'darwin',
  },
}))

import {
  type SpeedLimitStateView,
  useSpeedLimitState,
} from './use-speed-limit-state'

const BASE_LIMITED: SpeedLimitStateView = {
  turtle: 'off',
  effective: { download: 800_000, upload: 0 },
  activeReason: 'base',
}

describe('useSpeedLimitState', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    onConnectionChange.mockClear()
    removeConnectionListener.mockClear()
    listeners.clear()
  })

  it('loads initial state and updates on SpeedLimitChanged event', async () => {
    mockInvoke.mockResolvedValue(BASE_LIMITED)
    const { result } = renderHook(() => useSpeedLimitState())
    await waitFor(() => expect(result.current).toEqual(BASE_LIMITED))

    act(() =>
      listeners.get(Events.SpeedLimitChanged)?.({
        turtle: 'auto',
        effective: { download: 500_000, upload: 50_000 },
        activeReason: 'schedule',
      })
    )
    await waitFor(() => expect(result.current.turtle).toBe('auto'))
  })

  it('initializes from the cached state on remount (no fallback flash)', async () => {
    // First mount fetches the real state and populates the module cache.
    mockInvoke.mockResolvedValue(BASE_LIMITED)
    const first = renderHook(() => useSpeedLimitState())
    await waitFor(() => expect(first.result.current).toEqual(BASE_LIMITED))
    first.unmount()

    // Simulate a remount where the fetch is still in flight: a cache-less hook
    // would render the FALLBACK ('off') on its first paint and the tile
    // would animate off -> base once the fetch resolves.
    mockInvoke.mockReturnValue(new Promise(() => {}))
    const second = renderHook(() => useSpeedLimitState())

    // First render must already reflect the cached real state.
    expect(second.result.current).toEqual(BASE_LIMITED)
  })

  it('subscribes before reading and rejects snapshots superseded by live changes', async () => {
    let resolveSnapshot!: (value: SpeedLimitStateView) => void
    mockInvoke.mockImplementation(() => {
      expect(listeners.has(Events.SpeedLimitChanged)).toBe(true)
      return new Promise<SpeedLimitStateView>((resolve) => {
        resolveSnapshot = resolve
      })
    })
    const { result } = renderHook(useSpeedLimitState)
    const automatic: SpeedLimitStateView = {
      turtle: 'auto',
      activeReason: 'schedule',
      effective: { upload: 50_000, download: 500_000 },
    }
    act(() => listeners.get(Events.SpeedLimitChanged)?.(automatic))
    await act(async () => resolveSnapshot(BASE_LIMITED))
    expect(result.current).toEqual(automatic)
  })

  it('refreshes on reconnect and window focus, and removes listeners on unmount', async () => {
    mockInvoke.mockResolvedValue(BASE_LIMITED)
    const { result, unmount } = renderHook(useSpeedLimitState)
    await waitFor(() => expect(result.current).toEqual(BASE_LIMITED))
    const automatic: SpeedLimitStateView = {
      turtle: 'auto',
      activeReason: 'none',
      effective: { upload: 0, download: 0 },
    }
    mockInvoke.mockResolvedValue(automatic)
    const reconnect = onConnectionChange.mock.calls[0][0] as (event: {
      state: string
    }) => void
    await act(async () => reconnect({ state: 'connected' }))
    expect(result.current).toEqual(automatic)
    mockInvoke.mockResolvedValue(BASE_LIMITED)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(result.current).toEqual(BASE_LIMITED)
    unmount()
    expect(listeners.size).toBe(0)
    expect(removeConnectionListener).toHaveBeenCalledOnce()
    const calls = mockInvoke.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    expect(mockInvoke).toHaveBeenCalledTimes(calls)
  })
})
