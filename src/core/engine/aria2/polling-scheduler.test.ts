import { Events } from '@shared/protocol/events'
import type { GlobalStats } from '@shared/types/stats'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../events/event-bus'
import type { Aria2RpcClient } from './aria2-rpc-client'
import {
  PollingScheduler,
  type PollingTaskUpdateSource,
} from './polling-scheduler'
import type { Aria2RawGlobalStat, Aria2RawStatus } from './types'

// ─── Mock RpcClient ─────────────────────────────────────────

function createMockRpc(): Aria2RpcClient {
  return {
    getGlobalStat: vi.fn(),
    tellStatus: vi.fn(),
    multicall: vi.fn(),
  } as unknown as Aria2RpcClient
}

// ─── Fixtures (raw aria2 responses) ─────────────────────────

const IDLE_STAT: Aria2RawGlobalStat = {
  downloadSpeed: '0',
  uploadSpeed: '0',
  numActive: '0',
  numWaiting: '0',
  numStopped: '5',
  numStoppedTotal: '10',
}

const ACTIVE_STAT: Aria2RawGlobalStat = {
  downloadSpeed: '15158',
  uploadSpeed: '0',
  numActive: '2',
  numWaiting: '1',
  numStopped: '5',
  numStoppedTotal: '10',
}

// Translated GlobalStats equivalents
const IDLE_STATS_TRANSLATED: GlobalStats = {
  totalDownloadSpeed: 0,
  totalUploadSpeed: 0,
  activeTasks: 0,
  waitingTasks: 0,
  stoppedTasks: 5,
}

const ACTIVE_STATS_TRANSLATED: GlobalStats = {
  totalDownloadSpeed: 15158,
  totalUploadSpeed: 0,
  activeTasks: 2,
  waitingTasks: 1,
  stoppedTasks: 5,
}

const ACTIVE_TASKS: Aria2RawStatus[] = [
  {
    gid: 'gid1',
    status: 'active',
    totalLength: '100',
    completedLength: '50',
    uploadLength: '0',
    downloadSpeed: '10',
    uploadSpeed: '0',
    connections: '1',
    numSeeders: '0',
    seeder: 'false',
    pieceLength: '100',
    numPieces: '1',
    dir: '/tmp',
    files: [],
  },
]

const PAUSED_TASK: Aria2RawStatus = {
  ...ACTIVE_TASKS[0],
  status: 'paused',
  downloadSpeed: '0',
}

// ─── Tests ──────────────────────────────────────────────────

