// @vitest-environment node
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { legacyBtActivationSchema } from '@shared/schemas/legacy-bt-activation'
import type { LegacyCheckpointReceipt } from '@shared/schemas/legacy-checkpoint'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { isLegacyImportInactive } from '@shared/types/task-actions'
import { legacyBtActivationFixture } from '@test-utils/legacy-bt-activation-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyBtActivationService } from './bt-activation-service'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})
async function fixture() {
  let receipt: LegacyCheckpointReceipt | null = null
  let engine: DownloadTask | null = null
  let loseImport = false
  let loseAdd = false
  let binding = true
  let f: Awaited<ReturnType<typeof legacyBtActivationFixture>>
  const adapter = {
    supportsLegacyBtActivation: vi.fn(async () => true),
    inspectLegacyCheckpoint: vi.fn(async () => ({
      type: 'bt',
      totalBytes: 32768,
      pieceBytes: 16384,
      infoHash: '45c7c651e500cc0ceaa544d6fbafcb21b8cd52f8',
      completedBytes: 0,
      uploadedBytes: 0,
      ranges: [],
      sourceDigest:
        '9eca779c68d5814eea38b1f4b2c7d73e528a88993f8ade862ca8db90adc5b7eb',
    })),
    reconcileLegacyCheckpoint: vi.fn(
      async (input) => receipt ?? { ...input, status: 'absent' }
    ),
    importLegacyCheckpoint: vi.fn(async (input) => {
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
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
    getTaskStatus: vi.fn(async () => engine),
    listActiveAndWaiting: vi.fn(async () =>
      engine ? [{ gid: engine.engineTaskId, infoHash: engine.infoHash }] : []
    ),
    listStopped: vi.fn(async () => []),
    addTorrent: vi.fn(async (params) => {
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
      ).toMatchObject({ stage: 'create-uncertain', engineTaskId: params.gid })
      expect(params).toMatchObject({
        saveDir: f.downloads,
        pause: true,
        selectedFiles: [1],
        checkIntegrity: true,
        btSeedUnverified: false,
        legacyCheckpointActivation: expect.objectContaining({
          targetPath: path.join(f.downloads, 'fixture-bundle'),
        }),
      })
      expect(params.outputRoot).toBeUndefined()
      expect(f.taskManager.isEngineTaskIdRetired(params.gid)).toBe(true)
      engine = {
        ...f.taskManager.getById(f.taskId),
        engineTaskId: params.gid,
        status: TaskStatus.Paused,
      } as DownloadTask
      if (loseAdd) {
        loseAdd = false
        throw new Error('Lost add response')
      }
      return params.gid
    }),
    verifyLegacyBtBinding: vi.fn(async () => binding),
    pauseTask: vi.fn(async () => {
      if (engine) engine.status = TaskStatus.Paused
    }),
    resumeTask: vi.fn(async () => {
      const pair = f.db.getTask(f.taskId)
      expect(pair?.instances[0].payload.legacyImport).toMatchObject({
        activation: 'active',
        storagePolicy: 'legacy-bt-in-place',
      })
      expect(pair?.instances[0].payload.legacyBtActivation).toMatchObject({
        stage: 'bound',
      })
      if (engine) engine.status = TaskStatus.Downloading
    }),
  } as unknown as EngineAdapter
  f = await legacyBtActivationFixture(adapter)
  cleanup.push(f.dispose)
  return {
    ...f,
    adapter,
    loseImport: () => {
      loseImport = true
    },
    loseAdd: () => {
      loseAdd = true
    },
    badProof: () => {
      binding = false
    },
    consume: () => {
      if (receipt) receipt.status = 'consumed'
      engine = null
    },
    disappear: () => {
      engine = null
    },
    recover: async () => {
      const s = new LegacyBtActivationService(f.deps)
      await s.recover()
      return s
    },
  }
}

describe('durable BT legacy activation', () => {
  it('binds exact original layout/selection before unpause and backs up actual control bytes', async () => {
    const f = await fixture()
    const original = await readFile(
      path.join(f.downloads, 'fixture-bundle/first.bin')
    )
    expect(await f.service.activate(f.taskId, async () => f.downloads)).toBe(
      true
    )
    const pair = f.db.getTask(f.taskId)
    const intent = legacyBtActivationSchema.parse(
      pair?.instances[0].payload.legacyBtActivation
    )
    expect(intent.stage).toBe('active')
    expect(intent.files).toHaveLength(2)
    expect(intent.selectedFiles).toEqual([0])
    expect(await readFile(intent.controlBackupPath)).toEqual(
      await readFile(path.join(f.downloads, 'fixture-bundle.aria2'))
    )
    expect(
      await readFile(path.join(f.downloads, 'fixture-bundle/first.bin'))
    ).toEqual(original)
    expect(isLegacyImportInactive(f.taskManager.getById(f.taskId)!)).toBe(false)
    expect(f.adapter.addTorrent).toHaveBeenCalledTimes(1)
  })
  it('reconciles a lost checkpoint import response without duplicating the mutation', async () => {
    const f = await fixture()
    f.loseImport()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost import response')
    await f.recover()
    expect(f.adapter.importLegacyCheckpoint).toHaveBeenCalledTimes(1)
    expect(f.adapter.addTorrent).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyBtActivation
    ).toMatchObject({ stage: 'bound' })
  })
  it('reconciles a lost add response with the reserved GID and keeps restart paused', async () => {
    const f = await fixture()
    f.loseAdd()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost add response')
    await f.recover()
    expect(f.adapter.addTorrent).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(isLegacyImportInactive(f.taskManager.getById(f.taskId)!)).toBe(false)
  })
  it('never recreates consumed or unknown absent engine state', async () => {
    const f = await fixture()
    f.loseAdd()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow()
    f.consume()
    await f.recover()
    expect(f.adapter.addTorrent).toHaveBeenCalledTimes(1)
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(isLegacyImportInactive(f.taskManager.getById(f.taskId)!)).toBe(true)
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('activationUncertain')
  })
  it('keeps a failed binding protected and never unpauses it', async () => {
    const f = await fixture()
    f.badProof()
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('activationUncertain')
    expect(f.adapter.resumeTask).not.toHaveBeenCalled()
    expect(isLegacyImportInactive(f.taskManager.getById(f.taskId)!)).toBe(true)
  })
  it('refuses unsupported engine, relocation, missing unselected file, and cancel without side effects', async () => {
    const f = await fixture()
    expect(await f.service.activate(f.taskId, async () => null)).toBe(false)
    await expect(
      f.service.activate(f.taskId, async () => f.root)
    ).rejects.toThrow('originalDirectoryRequired')
    await rm(path.join(f.downloads, 'fixture-bundle/second.bin'))
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('payloadMissing')
    vi.mocked(f.adapter.supportsLegacyBtActivation!).mockResolvedValue(false)
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('checkpointUnavailable')
    expect(f.adapter.importLegacyCheckpoint).not.toHaveBeenCalled()
    expect(f.adapter.addTorrent).not.toHaveBeenCalled()
  })
  it('rejects a source save during directory picker and concurrent double clicks', async () => {
    const f = await fixture()
    let release: (path: string) => void = () => {}
    const pending = f.service.activate(
      f.taskId,
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    await vi.waitFor(() =>
      expect(f.adapter.supportsLegacyBtActivation).toHaveBeenCalled()
    )
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('busy')
    await writeFile(path.join(f.profile, 'download.session'), '# changed\n')
    release(f.downloads)
    await expect(pending).rejects.toThrow('changedSource')
    expect(f.adapter.addTorrent).not.toHaveBeenCalled()
  })
  it('releases a pending picker on shutdown', async () => {
    const f = await fixture()
    const pending = f.service.activate(f.taskId, () => new Promise(() => {}))
    await vi.waitFor(() =>
      expect(f.adapter.supportsLegacyBtActivation).toHaveBeenCalled()
    )
    await f.service.drain()
    expect(await pending).toBe(false)
    expect(f.adapter.addTorrent).not.toHaveBeenCalled()
  })
})
