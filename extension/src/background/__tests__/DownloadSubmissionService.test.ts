import { webcrypto } from 'node:crypto'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import { HandoffEndpointChangedError } from '@/background/handoff/guard'
import {
  DOWNLOAD_ERROR,
  DOWNLOAD_OPERATION_TTL_MS,
  newDownloadOperationId,
} from '@/shared/integration'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const params: DownloadSubmitParams = {
  source: {
    pageUrl: 'https://private.example/watch',
    pageTitle: 'Private',
    detectedAt: 1,
  },
  selection: {
    kind: 'direct',
    primary: {
      url: 'https://private.example/file?secret=hidden',
      headers: { Authorization: 'private-token' },
      cookies: [],
      refererPolicy: 'strict-origin-when-cross-origin',
    },
  },
  meta: { suggestedFilename: 'file.bin', qualityLabel: 'source' },
}

function fixture() {
  const backing: Record<string, unknown> = {}
  const storage = {
    get: vi.fn(async (key: string) => ({
      [key]: structuredClone(backing[key]),
    })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(backing, structuredClone(items))
    }),
  }
  const assertCurrent = vi.fn()
  const captureGuard = vi.fn(async () => ({
    origin: 'context-menu' as const,
    endpointId: 'local',
    endpointRevision: 0,
    assertCurrent,
  }))
  const manager = {
    ensureReady: vi.fn(async (_options: unknown) => {}),
    clearGateAndStart: vi.fn(async () => {}),
    submitDownload: vi.fn(
      async (
        _params: DownloadSubmitParams,
        options: {
          onSubmitting?: () => Promise<void>
          assertCurrent?: () => void
        } = {}
      ) => {
        await options.onSubmitting?.()
        options.assertCurrent?.()
        return { taskId: 'task-1' }
      }
    ),
  }
  const isPaired = vi.fn(async () => true)
  const present = vi.fn(async () => {})
  const popup = { captureSubmission: vi.fn(() => present) }
  const deps = { manager, captureGuard, storage, isPaired, popup }
  const service = new DownloadSubmissionService(deps)
  const input = {
    idempotencyKey: newDownloadOperationId(),
    source: 'media' as const,
    resourceKey: 'https://private.example/file?secret=hidden',
  }
  return {
    service,
    input,
    manager,
    assertCurrent,
    captureGuard,
    storage,
    backing,
    deps,
    present,
  }
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DownloadSubmissionService', () => {
  it.each(['media', 'page', 'manual', 'direct'] as const)(
    'presents accepted %s downloads once and does not replay presentation for cached results',
    async (source) => {
      const f = fixture()
      const input = { ...f.input, source }
      await f.service.run(input, async () => params)
      await f.service.run(input, async () => params)
      expect(f.present).toHaveBeenCalledExactlyOnceWith(
        { taskId: 'task-1', operationId: input.idempotencyKey },
        expect.objectContaining({
          endpointId: 'local',
          assertCurrent: f.assertCurrent,
        })
      )
    }
  )

  it('keeps accepted downloads successful when popup presentation fails', async () => {
    const f = fixture()
    f.present.mockRejectedValue(new Error('popup unavailable'))
    await expect(f.service.run(f.input, async () => params)).resolves.toEqual({
      taskId: 'task-1',
    })
  })
  it('prepares the connection before resolving capabilities and browser credentials', async () => {
    const f = fixture()
    const ready = deferred<void>()
    f.manager.ensureReady.mockImplementation(() => ready.promise)
    const prepare = vi.fn(async () => params)
    const operation = f.service.run(f.input, prepare)
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    expect(prepare).not.toHaveBeenCalled()
    ready.resolve()
    await expect(operation).resolves.toEqual({ taskId: 'task-1' })
    expect(f.manager.clearGateAndStart).not.toHaveBeenCalled()
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      { ...params, idempotencyKey: f.input.idempotencyKey },
      expect.anything()
    )
    expect(JSON.stringify(f.backing)).not.toContain('private.example')
    expect(JSON.stringify(f.backing)).not.toContain('private-token')
  })

  it('joins the same logical submission instead of sending it twice', async () => {
    const f = fixture()
    const ready = deferred<void>()
    f.manager.ensureReady.mockImplementation(() => ready.promise)
    const first = f.service.run(f.input, async () => params)
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    const second = f.service.run(f.input, async () => params)
    ready.resolve()
    expect(await Promise.all([first, second])).toEqual([
      { taskId: 'task-1' },
      { taskId: 'task-1' },
    ])
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
  })

  it('restores an accepted result after a service-worker restart without contacting Motrix', async () => {
    const f = fixture()
    await f.service.run(f.input, async () => params)
    f.manager.ensureReady.mockClear()
    f.manager.submitDownload.mockClear()
    const restored = new DownloadSubmissionService(f.deps)
    await expect(restored.run(f.input, async () => params)).resolves.toEqual({
      taskId: 'task-1',
    })
    expect(f.manager.ensureReady).not.toHaveBeenCalled()
    expect(f.manager.submitDownload).not.toHaveBeenCalled()
  })

  it('keeps uncertain delivery uncertain across retries and worker restarts', async () => {
    const f = fixture()
    f.manager.submitDownload.mockImplementation(async (_params, options) => {
      await options?.onSubmitting?.()
      throw new DownloadOutcomeUnknownError()
    })
    await expect(f.service.run(f.input, async () => params)).rejects.toThrow(
      DOWNLOAD_ERROR.resultUnknown
    )
    const restored = new DownloadSubmissionService(f.deps)
    await expect(restored.run(f.input, async () => params)).rejects.toThrow(
      DOWNLOAD_ERROR.resultUnknown
    )
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
    expect(await restored.list('local')).toMatchObject([{ state: 'unknown' }])
    expect(f.present).not.toHaveBeenCalled()
  })

  it('treats a persisted sending operation as unknown when its worker disappears', async () => {
    const f = fixture()
    const pending = deferred<{ taskId: string }>()
    f.manager.submitDownload.mockImplementation(async (_params, options) => {
      await options?.onSubmitting?.()
      return pending.promise
    })
    const operation = f.service.run(f.input, async () => params)
    await vi.waitFor(async () =>
      expect(await f.service.list('local')).toMatchObject([
        { state: 'submitting' },
      ])
    )
    const restored = new DownloadSubmissionService(f.deps)
    await expect(restored.run(f.input, async () => params)).rejects.toThrow(
      DOWNLOAD_ERROR.resultUnknown
    )
    pending.resolve({ taskId: 'late-task' })
    await operation
  })

  it('retries preparation failures with the same operation key', async () => {
    const f = fixture()
    f.manager.ensureReady.mockRejectedValueOnce(
      new DownloadPreparationError(DOWNLOAD_ERROR.connectionFailed)
    )
    await expect(f.service.run(f.input, async () => params)).rejects.toThrow(
      DOWNLOAD_ERROR.connectionFailed
    )
    await expect(f.service.run(f.input, async () => params)).resolves.toEqual({
      taskId: 'task-1',
    })
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
  })

  it('fences a changed endpoint before collecting browser data or submitting', async () => {
    const f = fixture()
    f.manager.ensureReady.mockImplementation(async () => {
      f.assertCurrent.mockImplementation(() => {
        throw new HandoffEndpointChangedError()
      })
    })
    const prepare = vi.fn(async () => params)
    await expect(f.service.run(f.input, prepare)).rejects.toThrow(
      DOWNLOAD_ERROR.endpointChanged
    )
    expect(prepare).not.toHaveBeenCalled()
    expect(f.manager.submitDownload).not.toHaveBeenCalled()
  })

  it('does not reuse an operation key for another resource or backend revision', async () => {
    const f = fixture()
    await f.service.run(f.input, async () => params)
    await expect(
      f.service.run(
        { ...f.input, resourceKey: 'another-resource' },
        async () => params
      )
    ).rejects.toThrow(DOWNLOAD_ERROR.contextChanged)
    expect(await f.service.list('local', 1)).toEqual([])
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
  })

  it('prevents late preparation completion from submitting after the deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const delayed = deferred<DownloadSubmitParams>()
    const prepare = vi.fn(() => delayed.promise)
    const operation = f.service.run(f.input, prepare)
    const rejected = expect(operation).rejects.toThrow(
      DOWNLOAD_ERROR.preparationTimeout
    )
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_001)
    await rejected
    delayed.resolve(params)
    await Promise.resolve()
    expect(f.manager.submitDownload).not.toHaveBeenCalled()
  })

  it('starts first pairing only for the labeled pair-and-download action', async () => {
    const f = fixture()
    f.deps.isPaired.mockResolvedValue(false)
    await f.service.run({ ...f.input, pairIfNeeded: true }, async () => params)
    expect(f.manager.clearGateAndStart).toHaveBeenCalledOnce()
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
  })

  it('never starts first pairing just because an ordinary send finds no pairing', async () => {
    const f = fixture()
    f.deps.isPaired.mockResolvedValue(false)
    f.manager.ensureReady.mockRejectedValue(
      new DownloadPreparationError(DOWNLOAD_ERROR.pairingRequired)
    )
    await expect(f.service.run(f.input, async () => params)).rejects.toThrow(
      DOWNLOAD_ERROR.pairingRequired
    )
    expect(f.manager.clearGateAndStart).not.toHaveBeenCalled()
  })

  it('does not send when the write-ahead record cannot be saved', async () => {
    const f = fixture()
    f.storage.set.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(f.service.run(f.input, async () => params)).rejects.toThrow()
    expect(f.manager.submitDownload).not.toHaveBeenCalled()
  })

  it('does not turn a successful submit into failure when the final record write fails', async () => {
    const f = fixture()
    f.manager.submitDownload.mockImplementation(async (_params, options) => {
      await options?.onSubmitting?.()
      f.storage.set.mockRejectedValueOnce(new Error('storage unavailable'))
      return { taskId: 'accepted-task' }
    })
    await expect(f.service.run(f.input, async () => params)).resolves.toEqual({
      taskId: 'accepted-task',
    })
    await expect(f.service.run(f.input, async () => params)).resolves.toEqual({
      taskId: 'accepted-task',
    })
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
  })

  it('never replays expired keys even after their recovery metadata is pruned', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.run(f.input, async () => params)
    await vi.advanceTimersByTimeAsync(DOWNLOAD_OPERATION_TTL_MS + 1)
    expect(await f.service.list('local')).toEqual([])
    await expect(f.service.run(f.input, async () => params)).rejects.toThrow(
      DOWNLOAD_ERROR.resultUnknown
    )
    expect(f.manager.submitDownload).toHaveBeenCalledOnce()
  })
})

