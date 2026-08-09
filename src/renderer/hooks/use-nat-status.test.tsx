import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { NatState, type NatStatus } from '@shared/types/nat'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const on = vi.fn()
const off = vi.fn()

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (...args: unknown[]) => on(...args),
    off: (...args: unknown[]) => off(...args),
    platform: 'darwin',
  },
}))

const { useNatStatus } = await import('./use-nat-status')

const sample: NatStatus = {
  state: NatState.Active,
  enabled: true,
  activeMappings: [],
  gatewayInfo: null,
  lastError: null,
  lastDiagnostic: null,
  retryAttempt: 0,
  maxRetries: 3,
}

describe('useNatStatus', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(sample)
    on.mockReset()
    off.mockReset()
  })

  it('fetches the NAT status on mount and exposes it', async () => {
    const { result } = renderHook(() => useNatStatus())
    expect(invoke).toHaveBeenCalledWith(Queries.GetNatStatus)
    await waitFor(() => expect(result.current).toEqual(sample))
  })

  it('subscribes to every NAT lifecycle event', () => {
    renderHook(() => useNatStatus())
    const channels = on.mock.calls.map((call) => call[0])
    expect(channels).toEqual(
      expect.arrayContaining([
        Events.NatStateChanged,
        Events.NatMappingUpdated,
        Events.NatGatewayChanged,
        Events.NatDiagnosticCompleted,
        Events.NatError,
      ])
    )
  })

  it('re-fetches the status when a subscribed event fires', async () => {
    const { result } = renderHook(() => useNatStatus())
    await waitFor(() => expect(result.current).toEqual(sample))

    const updated: NatStatus = { ...sample, state: NatState.Failed }
    invoke.mockResolvedValue(updated)
    const reload = on.mock.calls.find(
      (call) => call[0] === Events.NatStateChanged
    )?.[1] as () => void
    act(() => {
      reload()
    })
    await waitFor(() => expect(result.current).toEqual(updated))
  })

  it('unsubscribes from every channel on unmount', () => {
    const { unmount } = renderHook(() => useNatStatus())
    const subscribed = on.mock.calls.map((call) => call[0])
    unmount()
    const removed = off.mock.calls.map((call) => call[0])
    expect(removed.sort()).toEqual(subscribed.sort())
  })
})
