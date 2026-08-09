import { Events } from '@shared/protocol/events'
import { act, renderHook, waitFor } from '@testing-library/react'
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

import { useGlobalStats } from './use-global-stats'

describe('useGlobalStats', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    listeners.clear()
  })

  it('loads initial stats and updates on StatsUpdated event', async () => {
    mockInvoke.mockResolvedValue({
      totalDownloadSpeed: 100,
      totalUploadSpeed: 20,
      activeTasks: 2,
      waitingTasks: 0,
      stoppedTasks: 5,
    })
    const { result } = renderHook(() => useGlobalStats())
    await waitFor(() => expect(result.current.stats).not.toBeNull())
    expect(result.current.stats?.totalDownloadSpeed).toBe(100)

    act(() => {
      listeners.get(Events.StatsUpdated)?.({
        totalDownloadSpeed: 999,
        totalUploadSpeed: 50,
        activeTasks: 3,
        waitingTasks: 1,
        stoppedTasks: 5,
      })
    })
    expect(result.current.stats?.totalDownloadSpeed).toBe(999)
  })
})
