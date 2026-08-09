import { Events } from '@shared/protocol/events'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const listeners = new Map<string, (...a: unknown[]) => void>()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
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
    listeners.clear()
  })

  it('loads initial state and updates on SpeedLimitChanged event', async () => {
    mockInvoke.mockResolvedValue(BASE_LIMITED)
    const { result } = renderHook(() => useSpeedLimitState())
    await waitFor(() => expect(result.current.turtle).toBe('off'))

    listeners.get(Events.SpeedLimitChanged)?.({
      turtle: 'auto',
      effective: { download: 500_000, upload: 50_000 },
      activeReason: 'schedule',
    })
    await waitFor(() => expect(result.current.turtle).toBe('auto'))
  })

  it('initializes from the cached state on remount (no fallback flash)', async () => {
    // First mount fetches the real state and populates the module cache.
    mockInvoke.mockResolvedValue(BASE_LIMITED)
    const first = renderHook(() => useSpeedLimitState())
    await waitFor(() => expect(first.result.current.turtle).toBe('off'))
    first.unmount()

    // Simulate a remount where the fetch is still in flight: a cache-less hook
    // would render the FALLBACK ('off') on its first paint and the tile
    // would animate off -> base once the fetch resolves.
    mockInvoke.mockReturnValue(new Promise(() => {}))
    const second = renderHook(() => useSpeedLimitState())

    // First render must already reflect the cached real state.
    expect(second.result.current).toEqual(BASE_LIMITED)
  })
})
