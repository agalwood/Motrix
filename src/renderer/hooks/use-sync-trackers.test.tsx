import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncTrackers } from './use-sync-trackers'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))

function statusChanged() {
  const listener = vi
    .mocked(transport.on)
    .mock.calls.find(
      ([channel]) => channel === Events.TrackerSyncStatusChanged
    )?.[1]
  expect(listener).toBeDefined()
  listener?.()
}

describe('useSyncTrackers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transport.invoke).mockReset().mockResolvedValue('idle')
  })

  it('subscribes before reading an already running background sync', async () => {
    vi.mocked(transport.invoke).mockResolvedValue('probing')
    const { result } = renderHook(() => useSyncTrackers())
    await waitFor(() => expect(result.current.isSyncing).toBe(true))
    expect(result.current.status).toBe('probing')
    expect(transport.invoke).not.toHaveBeenCalledWith(Commands.SyncTrackers)
    expect(vi.mocked(transport.on).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.invoke).mock.invocationCallOrder[0]
    )
  })

  it('follows automatic starts and finishes without a button click', async () => {
    const { result } = renderHook(() => useSyncTrackers())
    await act(async () => {})
    vi.mocked(transport.invoke).mockResolvedValue('fetching')
    act(statusChanged)
    await waitFor(() => expect(result.current.isSyncing).toBe(true))
    vi.mocked(transport.invoke).mockResolvedValue('idle')
    act(statusChanged)
    await waitFor(() => expect(result.current.isSyncing).toBe(false))
    expect(result.current.error).toBeNull()
  })

  it('does not let a slow initial snapshot overwrite a newer sync status', async () => {
    let resolveInitial!: (value: string) => void
    vi.mocked(transport.invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve
      })
    )
    const { result } = renderHook(() => useSyncTrackers())
    vi.mocked(transport.invoke).mockResolvedValue('fetching')
    act(statusChanged)
    await waitFor(() => expect(result.current.isSyncing).toBe(true))
    await act(async () => resolveInitial('idle'))
    expect(result.current.isSyncing).toBe(true)
  })

  it('recovers a missed completion when the connection returns', async () => {
    vi.mocked(transport.invoke).mockResolvedValue('fetching')
    const { result } = renderHook(() => useSyncTrackers())
    await waitFor(() => expect(result.current.isSyncing).toBe(true))
    vi.mocked(transport.invoke).mockResolvedValue('failed')
    const onConnection = vi.mocked(transport.onConnectionChange!).mock
      .calls[0][0]
    act(() => onConnection({ state: 'connected' }))
    await waitFor(() => expect(result.current.isSyncing).toBe(false))
    expect(result.current.error).toBe('failed')
  })

  it('handles a rejected manual command and clears the error on retry', async () => {
    const { result } = renderHook(() => useSyncTrackers())
    await act(async () => {})
    vi.mocked(transport.invoke).mockImplementation(async (command) => {
      if (command === Commands.SyncTrackers)
        throw new Error('private RPC details')
      return 'idle'
    })
    await act(async () => result.current.sync())
    expect(result.current.isSyncing).toBe(false)
    expect(result.current.error).toBe('failed')
    vi.mocked(transport.invoke).mockResolvedValue('idle')
    await act(async () => result.current.sync())
    expect(result.current.error).toBeNull()
  })

  it('keeps retry available when a status read fails after a busy snapshot', async () => {
    vi.mocked(transport.invoke).mockResolvedValue('probing')
    const { result } = renderHook(() => useSyncTrackers())
    await waitFor(() => expect(result.current.isSyncing).toBe(true))
    vi.mocked(transport.invoke).mockRejectedValue(new Error('offline'))
    act(statusChanged)
    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.isSyncing).toBe(false)
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetTrackerSyncStatus)
  })
})
