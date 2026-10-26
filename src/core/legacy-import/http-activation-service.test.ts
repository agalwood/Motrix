// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  link,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { CompletedEngineTaskCleanup } from '@core/task/completed-engine-task-cleanup'
import type { LegacyHttpContentVerificationInput } from '@core/task/direct-resource-validator'
import type { LegacyCheckpointReceipt } from '@shared/schemas/legacy-checkpoint'
import { legacyHttpActivationSchema } from '@shared/schemas/legacy-http-activation'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { canResume, isLegacyImportInactive } from '@shared/types/task-actions'
import {
  LEGACY_HTTP_COMPLETED,
  LEGACY_HTTP_TOTAL,
  legacyHttpActivationFixture,
} from '@test-utils/legacy-http-service'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyHttpActivationService } from './http-activation-service'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture(
  options: { requestLines?: string; system?: Record<string, unknown> } = {}
) {
  let receipt: LegacyCheckpointReceipt | null = null
  let engine: DownloadTask | null = null
  let loseImport = false
  let loseCreate = false
  let binding = true
  let f: Awaited<ReturnType<typeof legacyHttpActivationFixture>>
  const verifier = {
    verifyLegacyContent: vi.fn(
      async (input: LegacyHttpContentVerificationInput) => {
        expect(input.ranges).toEqual([
          { offset: 0, length: LEGACY_HTTP_COMPLETED },
        ])
        expect(
          Buffer.from(await input.read(0, LEGACY_HTTP_COMPLETED)).equals(
            f.payload
          )
        ).toBe(true)
        return {
          validator: {
            kind: 'strong-etag' as const,
            value: '"fixture"',
            contentLength: LEGACY_HTTP_TOTAL,
            capturedAt: 1,
          },
          requestHeaders: {
            'If-Match': '"fixture"',
            'Accept-Encoding': 'identity',
          },
        }
      }
    ),
  }
  const adapter = {
    supportsLegacyCheckpointImport: vi.fn(async () => true),
    supportsLegacyHttpActivation: vi.fn(async () => true),
    inspectLegacyCheckpoint: vi.fn(async (bytes: Uint8Array) => ({
      type: 'http',
      totalBytes: LEGACY_HTTP_TOTAL,
      pieceBytes: 1048576,
      infoHash: null,
      completedBytes: LEGACY_HTTP_COMPLETED,
      uploadedBytes: 0,
      ranges: [{ offset: 0, length: LEGACY_HTTP_COMPLETED }],
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    })),
    reconcileLegacyCheckpoint: vi.fn(
      async (input) => receipt ?? { ...input, status: 'absent' }
    ),
    importLegacyCheckpoint: vi.fn(async (input) => {
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'import-uncertain', token: input.token })
      receipt = {
        status: 'created',
        token: input.token,
        engineTaskId: input.engineTaskId,
        targetPath: input.targetPath,
        sourceDigest: input.sourceDigest,
      }
      if (loseImport) {
        loseImport = false
        throw new Error('Lost import response')
      }
      return receipt
    }),
    createDownload: vi.fn(async (params) => {
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'create-uncertain', engineTaskId: params.gid })
      expect(params).toMatchObject({
        saveDir: f.downloads,
        filename: 'partial.bin',
        pause: true,
        resumePolicy: 'checkpoint',
        fileAllocation: 'none',
        headers: { 'If-Match': '"fixture"', 'Accept-Encoding': 'identity' },
      })
      expect(f.taskManager.isEngineTaskIdRetired(params.gid)).toBe(true)
      engine = {
        ...f.taskManager.getById(f.taskId),
        engineTaskId: params.gid,
        status: TaskStatus.Paused,
      } as DownloadTask
      if (loseCreate) {
        loseCreate = false
        throw new Error('Lost create response')
      }
      return params.gid
    }),
    getTaskStatus: vi.fn(async () => engine),
    getTaskFiles: vi.fn(async () => []),
    listActiveAndWaiting: vi.fn(async () =>
      engine ? [{ gid: engine.engineTaskId }] : []
    ),
    listStopped: vi.fn(async () => []),
    verifyLegacyHttpBinding: vi.fn(async () => binding),
    pauseTask: vi.fn(async () => {
      if (engine) engine.status = TaskStatus.Paused
    }),
    resumeTask: vi.fn(async () => {
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'resume-uncertain' })
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyImport
      ).toMatchObject({
        activation: 'active',
        storagePolicy: 'legacy-http-in-place',
      })
      if (engine) engine.status = TaskStatus.Downloading
    }),
  } as unknown as EngineAdapter
  f = await legacyHttpActivationFixture({ adapter, verifier, ...options })
  cleanup.push(f.dispose)
  return {
    ...f,
    adapter,
    verifier,
    loseImport: () => {
      loseImport = true
    },
    loseCreate: () => {
      loseCreate = true
    },
    disappear: () => {
      engine = null
    },
    badBinding: () => {
      binding = false
    },
    recover: async () => {
      const service = new LegacyHttpActivationService(f.deps)
      await service.recover()
      return service
    },
  }
}

