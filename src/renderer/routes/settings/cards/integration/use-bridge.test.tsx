import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useBridgeStatus,
  useNativeMessagingRegistrationPolicy,
} from './use-bridge'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

const STATUS = 'bridge:getStatus'

describe('useBridgeStatus (Task 21)', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
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

describe('useNativeMessagingRegistrationPolicy', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
  })

  it.each([
    { mode: 'managed' },
    { mode: 'external' },
    { mode: 'unsupported', reason: 'windows-package' },
    { mode: 'unsupported', reason: 'server' },
  ])(
    'loads the %j policy through a query independent of bridge status',
    async (policy) => {
      vi.mocked(transport.invoke).mockResolvedValue(policy)

      const { result } = renderHook(() =>
        useNativeMessagingRegistrationPolicy()
      )
      expect(result.current).toBeNull()
      await waitFor(() => expect(result.current).toEqual(policy))
      expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
        Queries.GetNativeMessagingRegistrationPolicy
      )
    }
  )

  it.each([
    null,
    {},
    { mode: 'unknown' },
    { mode: 'unsupported' },
    { mode: 'unsupported', reason: 'unknown' },
    { mode: 'managed', reason: 'windows-package' },
    { mode: 'unsupported', reason: 'windows-package', installed: true },
  ])(
    'does not infer a registration policy from malformed data: %j',
    async (raw) => {
      vi.mocked(transport.invoke).mockResolvedValue(raw)
      const { result } = renderHook(() =>
        useNativeMessagingRegistrationPolicy()
      )
      await act(async () => {})
      expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
        Queries.GetNativeMessagingRegistrationPolicy
      )
      expect(result.current).toBeNull()
    }
  )

  it.each(['reject', 'throw'])(
    'treats a transport %s as unknown rather than an unsupported policy',
    async (failure) => {
      vi.mocked(transport.invoke).mockImplementation(() => {
        if (failure === 'throw') throw new Error('Transport unavailable')
        return Promise.reject(new Error('Transport unavailable'))
      })
      const { result } = renderHook(() =>
        useNativeMessagingRegistrationPolicy()
      )
      await act(async () => {})
      expect(result.current).toBeNull()
    }
  )

  it.each(['resolve', 'reject'])(
    'ignores a stale %s after StrictMode effect cleanup',
    async (settlement) => {
      let resolveFirst: (value: unknown) => void = () => {}
      let rejectFirst: (error: Error) => void = () => {}
      vi.mocked(transport.invoke)
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveFirst = resolve
              rejectFirst = reject
            })
        )
        .mockResolvedValue({ mode: 'managed' })
      const { result } = renderHook(
        () => useNativeMessagingRegistrationPolicy(),
        {
          wrapper: StrictMode,
        }
      )
      await waitFor(() => expect(result.current).toEqual({ mode: 'managed' }))
      expect(transport.invoke).toHaveBeenCalledTimes(2)

      await act(async () => {
        if (settlement === 'resolve') {
          resolveFirst({ mode: 'unsupported', reason: 'windows-package' })
        } else {
          rejectFirst(new Error('Stale transport failure'))
        }
      })
      expect(result.current).toEqual({ mode: 'managed' })
    }
  )
})