describe('PollingScheduler', () => {
  let rpc: Aria2RpcClient
  let eventBus: EventBus
  let onStats: ((stats: GlobalStats) => void) & ReturnType<typeof vi.fn>
  let onTasksUpdate: ((
    tasks: Aria2RawStatus[],
    source: PollingTaskUpdateSource
  ) => void) &
    ReturnType<typeof vi.fn>
  let scheduler: PollingScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    rpc = createMockRpc()
    eventBus = new EventBus()
    onStats = vi.fn() as ((stats: GlobalStats) => void) &
      ReturnType<typeof vi.fn>
    onTasksUpdate = vi.fn() as ((
      tasks: Aria2RawStatus[],
      source: PollingTaskUpdateSource
    ) => void) &
      ReturnType<typeof vi.fn>
    scheduler = new PollingScheduler(rpc, eventBus, onStats, onTasksUpdate)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('start / stop', () => {
    it('starts in idle mode and polls at 10s interval', async () => {
      vi.mocked(rpc.multicall).mockResolvedValue([IDLE_STAT, [], []])
      scheduler.start()

      // First poll fires immediately
      await vi.advanceTimersByTimeAsync(0)
      expect(rpc.multicall).toHaveBeenCalledTimes(1)
      expect(onStats).toHaveBeenCalledWith(IDLE_STATS_TRANSLATED)

      // 10s later — second poll
      await vi.advanceTimersByTimeAsync(10_000)
      expect(rpc.multicall).toHaveBeenCalledTimes(2)
    })

    it('stop clears the timer', async () => {
      vi.mocked(rpc.multicall).mockResolvedValue([IDLE_STAT, [], []])
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      scheduler.stop()

      await vi.advanceTimersByTimeAsync(20_000)
      // Only the initial call should have happened
      expect(rpc.multicall).toHaveBeenCalledTimes(1)
    })

    it('stopAndDrain is cached and suppresses callbacks after an awaited RPC', async () => {
      let resolvePoll!: (value: unknown[]) => void
      vi.mocked(rpc.multicall).mockImplementation(
        () =>
          new Promise<unknown[]>((resolve) => {
            resolvePoll = resolve
          })
      )
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      const drain = scheduler.stopAndDrain()
      expect(scheduler.stopAndDrain()).toBe(drain)

      resolvePoll([ACTIVE_STAT, ACTIVE_TASKS, []])
      await drain

      expect(onStats).not.toHaveBeenCalled()
      expect(onTasksUpdate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(rpc.multicall).toHaveBeenCalledTimes(1)
    })
  })

  describe('mode switching', () => {
    it('self-corrects to active mode from the first authoritative poll', async () => {
      vi.mocked(rpc.multicall).mockResolvedValue([
        ACTIVE_STAT,
        ACTIVE_TASKS,
        [],
      ])
      const emitted: boolean[] = []
      eventBus.on(Events.EngineActiveChanged, (active) => {
        emitted.push(active as boolean)
      })

      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(scheduler.getMode()).toBe('active')
      expect(emitted).toEqual([true])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(rpc.multicall).toHaveBeenCalledTimes(2)
    })

    it('switches to active mode on downloadStart notification', async () => {
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(IDLE_STAT)
      vi.mocked(rpc.multicall)
        .mockResolvedValueOnce([IDLE_STAT, [], []])
        .mockResolvedValue([ACTIVE_STAT, ACTIVE_TASKS, []])
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      const emitted: boolean[] = []
      eventBus.on(Events.EngineActiveChanged, (active) => {
        emitted.push(active as boolean)
      })

      scheduler.handleNotification('aria2.onDownloadStart', {
        gid: 'gid1',
      })

      // Should switch to active mode and emit event
      expect(emitted).toEqual([true])

      // Active mode polls at 1s
      await vi.advanceTimersByTimeAsync(1_000)
      expect(rpc.multicall).toHaveBeenCalledTimes(3)
      expect(onTasksUpdate).toHaveBeenCalled()
    })

    it('switches to idle mode when numActive reaches 0', async () => {
      // Start in active mode
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(IDLE_STAT)
      vi.mocked(rpc.multicall).mockResolvedValue([
        ACTIVE_STAT,
        ACTIVE_TASKS,
        [],
      ])
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      scheduler.handleNotification('aria2.onDownloadStart', {
        gid: 'gid1',
      })
      await vi.advanceTimersByTimeAsync(1_000)

      const emitted: boolean[] = []
      eventBus.on(Events.EngineActiveChanged, (active) => {
        emitted.push(active as boolean)
      })

      // Now simulate downloadComplete — scheduler checks numActive
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(IDLE_STAT)
      vi.mocked(rpc.multicall).mockResolvedValue([IDLE_STAT, [], []])
      await scheduler.handleNotification('aria2.onDownloadComplete', {
        gid: 'gid1',
      })

      expect(emitted).toEqual([false])
    })

    it('syncs the notified gid and switches to idle on downloadPause', async () => {
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(IDLE_STAT)
      vi.mocked(rpc.tellStatus).mockResolvedValue(PAUSED_TASK)
      vi.mocked(rpc.multicall).mockResolvedValue([
        ACTIVE_STAT,
        ACTIVE_TASKS,
        [],
      ])
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      scheduler.handleNotification('aria2.onDownloadStart', {
        gid: 'gid1',
      })
      await vi.advanceTimersByTimeAsync(1_000)

      const emitted: boolean[] = []
      eventBus.on(Events.EngineActiveChanged, (active) => {
        emitted.push(active as boolean)
      })

      vi.mocked(rpc.multicall).mockResolvedValue([IDLE_STAT, [], []])
      await scheduler.handleNotification('aria2.onDownloadPause', {
        gid: 'gid1',
      })

      expect(rpc.tellStatus).toHaveBeenCalledWith('gid1')
      expect(onTasksUpdate).toHaveBeenCalledWith([PAUSED_TASK], 'notification')
      expect(emitted).toEqual([false])
    })

    it('stays in active mode if numActive > 0 after complete', async () => {
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(IDLE_STAT)
      vi.mocked(rpc.multicall).mockResolvedValue([
        ACTIVE_STAT,
        ACTIVE_TASKS,
        [],
      ])
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      scheduler.handleNotification('aria2.onDownloadStart', {
        gid: 'gid1',
      })

      // Still active tasks after one completes
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(ACTIVE_STAT)
      await scheduler.handleNotification('aria2.onDownloadComplete', {
        gid: 'gid2',
      })

      // Should stay in active mode — no EngineActiveChanged(false)
      expect(scheduler.getMode()).toBe('active')
    })
  })

  describe('active mode polling', () => {
    it('uses multicall for stats + active tasks', async () => {
      vi.mocked(rpc.getGlobalStat).mockResolvedValue(IDLE_STAT)
      vi.mocked(rpc.multicall).mockResolvedValue([
        ACTIVE_STAT,
        ACTIVE_TASKS,
        [],
      ])
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      scheduler.handleNotification('aria2.onDownloadStart', {
        gid: 'gid1',
      })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(rpc.multicall).toHaveBeenCalledTimes(3)
      expect(onStats).toHaveBeenCalledWith(ACTIVE_STATS_TRANSLATED)
      expect(onTasksUpdate).toHaveBeenCalledWith(
        ACTIVE_TASKS,
        'authoritative-poll'
      )
    })
  })

  describe('error handling', () => {
    it('does not crash when RPC call fails', async () => {
      vi.mocked(rpc.multicall).mockRejectedValueOnce(
        new Error('Connection lost')
      )
      scheduler.start()

      // Should not throw
      await vi.advanceTimersByTimeAsync(0)

      // Should continue polling
      vi.mocked(rpc.multicall).mockResolvedValue([IDLE_STAT, [], []])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(onStats).toHaveBeenCalledWith(IDLE_STATS_TRANSLATED)
    })
  })
})