const directory = {
  path: '/downloads',
  endpointId: 'local',
  endpointRevision: 0,
  instanceId: 'paired-instance',
}
describe('directory-bound submissions', () => {
  it('rejects a destination selected on another endpoint or revision', async () => {
    const f = fixture()
    for (const binding of [
      { ...directory, endpointId: 'nas' },
      { ...directory, endpointRevision: 1 },
    ]) {
      await expect(
        f.service.run({ ...f.input, directory: binding }, async () => ({
          ...params,
          saveDir: binding.path,
        }))
      ).rejects.toThrow(DOWNLOAD_ERROR.contextChanged)
    }
    expect(f.manager.submitDownload).not.toHaveBeenCalled()
  })
  it('rejects an unbound wire override', async () => {
    const f = fixture()
    await expect(
      f.service.run(f.input, async () => ({ ...params, saveDir: '/other' }))
    ).rejects.toThrow(DOWNLOAD_ERROR.directoryUnavailable)
    expect(f.manager.submitDownload).not.toHaveBeenCalled()
  })
  it('forwards the instance fence and deduplicates only the same destination', async () => {
    const f = fixture()
    await f.service.run({ ...f.input, directory }, async () => ({
      ...params,
      saveDir: directory.path,
    }))
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({ saveDir: directory.path }),
      expect.objectContaining({ directoryInstanceId: directory.instanceId })
    )
    await expect(
      f.service.run(
        { ...f.input, directory: { ...directory, path: '/other' } },
        async () => ({ ...params, saveDir: '/other' })
      )
    ).rejects.toThrow(DOWNLOAD_ERROR.contextChanged)
    expect(f.manager.submitDownload).toHaveBeenCalledTimes(1)
  })
})
