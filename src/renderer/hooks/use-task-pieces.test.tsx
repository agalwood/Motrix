import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

import { __clearPiecesCacheForTests, useTaskPieces } from './use-task-pieces'

describe('useTaskPieces', () => {
  beforeEach(() => {
    __clearPiecesCacheForTests()
    mockInvoke.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

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

  it('re-fetches every 2 seconds while mounted', async () => {
    mockInvoke.mockResolvedValue({ pieceLength: 1, numPieces: 1, bitfield: '' })
    renderHook(() => useTaskPieces('t-poll'))
    await vi.advanceTimersByTimeAsync(2100)
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
