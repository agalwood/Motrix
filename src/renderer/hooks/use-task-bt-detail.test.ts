import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTaskBtDetail, useTaskBtDetail } from './use-task-bt-detail'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

describe('useTaskBtDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches the full task detail and exposes the static BT fields', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't-1',
      bt: {
        announceList: [['udp://a'], ['udp://b']],
        magnetUri: 'magnet:?xt=urn:btih:abc',
      },
    })
    const { result } = renderHook(() => useTaskBtDetail('t-1'))
    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://a'], ['udp://b']])
    )
    expect(result.current.magnetUri).toBe('magnet:?xt=urn:btih:abc')
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetTaskDetail, 't-1')
  })

  it('stays empty for a null id without touching the transport', () => {
    const { result } = renderHook(() => useTaskBtDetail(null))
    expect(result.current.announceList).toEqual([])
    expect(result.current.magnetUri).toBeNull()
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('surfaces a query failure as error state instead of masking it as empty', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('transport down')
    )
    const { result } = renderHook(() => useTaskBtDetail('t-1'))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
    expect(result.current.announceList).toEqual([])
  })

  it('refetches when engineTaskId changes (re-add / magnet swap keep the id)', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 't-1',
      bt: { announceList: [], magnetUri: null },
    })
    const { rerender, result } = renderHook(
      ({ gid }) => useTaskBtDetail('t-1', gid),
      { initialProps: { gid: 'gid-metadata' } }
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 't-1',
      bt: { announceList: [['udp://swapped']], magnetUri: null },
    })
    rerender({ gid: 'gid-bt' })
    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://swapped']])
    )
  })

  it('refresh() re-queries and clears a previous error', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('flaky')
    )
    const { result } = renderHook(() => useTaskBtDetail('t-1'))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 't-1',
      bt: { announceList: [['udp://a']], magnetUri: null },
    })
    await result.current.refresh()
    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://a']])
    )
    expect(result.current.error).toBeNull()
  })

  it('a stale response for a previous task cannot overwrite the current detail', async () => {
    let resolveStale!: (value: unknown) => void
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve
        })
    )
    const { rerender, result } = renderHook(({ id }) => useTaskBtDetail(id), {
      initialProps: { id: 't-A' },
    })
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 't-B',
      bt: { announceList: [['udp://b']], magnetUri: null },
    })
    rerender({ id: 't-B' })
    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://b']])
    )

    // The in-flight response for t-A lands AFTER t-B's — it must be
    // discarded, or the trackers tab would classify B's trackers against
    // A's announce baseline.
    resolveStale({
      id: 't-A',
      bt: { announceList: [['udp://a']], magnetUri: 'magnet:?a' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current.announceList).toEqual([['udp://b']])
    expect(result.current.magnetUri).toBeNull()
  })

  it('clears the previous task data as soon as the key changes', async () => {
    const calls: Array<{ id: string; resolve: (value: unknown) => void }> = []
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (_query, taskId) =>
        new Promise((resolve) => {
          calls.push({ id: taskId as string, resolve })
        })
    )
    const { rerender, result } = renderHook(({ id }) => useTaskBtDetail(id), {
      initialProps: { id: 't-A' },
    })
    calls[0]?.resolve({
      id: 't-A',
      bt: { announceList: [['udp://a']], magnetUri: 'magnet:?a' },
    })
    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://a']])
    )

    // While t-B's request is in flight, t-A's announce baseline must not be
    // used to classify t-B's effective trackers — that misfiles B's native
    // announce URLs as editable extras in the trackers tab.
    rerender({ id: 't-B' })
    expect(result.current.announceList).toEqual([])
    expect(result.current.magnetUri).toBeNull()
    expect(result.current.isLoading).toBe(true)
  })

  it('a stale refresh closure from a previous task cannot pollute the current detail', async () => {
    const calls: Array<{ id: string; resolve: (value: unknown) => void }> = []
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (_query, taskId) =>
        new Promise((resolve) => {
          calls.push({ id: taskId as string, resolve })
        })
    )
    const { rerender, result } = renderHook(({ id }) => useTaskBtDetail(id), {
      initialProps: { id: 't-A' },
    })
    calls[0]?.resolve({
      id: 't-A',
      bt: { announceList: [['udp://a']], magnetUri: 'magnet:?a' },
    })
    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://a']])
    )

    // The empty-baseline retry chain in trackers-tab holds detail.refresh
    // inside a setTimeout continuation that can fire after a task switch.
    const staleRefresh = result.current.refresh
    rerender({ id: 't-B' })
    void staleRefresh()

    calls[1]?.resolve({
      id: 't-B',
      bt: { announceList: [['udp://b']], magnetUri: null },
    })
    for (const call of calls.slice(2)) {
      call.resolve({
        id: 't-A',
        bt: { announceList: [['udp://a-stale']], magnetUri: 'magnet:?a' },
      })
    }

    await waitFor(() =>
      expect(result.current.announceList).toEqual([['udp://b']])
    )
    expect(calls.slice(1).every((call) => call.id === 't-B')).toBe(true)
  })

  it('fetchTaskBtDetail rejects on transport failure (copy paths must abort)', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('transport down')
    )
    await expect(fetchTaskBtDetail('t-1')).rejects.toThrow('transport down')
  })
})
