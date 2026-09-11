import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { BridgeEvents, BridgeQueries } from '@shared/protocol/bridge'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBridgeStatus } from './use-bridge'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

const STATUS = BridgeQueries.GetStatus

describe('useBridgeStatus (Task 21)', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.on).mockClear()
    vi.mocked(transport.off).mockClear()
  })

  it('starts null, then returns the nominal status once the query resolves', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      port: 16802,
      degraded: false,
      extensionPairingHealth: 'ready',
      fixedPort: 'auto',
      instanceId: 'abc-instance',
    })

    const { result } = renderHook(() => useBridgeStatus())
    expect(result.current).toBeNull()

    await waitFor(() =>
      expect(result.current).toEqual({
        port: 16802,
        degraded: false,
        extensionPairingHealth: 'ready',
        fixedPort: 'auto',
        instanceId: 'abc-instance',
      })
    )
    expect(transport.invoke).toHaveBeenCalledWith(STATUS)
  })

  it('surfaces a degraded (ephemeral-port) bridge', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      port: 54321,
      degraded: true,
      extensionPairingHealth: 'ready',
      fixedPort: 'auto',
      instanceId: 'abc-instance',
    })

    const { result } = renderHook(() => useBridgeStatus())
    await waitFor(() => expect(result.current?.degraded).toBe(true))
    expect(result.current?.port).toBe(54321)
  })

  it('refreshes registration warnings after trust edits and recovery', async () => {
    const status = {
      port: 16802,
      degraded: false,
      extensionPairingHealth: 'ready',
      nativeMessagingHealth: 'ready',
      fixedPort: 'auto',
      instanceId: 'test',
    }
    vi.mocked(transport.invoke).mockImplementation(async () => ({ ...status }))
    const { result, unmount } = renderHook(() => useBridgeStatus())
    await waitFor(() =>
      expect(result.current?.nativeMessagingHealth).toBe('ready')
    )
    const listener = vi
      .mocked(transport.on)
      .mock.calls.find(
        ([event]) => String(event) === BridgeEvents.StatusChanged
      )?.[1]
    expect(listener).toBeDefined()
    status.nativeMessagingHealth = 'degraded'
    await act(async () => {
      listener?.()
    })
    expect(result.current?.nativeMessagingHealth).toBe('degraded')
    status.nativeMessagingHealth = 'ready'
    await act(async () => {
      listener?.()
    })
    expect(result.current?.nativeMessagingHealth).toBe('ready')
    unmount()
    expect(transport.off).toHaveBeenCalledWith(
      BridgeEvents.StatusChanged,
      listener
    )
  })

  it('reflects a pinned fixedPort from settings', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      port: 18080,
      degraded: false,
      extensionPairingHealth: 'ready',
      fixedPort: 18080,
      instanceId: 'abc-instance',
    })

    const { result } = renderHook(() => useBridgeStatus())
    await waitFor(() => expect(result.current?.fixedPort).toBe(18080))
  })

  it('resolves to null, not a thrown error, when the bridge is disabled (no handler registered)', async () => {
    vi.mocked(transport.invoke).mockRejectedValue(
      new Error('no handler registered for bridge:getStatus')
    )

    const { result } = renderHook(() => useBridgeStatus())
    await waitFor(() => expect(transport.invoke).toHaveBeenCalledWith(STATUS))
    expect(result.current).toBeNull()
  })

  it('degrades a shape that is not a real BridgeStatusInfo (e.g. a test stub answering every query with {}) to null instead of rendering garbage', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({})

    const { result } = renderHook(() => useBridgeStatus())
    await waitFor(() => expect(transport.invoke).toHaveBeenCalledWith(STATUS))
    expect(result.current).toBeNull()
  })
})
