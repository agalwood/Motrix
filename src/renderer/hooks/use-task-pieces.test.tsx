import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const mockConnectionChange = vi.fn()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: (...args: unknown[]) => mockConnectionChange(...args),
    platform: 'darwin',
  },
}))

import { __clearPiecesCacheForTests, useTaskPieces } from './use-task-pieces'

describe('useTaskPieces', () => {
  beforeEach(() => {
    __clearPiecesCacheForTests()
    mockInvoke.mockReset()
    mockConnectionChange.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never overlaps slow requests at the one-second cadence', async () => {
    let resolve!: (value: unknown) => void
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    renderHook(() => useTaskPieces('slow'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    mockInvoke.mockResolvedValue({
      pieceLength: 1,
      numPieces: 1,
      bitfield: '8',
    })
    await act(async () => {
      resolve({ pieceLength: 1, numPieces: 1, bitfield: '0' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('suspends hidden documents and immediately refreshes when visible', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mockInvoke.mockResolvedValue({
      pieceLength: 1,
      numPieces: 1,
      bitfield: '8',
    })
    renderHook(() => useTaskPieces('visible'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(mockInvoke).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    hidden.mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('does not let a response from an unmounted panel poison its newer cache', async () => {
    let resolveOld!: (value: unknown) => void
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done
        })
    )
    const old = renderHook(() => useTaskPieces('cache-race'))
    old.unmount()
    const complete = { pieceLength: 1, numPieces: 8, bitfield: 'ff' }
    mockInvoke.mockResolvedValue(complete)
    const current = renderHook(() => useTaskPieces('cache-race'))
    await act(async () => {})
    await act(async () => {
      resolveOld({ ...complete, bitfield: '00' })
    })
    current.unmount()
    const remount = renderHook(() => useTaskPieces('cache-race'))
    expect(remount.result.current.pieces).toEqual(complete)
  })

  it('invalidates the old engine instance and refreshes paused pieces on reconnect', async () => {
    mockInvoke.mockResolvedValue({
      pieceLength: 1,
      numPieces: 8,
      bitfield: 'ff',
    })
    const hook = renderHook(
      ({ gid }) => useTaskPieces('same-task', false, gid),
      { initialProps: { gid: 'old' } }
    )
    await act(async () => {})
    expect(hook.result.current.pieces?.bitfield).toBe('ff')
    mockInvoke.mockResolvedValue({
      pieceLength: 1,
      numPieces: 8,
      bitfield: '00',
    })
    hook.rerender({ gid: 'new' })
    await act(async () => {})
    expect(hook.result.current.pieces?.bitfield).toBe('00')
    await act(async () => {
      mockConnectionChange.mock.calls.at(-1)?.[0]({ state: 'connected' })
    })
    expect(mockInvoke).toHaveBeenCalledTimes(3)
  })

  it('fetches pieces on mount', async () => {
    mockInvoke.mockResolvedValue({
      pieceLength: 16384,
      numPieces: 8,
      bitfield: 'ff',
    })
    const { result } = renderHook(() => useTaskPieces('t-fetch'))
    await vi.waitFor(() => expect(result.current.pieces).not.toBeNull())
    expect(result.current.pieces?.numPieces).toBe(8)
  })

  it('re-fetches every second while mounted', async () => {
    mockInvoke.mockResolvedValue({ pieceLength: 1, numPieces: 1, bitfield: '' })
    renderHook(() => useTaskPieces('t-poll'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('uses cached pieces on remount while starting a fresh poll', async () => {
    mockInvoke
      .mockResolvedValueOnce({ pieceLength: 1, numPieces: 5, bitfield: 'f' })
      .mockResolvedValueOnce({ pieceLength: 1, numPieces: 6, bitfield: 'f' })

    const first = renderHook(() => useTaskPieces('t-cache'))
    await vi.waitFor(() => expect(first.result.current.pieces).not.toBeNull())
    expect(first.result.current.pieces?.numPieces).toBe(5)
    first.unmount()

    const second = renderHook(() => useTaskPieces('t-cache'))
    expect(second.result.current.pieces?.numPieces).toBe(5)
    await vi.waitFor(() =>
      expect(second.result.current.pieces?.numPieces).toBe(6)
    )
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('fetches once but does not poll when enabled=false', async () => {
    mockInvoke.mockResolvedValue({
      pieceLength: 16384,
      numPieces: 8,
      bitfield: 'ff',
    })
    const { result } = renderHook(() => useTaskPieces('t-seeding', false))
    await vi.waitFor(() => expect(result.current.pieces).not.toBeNull())
    expect(result.current.pieces?.numPieces).toBe(8)
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})
