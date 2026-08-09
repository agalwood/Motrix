import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskBtTracker } from './use-task-bt-tracker'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

describe('useTaskBtTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches effective on mount', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
      'http://a',
      'udp://b',
    ])
    const { result } = renderHook(() => useTaskBtTracker('gid-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.effective).toEqual(['http://a', 'udp://b'])
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetTaskBtTracker, {
      engineGid: 'gid-1',
    })
  })

  it('refetches on engineGid change', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['x'])
    const { rerender, result } = renderHook(
      ({ gid }) => useTaskBtTracker(gid),
      { initialProps: { gid: 'gid-1' } }
    )
    await waitFor(() => expect(result.current.effective).toEqual(['x']))
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['y'])
    rerender({ gid: 'gid-2' })
    await waitFor(() => expect(result.current.effective).toEqual(['y']))
  })

  it('exposes refresh()', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['x'])
    const { result } = renderHook(() => useTaskBtTracker('gid-1'))
    await waitFor(() => expect(result.current.effective).toEqual(['x']))
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      'x',
      'y',
    ])
    await result.current.refresh()
    await waitFor(() => expect(result.current.effective).toEqual(['x', 'y']))
  })

  it('captures errors and exposes via error', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('rpc down')
    )
    const { result } = renderHook(() => useTaskBtTracker('gid-1'))
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.effective).toEqual([])
  })

  it('returns empty when engineGid is null', () => {
    const { result } = renderHook(() => useTaskBtTracker(null))
    expect(result.current.effective).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('clears the previous gid data as soon as the key changes', async () => {
    const calls: Array<{ gid: string; resolve: (value: string[]) => void }> = []
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (_query, params) =>
        new Promise<string[]>((resolve) => {
          calls.push({
            gid: (params as { engineGid: string }).engineGid,
            resolve,
          })
        })
    )
    const { rerender, result } = renderHook(
      ({ gid }) => useTaskBtTracker(gid),
      { initialProps: { gid: 'gid-a' } }
    )
    calls[0]?.resolve(['udp://a'])
    await waitFor(() => expect(result.current.effective).toEqual(['udp://a']))

    // While gid-b's request is in flight the tab must not keep rendering
    // gid-a's rows as if they belonged to the new task — a fast detail
    // response would mark them deletable and hand the user a write path
    // that overwrites the new task's tracker config with the old task's.
    rerender({ gid: 'gid-b' })
    expect(result.current.effective).toEqual([])
    expect(result.current.isLoading).toBe(true)
  })

  it('a stale refresh closure from a previous gid cannot pollute the current task', async () => {
    const calls: Array<{ gid: string; resolve: (value: string[]) => void }> = []
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (_query, params) =>
        new Promise<string[]>((resolve) => {
          calls.push({
            gid: (params as { engineGid: string }).engineGid,
            resolve,
          })
        })
    )
    const { rerender, result } = renderHook(
      ({ gid }) => useTaskBtTracker(gid),
      { initialProps: { gid: 'gid-a' } }
    )
    calls[0]?.resolve(['udp://a'])
    await waitFor(() => expect(result.current.effective).toEqual(['udp://a']))

    // trackers-tab's save/sync/delete handlers hold refresh across an
    // `await transport.invoke(command)`; the inspector can switch tasks
    // before that continuation resumes and calls the captured refresh.
    const staleRefresh = result.current.refresh
    rerender({ gid: 'gid-b' })
    void staleRefresh()

    // Resolve newest-last: if the stale closure fired a request, its
    // response lands after gid-b's and would win the token race.
    calls[1]?.resolve(['udp://b'])
    for (const call of calls.slice(2)) call.resolve(['udp://a-stale'])

    await waitFor(() => expect(result.current.effective).toEqual(['udp://b']))
    expect(calls.slice(1).every((call) => call.gid === 'gid-b')).toBe(true)
  })
})
