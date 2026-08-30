import { MdxpDispatcher } from '@core/bridge/mdxp-dispatcher'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import { ErrorCodes } from '@motrix/mdxp'
import type { DownloadTask, TaskInstance } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { registerWriteHandlers, type WriteHandlerDeps } from './write-handlers'

const cliCtx: MdxpSessionContext = {
  identity: { kind: 'cli', id: 'local' },
  startedAt: 0,
  isReady: () => true,
  markReady: () => {},
  isAuthorized: () => true,
  markAuthorized: () => {},
  pendingPair: null,
}

function makeInstance(gid: string | null, id: string): TaskInstance {
  return {
    instanceId: id,
    motrixId: 'task-1',
    gid,
    phase: TaskInstancePhase.BtDownload,
    status: TaskStatus.Downloading,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

const multiInstanceTask: DownloadTask = makeDownloadTask({
  id: 'task-1',
  instances: [
    makeInstance('gid-a', 'a'),
    makeInstance(null, 'b'),
    makeInstance('gid-c', 'c'),
  ],
})

const createdTask: DownloadTask = makeDownloadTask({
  id: 'created-1',
  type: TaskType.Http,
  name: 'f.iso',
  status: TaskStatus.Queued,
})

// Coordinator-managed media task: engineTaskId '' and null instance gids, so
// liveInstanceGids returns [] — it must NOT go through the pauseGid fan-out.
const mediaTask: DownloadTask = makeDownloadTask({
  id: 'media-1',
  engineTaskId: '',
  kind: TaskKind.Mux,
  status: TaskStatus.Downloading,
  instances: [makeInstance(null, 'seg'), makeInstance(null, 'mux')],
})

function setup(over: Partial<WriteHandlerDeps> = {}) {
  const deps: WriteHandlerDeps = {
    taskManager: {
      getById: (id) => {
        if (id === 'task-1') return multiInstanceTask
        if (id === 'created-1') return createdTask
        if (id === 'media-1') return mediaTask
        return undefined
      },
    },
    pauseTask: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    removeTask: vi.fn(async () => {}),
    createTask: vi.fn(async () => ({ taskId: 'created-1' })),
    parseTorrentFileCount: vi.fn(async () => 3),
    ...over,
  }
  const d = new MdxpDispatcher()
  registerWriteHandlers(d, deps)
  return { d, deps }
}

describe('task/pause', () => {
  it('delegates once by public task id', async () => {
    const { d, deps } = setup()
    const result = await d.dispatch('task/pause', { taskId: 'task-1' }, cliCtx)
    expect(result).toEqual({ ok: true })
    expect(deps.pauseTask).toHaveBeenCalledOnce()
    expect(deps.pauseTask).toHaveBeenCalledWith('task-1')
  })

  it('rejects an unknown task with ResourceUnavailable', async () => {
    const { d } = setup()
    await expect(
      d.dispatch('task/pause', { taskId: 'nope' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.ResourceUnavailable })
  })

  it('rejects an empty taskId with InvalidParams', async () => {
    const { d } = setup()
    await expect(
      d.dispatch('task/pause', { taskId: '' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('uses the same public-id action for a media task', async () => {
    const { d, deps } = setup()
    const result = await d.dispatch('task/pause', { taskId: 'media-1' }, cliCtx)
    expect(result).toEqual({ ok: true })
    expect(deps.pauseTask).toHaveBeenCalledWith('media-1')
  })
})

describe('task/resume', () => {
  it('delegates once by public task id', async () => {
    const { d, deps } = setup()
    const result = await d.dispatch('task/resume', { taskId: 'task-1' }, cliCtx)
    expect(result).toEqual({ ok: true })
    expect(deps.resumeTask).toHaveBeenCalledOnce()
    expect(deps.resumeTask).toHaveBeenCalledWith('task-1')
  })

  it('rejects an unknown task with ResourceUnavailable', async () => {
    const { d } = setup()
    await expect(
      d.dispatch('task/resume', { taskId: 'nope' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.ResourceUnavailable })
  })

  it('uses the same public-id action for a media task', async () => {
    const { d, deps } = setup()
    const result = await d.dispatch(
      'task/resume',
      { taskId: 'media-1' },
      cliCtx
    )
    expect(result).toEqual({ ok: true })
    expect(deps.resumeTask).toHaveBeenCalledWith('media-1')
  })
})

describe('task/remove', () => {
  it('removes with deleteFiles=true when requested', async () => {
    const { d, deps } = setup()
    const result = await d.dispatch(
      'task/remove',
      { taskId: 'task-1', deleteFiles: true },
      cliCtx
    )
    expect(result).toEqual({ ok: true })
    expect(deps.removeTask).toHaveBeenCalledWith('task-1', {
      deleteFiles: true,
    })
  })

  it('defaults deleteFiles to false when omitted', async () => {
    const { d, deps } = setup()
    await d.dispatch('task/remove', { taskId: 'task-1' }, cliCtx)
    expect(deps.removeTask).toHaveBeenCalledWith('task-1', {
      deleteFiles: false,
    })
  })

  it('rejects an unknown task with ResourceUnavailable', async () => {
    const { d, deps } = setup()
    await expect(
      d.dispatch('task/remove', { taskId: 'nope' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.ResourceUnavailable })
    expect(deps.removeTask).not.toHaveBeenCalled()
  })
})

describe('task/reveal', () => {
  it('registers only when the shell provides the capability', async () => {
    const revealTask = vi.fn(async () => {})
    const { d } = setup({ revealTask })

    await expect(
      d.dispatch('task/reveal', { taskId: 'task-1' }, cliCtx)
    ).resolves.toEqual({ ok: true })
    expect(revealTask).toHaveBeenCalledOnce()
    expect(revealTask).toHaveBeenCalledWith('task-1')

    const withoutShell = setup({ revealTask: undefined }).d
    await expect(
      withoutShell.dispatch('task/reveal', { taskId: 'task-1' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.CapabilityNotSupported })
  })

  it('requires a trusted task id before calling the shell', async () => {
    const revealTask = vi.fn(async () => {})
    const { d } = setup({ revealTask })

    await expect(
      d.dispatch('task/reveal', { taskId: 'missing' }, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.ResourceUnavailable })
    expect(revealTask).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied paths at the schema boundary', async () => {
    const revealTask = vi.fn(async () => {})
    const { d } = setup({ revealTask })

    await expect(
      d.dispatch(
        'task/reveal',
        { taskId: 'task-1', path: '/caller/controlled' },
        cliCtx
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
    expect(revealTask).not.toHaveBeenCalled()
  })

  it('does not leak a path from a shell failure', async () => {
    const secretPath = '/Users/alice/private/download.iso'
    const { d } = setup({
      revealTask: vi.fn(async () => {
        throw new Error(`cannot reveal ${secretPath}`)
      }),
    })

    try {
      await d.dispatch('task/reveal', { taskId: 'task-1' }, cliCtx)
      throw new Error('expected task/reveal to reject')
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCodes.ResourceUnavailable })
      expect(String((error as { message?: unknown }).message)).not.toContain(
        secretPath
      )
    }
  })
})

describe('download/add', () => {
  it('creates a url download and returns the created task snapshot', async () => {
    const { d, deps } = setup()
    const result = (await d.dispatch(
      'download/add',
      { kind: 'url', saveDir: '/dl', uris: ['https://example.com/f.iso'] },
      cliCtx
    )) as { id: string; status: string; type: string }
    expect(deps.createTask).toHaveBeenCalledTimes(1)
    const req = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(req).toMatchObject({
      type: 'http',
      uris: ['https://example.com/f.iso'],
    })
    // the returned value is the created MdxpTask snapshot
    expect(result.id).toBe('created-1')
    expect(result.status).toBe('queued')
    expect(result.type).toBe('http')
  })

  it('resolves an empty torrent selection via parseTorrentFileCount', async () => {
    const { d, deps } = setup()
    await d.dispatch(
      'download/add',
      { kind: 'torrent', saveDir: '/dl', base64: 'Zm9v' },
      cliCtx
    )
    expect(deps.parseTorrentFileCount).toHaveBeenCalledWith('Zm9v')
    const req = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(req).toMatchObject({
      type: 'bt',
      payload: { kind: 'torrent-base64', base64: 'Zm9v' },
      selectedFiles: [0, 1, 2],
    })
  })

  it('rejects an unsupported URL scheme with InvalidParams (schema gate)', async () => {
    const { d } = setup()
    await expect(
      d.dispatch(
        'download/add',
        { kind: 'url', saveDir: '/dl', uris: ['file:///etc/passwd'] },
        cliCtx
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('surfaces AdapterError when the created task is not retrievable', async () => {
    const { d } = setup({
      createTask: vi.fn(async () => ({ taskId: 'vanished' })),
    })
    await expect(
      d.dispatch(
        'download/add',
        { kind: 'url', saveDir: '/dl', uris: ['https://example.com/f.iso'] },
        cliCtx
      )
    ).rejects.toMatchObject({ code: ErrorCodes.AdapterError })
  })
})

describe('download/add idempotency', () => {
  const keyedParams = {
    kind: 'url',
    saveDir: '/dl',
    uris: ['https://example.com/f.iso'],
    idempotencyKey: '018f3b2e-4c5d-7aaa-bbbb-cccccccccccc',
  }

  it('replays the same key for the same identity without re-creating', async () => {
    const { d, deps } = setup()
    const first = (await d.dispatch('download/add', keyedParams, cliCtx)) as {
      id: string
    }
    const replay = (await d.dispatch('download/add', keyedParams, cliCtx)) as {
      id: string
    }
    expect(deps.createTask).toHaveBeenCalledTimes(1)
    expect(replay.id).toBe(first.id)
  })

  it('scopes dedup by client identity', async () => {
    const { d, deps } = setup()
    const otherCtx: MdxpSessionContext = {
      ...cliCtx,
      identity: { kind: 'cli', id: 'other' },
    }
    await d.dispatch('download/add', keyedParams, cliCtx)
    await d.dispatch('download/add', keyedParams, otherCtx)
    expect(deps.createTask).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed attempt — the retry re-executes', async () => {
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValue({ taskId: 'created-1' })
    const { d } = setup({ createTask })
    await expect(
      d.dispatch('download/add', keyedParams, cliCtx)
    ).rejects.toThrow('engine down')
    const result = (await d.dispatch('download/add', keyedParams, cliCtx)) as {
      id: string
    }
    expect(result.id).toBe('created-1')
    expect(createTask).toHaveBeenCalledTimes(2)
  })

  it('a keyless add never deduplicates', async () => {
    const { d, deps } = setup()
    const params = {
      kind: 'url',
      saveDir: '/dl',
      uris: ['https://example.com/f.iso'],
    }
    await d.dispatch('download/add', params, cliCtx)
    await d.dispatch('download/add', params, cliCtx)
    expect(deps.createTask).toHaveBeenCalledTimes(2)
  })
})