describe('durable HTTP legacy activation', () => {
  it('replays completion emitted during first resume after the active marker is durable', async () => {
    const f = await fixture()
    let mutationTail = Promise.resolve()
    const runTaskMutation = <T>(
      _ids: readonly string[],
      operation: () => Promise<T>
    ): Promise<T> => {
      const next = mutationTail.then(operation)
      mutationTail = next.then(
        () => {},
        () => {}
      )
      return next
    }
    f.deps.runTaskMutation = runTaskMutation
    const finalize = vi.fn(async (taskId: string) => {
      expect(
        f.db.getTask(taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'active' })
      const current = f.taskManager.getById(taskId) as DownloadTask
      expect(isLegacyImportInactive(current)).toBe(false)
      f.taskManager.set(taskId, { ...current, status: TaskStatus.Completed })
    })
    const adapter = {
      forceRemoveTask: vi.fn(async () => {}),
      removeDownloadResult: vi.fn(async () => {}),
    }
    const completion = new CompletedEngineTaskCleanup({
      taskManager: f.taskManager,
      adapter,
      mintTaskId: () => 'unexpected-adoption',
      persist: vi.fn(async () => {}),
      adopt: vi.fn(async () => {}),
      publish: vi.fn(),
      dispatch: vi.fn(async () => {}),
      runTaskMutation,
      finalizeLegacyHttp: finalize,
      log: { warn: vi.fn() },
    })
    cleanup.push(() => completion.stopAndDrain())
    let observation: Promise<boolean> | undefined
    const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
    vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
      await resume?.(gid)
      const owner = f.taskManager.getByEngineTaskId(gid) as DownloadTask
      expect(isLegacyImportInactive(owner)).toBe(true)
      expect(owner.instances[0].payload.legacyHttpActivation).toMatchObject({
        stage: 'resume-uncertain',
      })
      const live = await f.adapter.getTaskStatus(gid)
      if (live) live.status = TaskStatus.Completed
      // As in the desktop completion listener, observe without awaiting the
      // activation's own mutation lane from inside its resume RPC.
      observation = completion.observe({
        ...owner,
        status: TaskStatus.Completed,
      })
      expect(finalize).not.toHaveBeenCalled()
    })

    expect(await f.service.activate(f.taskId, async () => f.downloads)).toBe(
      true
    )
    await expect(observation).resolves.toBe(true)

    expect(finalize).toHaveBeenCalledOnce()
    expect(f.taskManager.getById(f.taskId)?.status).toBe(TaskStatus.Completed)
    expect(adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(adapter.removeDownloadResult).not.toHaveBeenCalled()
  })

  it('verifies every completed byte and binds the original target before resuming once', async () => {
    const f = await fixture()
    expect(await f.service.activate(f.taskId, async () => f.downloads)).toBe(
      true
    )
    const pair = f.db.getTask(f.taskId)
    const intent = legacyHttpActivationSchema.parse(
      pair?.instances[0].payload.legacyHttpActivation
    )
    expect(intent.stage).toBe('active')
    expect(pair?.task).toMatchObject({
      totalBytes: LEGACY_HTTP_TOTAL,
      downloadedBytes: LEGACY_HTTP_COMPLETED,
      finalPath: f.target,
      pieceLength: 1048576,
    })
    expect(pair?.instances[0].diskPath).toBe(f.target)
    expect(pair?.instances[0].progress).toBe(
      (LEGACY_HTTP_COMPLETED / LEGACY_HTTP_TOTAL) * 100
    )
    expect((await readFile(f.target)).equals(f.payload)).toBe(true)
    expect(await readFile(`${f.target}.aria2`)).toEqual(f.control)
    expect(await readFile(intent.controlBackupPath)).toEqual(f.control)
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
    expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
    expect(
      isLegacyImportInactive(f.taskManager.getById(f.taskId) as DownloadTask)
    ).toBe(false)
  })
  it('uses one request context for verification and native add without persisting credentials', async () => {
    const f = await fixture({
      requestLines:
        ' header=Cookie: token=private-cookie\n referer=https://example.com/private-page\n http-user=private-user\n http-passwd=private-password\n',
      system: {
        'user-agent': 'Legacy-Agent',
        'all-proxy': 'http://private-user:proxy-secret@localhost:8080',
      },
    })
    await f.service.activate(f.taskId, async () => f.downloads)
    const options = f.verifier.verifyLegacyContent.mock.calls[0][0].options
    expect(f.adapter.createDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: options?.userAgent,
        proxy: options?.proxy,
        headers: expect.objectContaining(options?.headers),
      })
    )
    expect(f.adapter.verifyLegacyHttpBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining(options ?? {}),
      })
    )
    const serialized = JSON.stringify(f.db.getTask(f.taskId))
    for (const secret of [
      'private-cookie',
      'private-page',
      'private-user',
      'private-password',
      'proxy-secret',
      'Legacy-Agent',
    ])
      expect(serialized).not.toContain(secret)
  })
  it('leaves originals and the engine untouched when remote bytes mismatch', async () => {
    const f = await fixture()
    f.verifier.verifyLegacyContent.mockRejectedValueOnce(
      new Error('httpContentChanged')
    )
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('httpContentChanged')
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    ).toBeUndefined()
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
    expect(f.adapter.createDownload).not.toHaveBeenCalled()
    expect((await readFile(f.target)).equals(f.payload)).toBe(true)
    expect(await readFile(`${f.target}.aria2`)).toEqual(f.control)
  })
  it('rejects a payload replaced while its old read handle is being verified', async () => {
    const f = await fixture()
    const verify = f.verifier.verifyLegacyContent.getMockImplementation()
    f.verifier.verifyLegacyContent.mockImplementationOnce(async (input) => {
      const result = await verify?.(input)
      await rename(f.target, `${f.target}.old`)
      await writeFile(f.target, f.payload)
      if (!result) throw new Error('No verifier')
      return result
    })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('changedSource')
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
  })
  it.each(['control', 'profile'] as const)(
    'rejects %s changes during verification before importing anything',
    async (kind) => {
      const f = await fixture()
      const verify = f.verifier.verifyLegacyContent.getMockImplementation()
      f.verifier.verifyLegacyContent.mockImplementationOnce(async (input) => {
        const result = await verify?.(input)
        await writeFile(
          kind === 'control'
            ? `${f.target}.aria2`
            : path.join(f.profile, 'system.json'),
          'changed'
        )
        if (!result) throw new Error('No verifier')
        return result
      })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('changedSource')
      expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
    }
  )
  it('keeps lost import recovery passive and revalidates on explicit retry', async () => {
    const f = await fixture()
    f.loseImport()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost import response')
    const service = await f.recover()
    expect(f.adapter.createDownload).not.toHaveBeenCalled()
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    await service.activate(f.taskId, async () => f.downloads)
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(2)
    expect(f.adapter.importLegacyCheckpoint).toHaveBeenCalledTimes(1)
    expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
  })
  it('binds a lost create response during recovery without requesting bytes or resuming', async () => {
    const f = await fixture()
    f.loseCreate()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost create response')
    await f.recover()
    expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    ).toMatchObject({ stage: 'bound' })
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      false
    )
  })
  it.each(['response', 'persist'] as const)(
    'recovers first-resume progress after losing the final %s without re-adding or remote verification',
    async (lost) => {
      const f = await fixture()
      const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
      vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
        await resume?.(gid)
        await writeFile(
          f.target,
          Buffer.concat([f.payload, Buffer.alloc(32768, 1)])
        )
        if (lost === 'response') throw new Error('Lost resume response')
      })
      const save = f.db.saveTaskWithInstances.bind(f.db)
      vi.spyOn(f.db, 'saveTaskWithInstances').mockImplementation((pair) => {
        if (
          lost === 'persist' &&
          (pair.instances[0].payload.legacyHttpActivation as { stage: string })
            .stage === 'active'
        )
          throw new Error('Lost active save')
        return save(pair)
      })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow(
        lost === 'response' ? 'Lost resume response' : 'Lost active save'
      )
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({
        stage: 'resume-uncertain',
        retainedContentDigest: createHash('sha256')
          .update(f.payload)
          .digest('hex'),
      })
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        false
      )
      vi.mocked(f.db.saveTaskWithInstances).mockImplementation(save)
      await f.recover()
      expect(f.adapter.pauseTask).toHaveBeenCalledTimes(1)
      expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'active' })
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        true
      )
    }
  )
  it('keeps first unpause undispatched when its durable uncertain save fails', async () => {
    const f = await fixture()
    const save = f.db.saveTaskWithInstances.bind(f.db)
    vi.spyOn(f.db, 'saveTaskWithInstances').mockImplementation((pair) => {
      if (
        (pair.instances[0].payload.legacyHttpActivation as { stage: string })
          .stage === 'resume-uncertain'
      )
        throw new Error('Uncertain save failed')
      return save(pair)
    })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Uncertain save failed')
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    ).toMatchObject({ stage: 'bound' })
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      false
    )
  })
  it.each([false, true])(
    'pauses a cancelled first unpause even when its response is lost: %s',
    async (loseResponse) => {
      const f = await fixture()
      const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
      vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
        await resume?.(gid)
        await writeFile(
          f.target,
          Buffer.concat([f.payload, Buffer.alloc(32768)])
        )
        f.service.cancel(f.taskId)
        if (loseResponse) throw new Error('Lost resume response')
      })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('httpVerificationCancelled')
      expect(f.adapter.pauseTask).toHaveBeenCalledTimes(1)
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'resume-uncertain' })
      await f.recover()
      expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        true
      )
    }
  )
  it('rejects a same-inode edit to retained bytes after an uncertain first unpause', async () => {
    const f = await fixture()
    const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
    vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
      await resume?.(gid)
      await writeFile(f.target, Buffer.concat([f.payload, Buffer.alloc(32768)]))
      throw new Error('Lost resume response')
    })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost resume response')
    const changed = await readFile(f.target)
    changed[LEGACY_HTTP_COMPLETED - 1] ^= 255
    await writeFile(f.target, changed)
    const recovered = await f.recover()
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      false
    )
    await expect(
      recovered.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('changedSource')
    expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
    expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['initial', 'acknowledged'],
    ['retry', 'acknowledged'],
    ['initial', 'lost-response'],
    ['retry', 'still-running'],
    ['initial', 'completed'],
    ['retry', 'save-failed'],
  ] as const)(
    'handles cancellation during %s final persistence with %s pause outcome',
    async (attempt, outcome) => {
      const f = await fixture()
      let service = f.service
      if (attempt === 'retry') {
        f.loseCreate()
        await expect(
          service.activate(f.taskId, async () => f.downloads)
        ).rejects.toThrow('Lost create response')
        service = await f.recover()
      }
      let resumed = false
      let release = () => {}
      let reached = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<void>((resolve) => {
        reached = resolve
      })
      const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
      vi.mocked(f.adapter.resumeTask).mockImplementation(async (gid) => {
        await resume?.(gid)
        resumed = true
      })
      const pause = vi.mocked(f.adapter.pauseTask).getMockImplementation()
      if (outcome === 'lost-response')
        vi.mocked(f.adapter.pauseTask).mockImplementation(async (gid) => {
          await pause?.(gid)
          throw new Error('Lost pause response')
        })
      else if (outcome === 'still-running')
        vi.mocked(f.adapter.pauseTask).mockImplementation(async () => {})
      f.deps.runExclusivePersistence = async (operation) => {
        if (resumed) {
          reached()
          await held
          if (outcome === 'save-failed') throw new Error('Active save failed')
        }
        return operation()
      }
      const activation = service.activate(f.taskId, async () => f.downloads)
      await entered
      const intent = legacyHttpActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      )
      if (outcome === 'completed') {
        const engine = await f.adapter.getTaskStatus(intent.engineTaskId)
        if (!engine) throw new Error('Missing native task')
        engine.status = TaskStatus.Completed
      }
      service.cancel(f.taskId)
      release()
      await expect(activation).rejects.toThrow(
        outcome === 'still-running'
          ? 'activationUncertain'
          : 'httpVerificationCancelled'
      )
      expect(f.adapter.pauseTask).toHaveBeenCalledTimes(
        outcome === 'completed' ? 0 : 1
      )
      expect((await f.adapter.getTaskStatus(intent.engineTaskId))?.status).toBe(
        outcome === 'still-running'
          ? TaskStatus.Downloading
          : outcome === 'completed'
            ? TaskStatus.Completed
            : TaskStatus.Paused
      )
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
    }
  )
  it('does not accept uncertain progress until the native owner is confirmed paused', async () => {
    const f = await fixture()
    const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
    vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
      await resume?.(gid)
      throw new Error('Lost resume response')
    })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost resume response')
    vi.mocked(f.adapter.pauseTask).mockImplementation(async () => {})
    const recovered = await f.recover()
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      false
    )
    await expect(
      recovered.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('activationUncertain')
    expect(f.adapter.inspectLegacyCheckpoint).toHaveBeenCalledTimes(1)
  })
  it.each(['missing-owner', 'different-owner', 'changed-backup'] as const)(
    'does not recreate or resume an uncertain first unpause with %s',
    async (invalid) => {
      const f = await fixture()
      const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
      vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
        await resume?.(gid)
        throw new Error('Lost resume response')
      })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Lost resume response')
      if (invalid === 'missing-owner') f.disappear()
      else if (invalid === 'different-owner') f.badBinding()
      else {
        const intent = legacyHttpActivationSchema.parse(
          f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
        )
        await writeFile(intent.controlBackupPath, 'changed backup')
      }
      const recovered = await f.recover()
      await expect(
        recovered.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow(
        invalid === 'changed-backup' ? 'changedSource' : 'activationUncertain'
      )
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        false
      )
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
      expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
    }
  )
  it.each(['retained-range', 'unfinished-gap'] as const)(
    'checks an uncertain sparse checkpoint after a %s edit',
    async (changed) => {
      const f = await fixture()
      const ranges = [
        { offset: 0, length: 16 },
        { offset: 1024, length: 16 },
      ]
      const inspect = vi
        .mocked(f.adapter.inspectLegacyCheckpoint!)
        .getMockImplementation()
      vi.mocked(f.adapter.inspectLegacyCheckpoint!).mockImplementation(
        async (bytes) => ({
          ...(await inspect!(bytes)),
          ranges,
          completedBytes: 32,
        })
      )
      f.verifier.verifyLegacyContent.mockImplementation(async (input) => {
        for (const range of input.ranges)
          expect(
            Buffer.from(await input.read(range.offset, range.length))
          ).toEqual(
            f.payload.subarray(range.offset, range.offset + range.length)
          )
        return {
          validator: {
            kind: 'strong-etag',
            value: '"fixture"',
            contentLength: LEGACY_HTTP_TOTAL,
            capturedAt: 1,
          },
          requestHeaders: {
            'If-Match': '"fixture"',
            'Accept-Encoding': 'identity',
          },
        }
      })
      const resume = vi.mocked(f.adapter.resumeTask).getMockImplementation()
      vi.mocked(f.adapter.resumeTask).mockImplementationOnce(async (gid) => {
        await resume?.(gid)
        const bytes = Buffer.from(f.payload)
        bytes[changed === 'retained-range' ? 1039 : 1000] ^= 255
        await writeFile(f.target, bytes)
        throw new Error('Lost resume response')
      })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Lost resume response')
      const intent = legacyHttpActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      )
      expect(intent.retainedContentDigest).toBe(
        createHash('sha256')
          .update(f.payload.subarray(0, 16))
          .update(f.payload.subarray(1024, 1040))
          .digest('hex')
      )
      const recovered = await f.recover()
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        changed === 'unfinished-gap'
      )
      if (changed === 'retained-range')
        await expect(
          recovered.activate(f.taskId, async () => f.downloads)
        ).rejects.toThrow('changedSource')
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(f.adapter.resumeTask).toHaveBeenCalledTimes(1)
    }
  )
  it('never blindly retries an uncertain create when the engine GID disappeared', async () => {
    const f = await fixture()
    f.loseCreate()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow()
    f.disappear()
    const service = await f.recover()
    await expect(
      service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('activationUncertain')
    expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(
      isLegacyImportInactive(f.taskManager.getById(f.taskId) as DownloadTask)
    ).toBe(true)
  })
  it('refuses ambient engine headers before verification or any native mutation', async () => {
    const f = await fixture()
    vi.mocked(f.adapter.supportsLegacyHttpActivation!).mockResolvedValue(false)
    expect(await f.service.availability(f.taskId)).toMatchObject({
      available: false,
      reason: 'legacyImport.errors.httpRequestUnsupported',
    })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('httpRequestUnsupported')
    expect(f.verifier.verifyLegacyContent).not.toHaveBeenCalled()
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
    expect(f.adapter.createDownload).not.toHaveBeenCalled()
  })
  it.each(['missing', 'malformed'] as const)(
    'continues startup recovery past a %s migration marker',
    async (kind) => {
      const f = await fixture()
      f.loseCreate()
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Lost create response')
      const valid = f.db.getTask(f.taskId)
      if (!valid) throw new Error('Missing fixture row')
      const corrupt = structuredClone(valid)
      corrupt.task.motrixId = 'corrupt'
      corrupt.task.finalName = 'other.bin'
      corrupt.task.finalPath = path.join(f.downloads, 'other.bin')
      corrupt.instances[0].motrixId = 'corrupt'
      corrupt.instances[0].diskPath = corrupt.task.finalPath
      if (kind === 'missing') delete corrupt.instances[0].payload.legacyImport
      else
        corrupt.instances[0].payload.legacyImport = {
          version: 999,
          activation: 'active',
        }
      f.rows.clear()
      f.rows.set('corrupt', corrupt)
      f.rows.set(f.taskId, valid)
      await expect(f.recover()).resolves.toBeInstanceOf(
        LegacyHttpActivationService
      )
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'bound' })
      expect(f.db.getTask('corrupt')).toEqual(corrupt)
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    }
  )
  it.each(['create-uncertain', 'bound'] as const)(
    'quarantines in-place edits before first unpause from %s',
    async (stage) => {
      const f = await fixture()
      f.loseCreate()
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Lost create response')
      if (stage === 'bound') await f.recover()
      const changed = Buffer.from(f.payload)
      changed[0] ^= 255
      await writeFile(f.target, changed)
      const service = await f.recover()
      expect(
        isLegacyImportInactive(f.taskManager.getById(f.taskId) as DownloadTask)
      ).toBe(true)
      await expect(
        service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('changedSource')
      expect(f.adapter.resumeTask).not.toHaveBeenCalled()
      expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
      expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
    }
  )
  it('retains started state so legitimate continued bytes do not invalidate later recovery', async () => {
    const f = await fixture()
    await f.service.activate(f.taskId, async () => f.downloads)
    await writeFile(f.target, Buffer.alloc(LEGACY_HTTP_TOTAL, 1))
    const service = await f.recover()
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    ).toMatchObject({ stage: 'active' })
    vi.mocked(f.adapter.resumeTask).mockImplementation(async () => {})
    await expect(
      service.activate(f.taskId, async () => f.downloads)
    ).resolves.toBe(true)
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledTimes(1)
    expect(f.adapter.createDownload).toHaveBeenCalledTimes(1)
  })
  it('requires a live binding proof before enabling ordinary task actions', async () => {
    const f = await fixture()
    f.badBinding()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('activationUncertain')
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(
      isLegacyImportInactive(f.taskManager.getById(f.taskId) as DownloadTask)
    ).toBe(true)
  })
  it('still requires the full request proof before the first unpause', async () => {
    const f = await fixture()
    vi.mocked(f.adapter.verifyLegacyHttpBinding!).mockImplementation(
      async (input) => !input.request
    )
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('activationUncertain')
    expect(f.adapter.verifyLegacyHttpBinding).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.any(Object) })
    )
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      false
    )
  })
  it('discards unsupported cookie-file dependencies while retaining content verification', async () => {
    const f = await fixture({
      requestLines: ' load-cookies=/tmp/private-cookies\n',
    })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).resolves.toBe(true)
    expect(f.verifier.verifyLegacyContent).toHaveBeenCalledOnce()
    expect(f.adapter.importLegacyCheckpoint).toHaveBeenCalledOnce()
    expect(
      JSON.stringify(f.verifier.verifyLegacyContent.mock.calls)
    ).not.toContain('/tmp/private-cookies')
    expect(
      JSON.stringify(vi.mocked(f.adapter.createDownload).mock.calls)
    ).not.toContain('/tmp/private-cookies')
  })
  it.each(['symlink', 'hardlink'] as const)(
    'refuses a %s payload',
    async (kind) => {
      const f = await fixture()
      await rename(f.target, `${f.target}.old`)
      await (kind === 'symlink' ? symlink : link)(`${f.target}.old`, f.target)
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow(kind === 'symlink' ? 'unsafePath' : 'payloadUnsafe')
      expect(f.verifier.verifyLegacyContent).not.toHaveBeenCalled()
    }
  )
  it('requires the original directory and available payload/control', async () => {
    const f = await fixture()
    expect(await f.service.activate(f.taskId, async () => null)).toBe(false)
    await expect(
      f.service.activate(f.taskId, async () => f.root)
    ).rejects.toThrow('originalDirectoryRequired')
    await rm(`${f.target}.aria2`)
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('controlRequired')
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
  })
  it('cancels verification without importing and admits a later explicit retry', async () => {
    const f = await fixture()
    let reached: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    f.verifier.verifyLegacyContent.mockImplementationOnce(
      async ({ signal }) => {
        reached()
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        throw new Error('aborted')
      }
    )
    const activation = f.service.activate(f.taskId, async () => f.downloads)
    await started
    f.service.cancel(f.taskId)
    await expect(activation).rejects.toThrow('httpVerificationCancelled')
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
    expect(await f.service.activate(f.taskId, async () => f.downloads)).toBe(
      true
    )
  })
  it('cancels the initial directory picker and discards its later result', async () => {
    const f = await fixture()
    let reached: () => void = () => {}
    let choose: (directory: string) => void = () => {}
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    const activation = f.service.activate(f.taskId, async () => {
      reached()
      return new Promise<string>((resolve) => {
        choose = resolve
      })
    })
    await started
    f.service.cancel(f.taskId)
    expect(await activation).toBe(false)
    choose(f.downloads)
    await Promise.resolve()
    expect(f.verifier.verifyLegacyContent).not.toHaveBeenCalled()
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
    expect(f.adapter.createDownload).not.toHaveBeenCalled()
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    ).toBeUndefined()
  })
  it('drains an open picker without leaving shutdown waiting for user input', async () => {
    const f = await fixture()
    let reached: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    const activation = f.service.activate(f.taskId, async () => {
      reached()
      return new Promise<string>(() => {})
    })
    await started
    await f.service.drain()
    expect(await activation).toBe(false)
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
  })
})
