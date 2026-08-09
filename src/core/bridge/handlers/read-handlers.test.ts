import { MdxpDispatcher } from '@core/bridge/mdxp-dispatcher'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import { ErrorCodes } from '@motrix/mdxp'
import { EngineState } from '@shared/types/engine'
import type { GlobalStats } from '@shared/types/stats'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { type ReadHandlerDeps, registerReadHandlers } from './read-handlers'

const cliCtx: MdxpSessionContext = {
  identity: { kind: 'cli', id: 'local' },
  startedAt: 0,
  isReady: () => true,
  markReady: () => {},
  isAuthorized: () => true,
  markAuthorized: () => {},
  pendingPair: null,
}

const STATS: GlobalStats = {
  totalDownloadSpeed: 100,
  totalUploadSpeed: 20,
  activeTasks: 2,
  waitingTasks: 1,
  stoppedTasks: 5,
}

function makeDispatcher(over: Partial<ReadHandlerDeps> = {}): MdxpDispatcher {
  const tasks: DownloadTask[] = [
    makeDownloadTask({ id: 'a', status: TaskStatus.Downloading }),
    makeDownloadTask({ id: 'b', status: TaskStatus.Completed }),
    makeDownloadTask({ id: 'c', status: TaskStatus.Removed }),
    makeDownloadTask({ id: 'd', status: TaskStatus.MetadataReady }),
  ]
  const deps: ReadHandlerDeps = {
    taskManager: {
      getAll: () => tasks,
      getById: (id) => tasks.find((t) => t.id === id),
    },
    statsAggregator: { getStats: () => STATS },
    supervisor: {
      getState: () => EngineState.Ready,
      getFeatureReport: () => null,
    },
    ...over,
  }
  const d = new MdxpDispatcher()
  registerReadHandlers(d, deps)
  return d
}

describe('task/list', () => {
  it('maps tasks and excludes removed; total is the filtered count', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch('task/list', {}, cliCtx)) as {
      tasks: Array<{ id: string }>
      total: number
    }
    // 4 tasks, 1 removed → 3 visible
    expect(result.total).toBe(3)
    expect(result.tasks.map((t) => t.id)).toEqual(['a', 'b', 'd'])
  })

  it('filters by public status (metadata_ready collapses into queued)', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch(
      'task/list',
      { status: 'queued' },
      cliCtx
    )) as { tasks: Array<{ id: string }>; total: number }
    // only 'd' (MetadataReady → queued) matches
    expect(result.tasks.map((t) => t.id)).toEqual(['d'])
    expect(result.total).toBe(1)
  })

  it('slices by offset/limit with total = pre-slice filtered count', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch(
      'task/list',
      { offset: 1, limit: 1 },
      cliCtx
    )) as { tasks: Array<{ id: string }>; total: number }
    expect(result.tasks.map((t) => t.id)).toEqual(['b'])
    expect(result.total).toBe(3)
  })

  it('rejects invalid params (negative limit) with InvalidParams', async () => {
    const d = makeDispatcher()
    await expect(
      d.dispatch('task/list', { limit: -1 }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })
})

describe('task/get', () => {
  it('returns the mapped task when present', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch('task/get', { taskId: 'a' }, cliCtx)) as {
      task: { id: string } | null
    }
    expect(result.task?.id).toBe('a')
  })

  it('returns { task: null } for an absent task', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch(
      'task/get',
      { taskId: 'missing' },
      cliCtx
    )) as { task: unknown | null }
    expect(result.task).toBeNull()
  })

  it('returns { task: null } for a removed task', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch('task/get', { taskId: 'c' }, cliCtx)) as {
      task: unknown | null
    }
    expect(result.task).toBeNull()
  })

  it('rejects an empty taskId with InvalidParams', async () => {
    const d = makeDispatcher()
    await expect(
      d.dispatch('task/get', { taskId: '' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })
})

describe('stats/get', () => {
  it('returns the aggregated global stats verbatim', async () => {
    const d = makeDispatcher()
    const result = await d.dispatch('stats/get', {}, cliCtx)
    expect(result).toEqual(STATS)
  })
})

describe('engine/status', () => {
  it('returns the supervisor state + null featureReport', async () => {
    const d = makeDispatcher()
    const result = (await d.dispatch('engine/status', {}, cliCtx)) as {
      state: string
      featureReport: unknown | null
    }
    expect(result.state).toBe('ready')
    expect(result.featureReport).toBeNull()
  })

  it('passes through a present featureReport', async () => {
    const d = makeDispatcher({
      supervisor: {
        getState: () => EngineState.Starting,
        getFeatureReport: () => ({
          version: '1.37.0',
          features: ['SQLite3-Persistence'],
          hasBtSeedUnverified: true,
          hasBtSaveMetadata: true,
          hasMoveStorage: false,
          hasSqlitePersistence: true,
        }),
      },
    })
    const result = (await d.dispatch('engine/status', {}, cliCtx)) as {
      state: string
      featureReport: { version: string } | null
    }
    expect(result.state).toBe('starting')
    expect(result.featureReport?.version).toBe('1.37.0')
  })
})
