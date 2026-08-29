import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '../../engine/engine-adapter'
import { DIRECT_RESOURCE_METADATA_PROFILE } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import { TaskManager } from '../task-manager'
import type { TorrentMetaStore } from '../torrent-meta-store'
import { reAddTask } from './re-add-task'

const RESERVED_GID = '0123456789abcdef'

function buildSingleFileTorrent(name: string): Uint8Array {
  const nameField = `4:name${Buffer.byteLength(name, 'utf8')}:${name}`
  const prefix = Buffer.from(
    `d4:infod6:lengthi1024e${nameField}12:piece lengthi16384e6:pieces20:`,
    'utf8'
  )
  return new Uint8Array(
    Buffer.concat([prefix, Buffer.alloc(20), Buffer.from('ee')])
  )
}

function makeBtTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    engineTaskId: 'old-gid',
    name: 'sample.torrent',
    kind: TaskKind.Bt,
    type: TaskType.Bt,
    status: TaskStatus.Completed,
    progress: 1,
    totalBytes: 1024,
    downloadedBytes: 1024,
    saveDir: '/tmp',
    finishedAt: 0,
    fileCount: 1,
    infoHash: 'abc',
    metadataProgress: 1,
    filename: 'sample',
    sizeWhenDone: 1024,
    diskPath: '/tmp/sample',
    finalPath: '/tmp/sample',
    finalName: 'sample',
    torrentMetaPath: '/sidecar/sample.torrent',
    bt: makeDefaultBtExtension({ selectedFiles: [0] }),
    ...overrides,
  })
}

function makeDeps(task: DownloadTask | undefined) {
  let currentTask = task
  const base = {
    taskManager: {
      getById: vi.fn(() => currentTask),
      set: vi.fn((_id: string, next: DownloadTask) => {
        currentTask = next
      }),
      getAll: vi.fn(() => (currentTask ? [currentTask] : [])),
      reserveEngineTaskId: vi.fn(),
      setReservedEngineTaskOwner: vi.fn((_id: string, owner: DownloadTask) => {
        currentTask = owner
      }),
      releaseEngineTaskIdReservation: vi.fn(() => true),
      retireEngineTaskIdReservation: vi.fn(() => true),
    } as unknown as TaskManager,
    adapter: {
      getFeatureReport: vi.fn(),
      getDirectResourceMetadataProfile: vi.fn(
        () => DIRECT_RESOURCE_METADATA_PROFILE
      ),
      getEngineTaskOptions: vi.fn().mockResolvedValue(null),
      forceRemoveTask: vi.fn().mockResolvedValue(undefined),
      removeDownloadResult: vi.fn().mockResolvedValue(undefined),
      addTorrent: vi.fn(async ({ gid }: { gid?: string }) => gid ?? ''),
      createDownload: vi.fn(async ({ gid }: { gid?: string }) => gid ?? ''),
    } as unknown as EngineAdapter,
    torrentMetaStore: {
      read: vi.fn().mockResolvedValue(new Uint8Array([0x64, 0x38])),
    } as unknown as TorrentMetaStore,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    persistTask: vi.fn().mockResolvedValue(undefined),
    recordTransition: vi.fn().mockResolvedValue(undefined),
    createEngineTaskId: () => RESERVED_GID,
    runTaskMutation: async <T>(
      _taskIds: readonly string[],
      operation: () => Promise<T>
    ): Promise<T> => operation(),
  }
  return { ...base, ...directTaskUpdatePublication(base) }
}

describe('reAddTask (BT path)', () => {
  it('reads torrent metadata and calls addTorrent with checkIntegrity', async () => {
    const task = makeBtTask({ status: TaskStatus.Completed })
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.torrentMetaStore.read).toHaveBeenCalledWith(
      '/sidecar/sample.torrent'
    )
    expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({
        gid: RESERVED_GID,
        saveDir: '/tmp/sample',
        checkIntegrity: true,
        pause: false,
        selectedFiles: [1],
      })
    )
  })

  it.each([
    {
      label: 'completed reseed',
      status: TaskStatus.Completed,
      expectedSaveDir: '/tmp',
      expectedOutput: 'User chosen.iso',
    },
    {
      label: 'failed download retry',
      status: TaskStatus.Error,
      expectedSaveDir: '/tmp/.motrix/0123456789abcdefabcd',
      expectedOutput: 'p',
    },
  ])(
    'restores indexed paths for $label',
    async ({ status, expectedSaveDir, expectedOutput }) => {
      const workspacePath = '/tmp/.motrix/0123456789abcdefabcd'
      const task = withPrimaryInstance(
        makeBtTask({
          status,
          diskPath:
            status === TaskStatus.Completed
              ? '/tmp/User chosen.iso'
              : workspacePath,
          finalPath: '/tmp/User chosen.iso',
          finalName: 'User chosen.iso',
        })
      )
      task.instances[0].payload = {
        btStorageLayout: {
          version: 1,
          strategy: 'indexed-staging',
          workspacePath,
          payloadEntry: 'p',
          torrentRootName: 'original.iso',
          multiFile: false,
        },
      }
      const deps = makeDeps(task)
      ;(
        deps.torrentMetaStore.read as ReturnType<typeof vi.fn>
      ).mockResolvedValue(buildSingleFileTorrent('original.iso'))

      await reAddTask('t1', deps)

      expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
        expect.objectContaining({
          saveDir: expectedSaveDir,
          outputFilePaths: [{ fileIndex: 0, relativePath: expectedOutput }],
        })
      )
    }
  )

  it('writes the new gid to the task and sets status Seeding', async () => {
    const task = makeBtTask()
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        engineTaskId: RESERVED_GID,
        status: TaskStatus.Seeding,
        finishedAt: null,
        errorMessage: null,
        errorCode: null,
      })
    )
  })

  it('emits TaskUpdated after set', async () => {
    const task = makeBtTask()
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.taskManager.set).toHaveBeenCalled()
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('does not publish, record, or emit when the re-add durable barrier fails', async () => {
    const task = makeBtTask()
    const deps = makeDeps(task)
    deps.persistTask.mockRejectedValueOnce(new Error('disk full'))

    await expect(reAddTask('t1', deps)).rejects.toThrow('disk full')

    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.taskManager.reserveEngineTaskId).toHaveBeenCalledWith(
      RESERVED_GID
    )
    expect(
      deps.taskManager.releaseEngineTaskIdReservation
    ).toHaveBeenCalledWith(RESERVED_GID)
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('best-effort cleanup: ignores forceRemoveTask "is not found"', async () => {
    const task = makeBtTask()
    const deps = makeDeps(task)
    ;(
      deps.adapter.forceRemoveTask as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('GID old-gid is not found'))
    await expect(reAddTask('t1', deps)).resolves.not.toThrow()
    expect(deps.adapter.addTorrent).toHaveBeenCalled()
  })

  it('warns and no-ops when torrentMetaPath is null (canReseed guard)', async () => {
    // canReseed returns false when torrentMetaPath is null, so
    // reAddTask warns and exits without calling addTorrent
    const task = makeBtTask({ torrentMetaPath: null })
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1' }),
      'reAddTask: task is not in a re-addable state'
    )
  })

  it('throws TaskNotRetryable when retrying a BT task with no torrentMetaPath', async () => {
    // Superseded by the capability gate (canRebuildTaskInputs): a torrent-like
    // task with no sidecar metadata can't be re-added, so this is now rejected
    // up front as TaskNotRetryable rather than reaching readBtMetadata's own
    // TaskFinalizeMetaMissing check deeper in the flow.
    const task = makeBtTask({
      status: TaskStatus.Error,
      torrentMetaPath: null,
    })
    const deps = makeDeps(task)
    await expect(reAddTask('t1', deps)).rejects.toMatchObject({
      code: ErrorCode.TaskNotRetryable,
    })
    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.torrentMetaStore.read).not.toHaveBeenCalled()
  })

  it('throws TaskNotRetryable for a Mux media task before any engine call', async () => {
    const task = makeDownloadTask({
      id: 't-mux',
      engineTaskId: 'mux-gid',
      kind: TaskKind.Mux,
      type: TaskType.Http,
      status: TaskStatus.Error,
      uris: ['https://example.com/playlist.m3u8'],
    })
    const deps = makeDeps(task)
    await expect(reAddTask('t-mux', deps)).rejects.toMatchObject({
      code: ErrorCode.TaskNotRetryable,
    })
    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.adapter.createDownload).not.toHaveBeenCalled()
    expect(deps.adapter.getEngineTaskOptions).not.toHaveBeenCalled()
    expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
  })

  it('warns and no-ops when task is not found', async () => {
    const deps = makeDeps(undefined)
    await reAddTask('missing', deps)
    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalled()
  })

  it('warns and no-ops when status is not Error/Removed/Completed-BT', async () => {
    const task = makeBtTask({ status: TaskStatus.Downloading })
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1' }),
      'reAddTask: task is not in a re-addable state'
    )
  })
})

/**
 * A BT task in Error — the only shape that still reaches the engine through
 * the retry gate now that `canRebuildTaskInputs` rejects HTTP/FTP. Its
 * content is still in the in-flight `.motrix` container because finalize
 * never ran.
 */
function makeBtErrorTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeBtTask({
    status: TaskStatus.Error,
    progress: 0.5,
    downloadedBytes: 512,
    finishedAt: 1234,
    errorMessage: 'connection reset',
    diskPath: '/tmp/sample.motrix',
    finalPath: '/tmp/sample',
    ...overrides,
  })
}

function makeHttpTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return withPrimaryInstance(
    makeDownloadTask({
      id: 't2',
      engineTaskId: 'old-http-gid',
      name: 'file.zip',
      status: TaskStatus.Error,
      saveDir: '/tmp',
      errorMessage: 'connection reset',
      finishedAt: 1234,
      uris: ['https://example.com/file.zip'],
      fileCount: 1,
      filename: 'file.zip',
      diskPath: '/tmp/file.zip.motrix',
      finalPath: '/tmp/file.zip',
      finalName: 'file.zip',
      ...overrides,
    })
  )
}

function withPrimaryInstance(task: DownloadTask): DownloadTask {
  return {
    ...task,
    instances: [
      {
        instanceId: `${task.id}:primary`,
        motrixId: task.id,
        gid: task.engineTaskId,
        phase:
          task.type === TaskType.Bt
            ? TaskInstancePhase.BtDownload
            : TaskInstancePhase.HttpDownload,
        status: task.status,
        progress: task.progress,
        totalBytes: task.totalBytes,
        downloadedBytes: task.downloadedBytes,
        uploadedBytes: task.uploadedBytes,
        diskPath: task.diskPath,
        transitionPhase: task.transitionPhase,
        uris: task.uris,
        uriHash: null,
        payload: {},
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    ],
  }
}

describe('reAddTask (HTTP path)', () => {
  it('retries a URI-only HTTP task at its exact .motrix output path', async () => {
    const task = makeHttpTask()
    task.instances[0].payload = {
      directReplay: {
        version: 1,
        connections: 6,
        requestModifiers: [],
        replayability: 'uri-only',
      },
    }
    const deps = makeDeps(task)

    await reAddTask('t2', deps)

    expect(deps.adapter.createDownload).toHaveBeenCalledWith({
      uris: ['https://example.com/file.zip'],
      gid: RESERVED_GID,
      saveDir: '/tmp',
      filename: 'file.zip.motrix',
      connections: 6,
      pause: false,
      resumePolicy: 'none',
    })
    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't2',
      expect.objectContaining({
        engineTaskId: RESERVED_GID,
        status: TaskStatus.Downloading,
      })
    )
  })

  it('uses checkpoint resume for a non-empty HTTP partial with .aria2 state', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'motrix-direct-readd-')
    )
    const diskPath = path.join(tempDir, 'file.zip.motrix')
    try {
      fs.writeFileSync(diskPath, Buffer.alloc(32, 0x61))
      fs.writeFileSync(`${diskPath}.aria2`, Buffer.alloc(16, 0x62))
      const task = makeHttpTask({
        diskPath,
        finalPath: path.join(tempDir, 'file.zip'),
      })
      task.instances[0].diskPath = diskPath
      task.instances[0].payload = {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
          resourceValidator: {
            kind: 'strong-etag',
            value: '"release-v1"',
            contentLength: 4096,
            capturedAt: 7,
          },
        },
      }
      const deps = makeDeps(task)
      let currentUserAgent = 'Motrix/Verified'
      const verify = vi.fn(async () => {
        currentUserAgent = 'Motrix/Newer'
        return {
          outcome: 'unchanged' as const,
          ifRange: '"release-v1"',
        }
      })
      const proxyOptions = {
        proxy: 'http://proxy.example:8080',
        noProxy: '.internal',
        userAgent: 'Motrix/Verified',
      }

      await reAddTask('t2', {
        ...deps,
        directResourceValidator: { verify },
        getDirectResourceProxyOptions: () => ({
          ...proxyOptions,
          userAgent: currentUserAgent,
        }),
      })

      expect(verify).toHaveBeenCalledWith(
        'https://example.com/file.zip',
        expect.objectContaining({ value: '"release-v1"' }),
        proxyOptions
      )
      expect(deps.adapter.createDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          saveDir: tempDir,
          filename: 'file.zip.motrix',
          headers: { 'If-Range': '"release-v1"' },
          userAgent: 'Motrix/Verified',
          resumePolicy: 'checkpoint',
        })
      )
      expect(deps.adapter.createDownload).not.toHaveBeenCalledWith(
        expect.objectContaining({ proxy: expect.anything() })
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects a checkpoint with no resource validator before mutation', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'motrix-direct-no-validator-')
    )
    const diskPath = path.join(tempDir, 'file.zip.motrix')
    try {
      fs.writeFileSync(diskPath, Buffer.from('partial'))
      fs.writeFileSync(`${diskPath}.aria2`, Buffer.from('checkpoint'))
      const task = makeHttpTask({
        diskPath,
        finalPath: path.join(tempDir, 'file.zip'),
      })
      task.instances[0].diskPath = diskPath
      task.instances[0].payload = {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
        },
      }
      const deps = makeDeps(task)
      const verify = vi.fn()

      await expect(
        reAddTask('t2', {
          ...deps,
          directResourceValidator: { verify },
          getDirectResourceProxyOptions: () => ({}),
        })
      ).rejects.toMatchObject({ code: ErrorCode.TaskNotRetryable })

      expect(verify).not.toHaveBeenCalled()
      expect(deps.adapter.createDownload).not.toHaveBeenCalled()
      expect(deps.persistTask).not.toHaveBeenCalled()
      expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(fs.existsSync(diskPath)).toBe(true)
      expect(fs.existsSync(`${diskPath}.aria2`)).toBe(true)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it.each(['unchanged', 'source-changed', 'unverifiable'] as const)(
    'rejects a stale %s validation result before durable intent',
    async (outcome) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-direct-readd-proxy-lease-')
      )
      const diskPath = path.join(tempDir, 'file.zip.motrix')
      try {
        fs.writeFileSync(diskPath, Buffer.alloc(32, 0x61))
        fs.writeFileSync(`${diskPath}.aria2`, Buffer.alloc(16, 0x62))
        const task = makeHttpTask({
          diskPath,
          finalPath: path.join(tempDir, 'file.zip'),
        })
        task.instances[0].diskPath = diskPath
        task.instances[0].payload = {
          directReplay: {
            version: 1,
            requestModifiers: [],
            replayability: 'uri-only',
            resourceValidator: {
              kind: 'strong-etag',
              value: '"release-v1"',
              capturedAt: 7,
            },
          },
        }
        const deps = makeDeps(task)
        const policy = new AppliedDownloadProxyPolicy({
          proxy: 'http://proxy.example:8080',
          noProxy: '.internal',
        })
        const verify = vi.fn(async () => {
          policy.markUnavailable()
          return {
            outcome,
            ifRange: outcome === 'unchanged' ? '"release-v1"' : null,
          }
        })

        await expect(
          reAddTask('t2', {
            ...deps,
            directResourceValidator: { verify },
            directResourceProxyPolicy: policy,
          })
        ).rejects.toThrow('applied download proxy policy changed')

        expect(verify).toHaveBeenCalledOnce()
        expect(deps.adapter.createDownload).not.toHaveBeenCalled()
        expect(deps.persistTask).not.toHaveBeenCalled()
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }
  )

  it('rejects a changed checkpoint source before touching the engine', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'motrix-direct-changed-')
    )
    const diskPath = path.join(tempDir, 'file.zip.motrix')
    try {
      fs.writeFileSync(diskPath, Buffer.from('partial'))
      fs.writeFileSync(`${diskPath}.aria2`, Buffer.from('checkpoint'))
      const task = makeHttpTask({
        diskPath,
        finalPath: path.join(tempDir, 'file.zip'),
      })
      task.instances[0].diskPath = diskPath
      task.instances[0].payload = {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
          resourceValidator: {
            kind: 'strong-etag',
            value: '"release-v1"',
            capturedAt: 7,
          },
        },
      }
      const deps = makeDeps(task)
      const directResourceValidator = {
        verify: vi.fn().mockResolvedValue({
          outcome: 'source-changed',
          ifRange: null,
        }),
      }

      await expect(
        reAddTask('t2', { ...deps, directResourceValidator })
      ).rejects.toMatchObject({ code: ErrorCode.TaskNotRetryable })

      expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(deps.adapter.createDownload).not.toHaveBeenCalled()
      expect(deps.persistTask).not.toHaveBeenCalled()
      expect(fs.readFileSync(diskPath)).toEqual(Buffer.from('partial'))
      expect(fs.readFileSync(`${diskPath}.aria2`)).toEqual(
        Buffer.from('checkpoint')
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not verify or resume when aria2 lacks mirrored header features', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'motrix-direct-feature-profile-')
    )
    const diskPath = path.join(tempDir, 'file.zip.motrix')
    try {
      fs.writeFileSync(diskPath, Buffer.from('partial'))
      fs.writeFileSync(`${diskPath}.aria2`, Buffer.from('checkpoint'))
      const task = makeHttpTask({
        diskPath,
        finalPath: path.join(tempDir, 'file.zip'),
      })
      task.instances[0].diskPath = diskPath
      task.instances[0].payload = {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
          resourceValidator: {
            kind: 'strong-etag',
            value: '"release-v1"',
            capturedAt: 7,
          },
        },
      }
      const deps = makeDeps(task)
      vi.mocked(deps.adapter.getFeatureReport).mockReturnValue({
        version: '1.37.0',
        features: ['Message Digest'],
        hasSqlitePersistence: false,
        hasBtSeedUnverified: false,
        hasBtSaveMetadata: false,
        hasMoveStorage: false,
      })
      const verify = vi.fn()

      await expect(
        reAddTask('t2', {
          ...deps,
          directResourceValidator: { verify },
          getDirectResourceProxyOptions: () => ({}),
        })
      ).rejects.toMatchObject({ code: ErrorCode.TaskNotRetryable })

      expect(verify).not.toHaveBeenCalled()
      expect(deps.adapter.createDownload).not.toHaveBeenCalled()
      expect(deps.persistTask).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects checkpoint recovery before mutation when the ambient profile is unsafe', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'motrix-direct-ambient-profile-')
    )
    const diskPath = path.join(tempDir, 'file.zip.motrix')
    try {
      fs.writeFileSync(diskPath, Buffer.from('partial'))
      fs.writeFileSync(`${diskPath}.aria2`, Buffer.from('checkpoint'))
      const task = makeHttpTask({
        diskPath,
        finalPath: path.join(tempDir, 'file.zip'),
      })
      task.instances[0].diskPath = diskPath
      task.instances[0].payload = {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
          resourceValidator: {
            kind: 'strong-etag',
            value: '"release-v1"',
            capturedAt: 7,
          },
        },
      }
      const deps = makeDeps(task)
      deps.adapter.getDirectResourceMetadataProfile = vi.fn(() => null)
      const verify = vi.fn()

      await expect(
        reAddTask('t2', {
          ...deps,
          directResourceValidator: { verify },
          getDirectResourceProxyOptions: () => ({}),
        })
      ).rejects.toMatchObject({ code: ErrorCode.TaskNotRetryable })

      expect(verify).not.toHaveBeenCalled()
      expect(deps.persistTask).not.toHaveBeenCalled()
      expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(deps.adapter.createDownload).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects HTTP retry before engine mutation when a partial has no checkpoint', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'motrix-direct-blocked-')
    )
    const diskPath = path.join(tempDir, 'file.zip.motrix')
    try {
      fs.writeFileSync(diskPath, Buffer.from('partial'))
      const task = makeHttpTask({
        diskPath,
        finalPath: path.join(tempDir, 'file.zip'),
      })
      task.instances[0].diskPath = diskPath
      task.instances[0].payload = {
        directReplay: {
          version: 1,
          requestModifiers: [],
          replayability: 'uri-only',
        },
      }
      const deps = makeDeps(task)

      await expect(reAddTask('t2', deps)).rejects.toMatchObject({
        code: ErrorCode.TaskNotRetryable,
      })

      expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(deps.adapter.createDownload).not.toHaveBeenCalled()
      expect(deps.persistTask).not.toHaveBeenCalled()
      expect(fs.readFileSync(diskPath)).toEqual(Buffer.from('partial'))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects legacy HTTP retry up front when no replay recipe exists', async () => {
    const task = makeHttpTask()
    const deps = makeDeps(task)

    await expect(reAddTask('t2', deps)).rejects.toMatchObject({
      code: ErrorCode.TaskNotRetryable,
    })

    expect(deps.adapter.createDownload).not.toHaveBeenCalled()
    expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
  })
})

describe('reAddTask reserved GID ownership', () => {
  it('installs the reserved owner before awaiting durability so queued auto-save cannot restore the old gid', async () => {
    let releaseAdd!: () => void
    let markAddStarted!: () => void
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    const addStarted = new Promise<void>((resolve) => {
      markAddStarted = resolve
    })
    const task = withPrimaryInstance(makeBtErrorTask())
    const taskManager = new TaskManager()
    taskManager.add(task)
    const deps = makeDeps(task)
    deps.taskManager = taskManager
    deps.persistTask.mockResolvedValue(undefined)
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ gid }: { gid?: string }) => {
        markAddStarted()
        await addGate
        return gid ?? ''
      }
    )

    const readding = reAddTask(task.id, deps)
    await addStarted
    // Models SessionManager.saveNow() queued immediately behind the durable
    // candidate write. It reads TaskManager when it reaches the queue front.
    const autoSavedSnapshot = structuredClone(
      taskManager.getById(task.id) as DownloadTask
    )
    const emittedBeforeEngineAcceptance = (
      deps.eventBus.emit as ReturnType<typeof vi.fn>
    ).mock.calls.length
    releaseAdd()
    await readding

    expect(autoSavedSnapshot.engineTaskId).toBe(RESERVED_GID)
    expect(autoSavedSnapshot.instances[0]?.gid).toBe(RESERVED_GID)
    expect(autoSavedSnapshot.status).toBe(task.status)
    expect(emittedBeforeEngineAcceptance).toBe(0)
  })

  it.each([
    ['completed reseed', withPrimaryInstance(makeBtTask())],
    ['failed retry', withPrimaryInstance(makeBtErrorTask())],
  ] as const)(
    'shields the caller-reserved gid from orphan adoption until publication (%s)',
    async (_label, task) => {
      const addMethod = 'addTorrent'
      const taskManager = new TaskManager()
      taskManager.add(task)
      const deps = makeDeps(task)
      deps.taskManager = taskManager
      let durableCandidate: DownloadTask | undefined
      deps.persistTask.mockImplementation(async (candidate) => {
        durableCandidate = structuredClone(candidate)
      })

      const engineAdd = vi.fn(async (params: { gid?: string }) => {
        const gid = params.gid
        expect(gid).toBe(RESERVED_GID)
        expect(durableCandidate?.engineTaskId).toBe(gid)
        expect(durableCandidate?.instances[0]?.gid).toBe(gid)
        expect(taskManager.isEngineTaskIdRetired(gid ?? '')).toBe(true)

        // This is the authoritative poll's orphan-adoption gate. The engine
        // has accepted the row, but reAddTask has not published its owner yet.
        if (
          gid &&
          !taskManager.getByEngineTaskId(gid) &&
          !taskManager.isEngineTaskIdRetired(gid)
        ) {
          taskManager.add(
            makeDownloadTask({
              id: 'duplicate-orphan',
              engineTaskId: gid,
              status: TaskStatus.Downloading,
            })
          )
        }
        return gid ?? ''
      })
      ;(
        deps.adapter[addMethod] as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(engineAdd)

      await reAddTask(task.id, deps)

      expect(taskManager.getAll().map((candidate) => candidate.id)).toEqual([
        task.id,
      ])
      expect(taskManager.getByEngineTaskId(RESERVED_GID)?.id).toBe(task.id)
      expect(taskManager.isEngineTaskIdRetired(RESERVED_GID)).toBe(false)
    }
  )

  it('claims and publishes the accepted gid when the post-add persistence refresh fails', async () => {
    const task = withPrimaryInstance(makeBtErrorTask())
    const taskManager = new TaskManager()
    taskManager.add(task)
    const deps = makeDeps(task)
    deps.taskManager = taskManager
    const persistenceError = new Error('post-add persistence unavailable')
    deps.persistTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(persistenceError)

    await expect(reAddTask(task.id, deps)).rejects.toBe(persistenceError)

    const owner = taskManager.getById(task.id)
    expect(owner?.engineTaskId).toBe(RESERVED_GID)
    expect(owner?.instances[0]?.gid).toBe(RESERVED_GID)
    expect(owner?.status).toBe(TaskStatus.Seeding)
    expect(taskManager.getByEngineTaskId(RESERVED_GID)?.id).toBe(task.id)
    expect(taskManager.isEngineTaskIdRetired(RESERVED_GID)).toBe(false)
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        previousStatus: TaskStatus.Error,
        nextStatus: TaskStatus.Seeding,
        accuracy: 'recovered',
      })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('keeps durable and in-process ownership when add outcome is unknown and both cleanup calls fail', async () => {
    const task = withPrimaryInstance(makeBtErrorTask())
    const taskManager = new TaskManager()
    taskManager.add(task)
    const deps = makeDeps(task)
    deps.taskManager = taskManager
    const liveGids = new Set([task.engineTaskId])
    let durableCandidate: DownloadTask | undefined
    deps.persistTask.mockImplementation(async (candidate) => {
      durableCandidate = structuredClone(candidate)
    })
    ;(
      deps.adapter.forceRemoveTask as ReturnType<typeof vi.fn>
    ).mockImplementation(async (gid: string) => {
      if (gid === task.engineTaskId) {
        liveGids.delete(gid)
        return
      }
      throw new Error('force-remove transport unavailable')
    })
    ;(
      deps.adapter.removeDownloadResult as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('remove-result transport unavailable'))
    const addError = new Error('addUri response lost after acceptance')
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ gid }: { gid?: string }) => {
        if (gid) liveGids.add(gid)
        throw addError
      }
    )

    let received: unknown
    try {
      await reAddTask(task.id, deps)
    } catch (error) {
      received = error
    }

    expect(received).toBe(addError)
    expect(durableCandidate?.engineTaskId).toBe(RESERVED_GID)
    expect(durableCandidate?.instances[0]?.gid).toBe(RESERVED_GID)
    expect(liveGids).toEqual(new Set([RESERVED_GID]))
    expect(taskManager.getByEngineTaskId(RESERVED_GID)?.id).toBe(task.id)
    expect(taskManager.getAll()).toHaveLength(1)
    expect(taskManager.isEngineTaskIdRetired(RESERVED_GID)).toBe(false)
    expect(deps.log.error).toHaveBeenCalledTimes(2)
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        previousStatus: TaskStatus.Error,
        nextStatus: TaskStatus.Seeding,
        accuracy: 'recovered',
      })
    )
  })

  it('claims the uncertain accepted gid when recovered publication persistence also fails', async () => {
    const task = withPrimaryInstance(makeBtErrorTask())
    const taskManager = new TaskManager()
    taskManager.add(task)
    const deps = makeDeps(task)
    deps.taskManager = taskManager
    const persistenceError = new Error('recovered publication unavailable')
    deps.persistTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(persistenceError)
    ;(
      deps.adapter.forceRemoveTask as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('force-remove unavailable'))
    ;(
      deps.adapter.removeDownloadResult as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('result cleanup unavailable'))
    const addError = new Error('add response lost')
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValue(
      addError
    )

    await expect(reAddTask(task.id, deps)).rejects.toBe(addError)

    expect(taskManager.getById(task.id)).toMatchObject({
      engineTaskId: RESERVED_GID,
      status: TaskStatus.Seeding,
    })
    expect(taskManager.getByEngineTaskId(RESERVED_GID)?.id).toBe(task.id)
    expect(taskManager.isEngineTaskIdRetired(RESERVED_GID)).toBe(false)
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({ accuracy: 'recovered' })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('restores the previous owner when result cleanup proves absence despite force-remove failure', async () => {
    const task = withPrimaryInstance(makeBtErrorTask())
    const taskManager = new TaskManager()
    taskManager.add(task)
    const deps = makeDeps(task)
    deps.taskManager = taskManager
    const durableWrites: DownloadTask[] = []
    deps.persistTask.mockImplementation(async (candidate) => {
      durableWrites.push(structuredClone(candidate))
    })
    ;(
      deps.adapter.forceRemoveTask as ReturnType<typeof vi.fn>
    ).mockImplementation(async (gid: string) => {
      if (gid === RESERVED_GID) {
        throw new Error('gid already left the active set')
      }
    })
    const addError = new Error('add response lost')
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValue(
      addError
    )

    await expect(reAddTask(task.id, deps)).rejects.toBe(addError)

    expect(deps.adapter.removeDownloadResult).toHaveBeenCalledWith(RESERVED_GID)
    expect(durableWrites).toHaveLength(2)
    expect(durableWrites[0].engineTaskId).toBe(RESERVED_GID)
    expect(durableWrites[1].engineTaskId).toBe(task.engineTaskId)
    expect(taskManager.getById(task.id)).toBe(task)
    expect(taskManager.getByEngineTaskId(RESERVED_GID)).toBeUndefined()
    expect(taskManager.isEngineTaskIdRetired(RESERVED_GID)).toBe(true)
    expect(deps.recordTransition).not.toHaveBeenCalled()
  })

  it('retires the dispatched reservation after cleanup so a stale poll snapshot stays shielded', async () => {
    const task = withPrimaryInstance(makeBtErrorTask())
    const taskManager = new TaskManager()
    taskManager.add(task)
    const deps = makeDeps(task)
    deps.taskManager = taskManager
    const durableWrites: DownloadTask[] = []
    deps.persistTask.mockImplementation(async (candidate) => {
      durableWrites.push(structuredClone(candidate))
    })
    const addError = new Error('addUri response lost after acceptance')
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValue(
      addError
    )

    await expect(reAddTask(task.id, deps)).rejects.toBe(addError)

    expect(durableWrites).toHaveLength(2)
    expect(durableWrites[0].engineTaskId).toBe(RESERVED_GID)
    expect(durableWrites[1].engineTaskId).toBe(task.engineTaskId)
    expect(taskManager.getByEngineTaskId(RESERVED_GID)).toBeUndefined()
    expect(taskManager.isEngineTaskIdRetired(RESERVED_GID)).toBe(true)

    // A poll captured the accepted row before compensation completed. Its
    // delayed reconciliation must still see the retired shield.
    if (
      !taskManager.getByEngineTaskId(RESERVED_GID) &&
      !taskManager.isEngineTaskIdRetired(RESERVED_GID)
    ) {
      taskManager.add(
        makeDownloadTask({
          id: 'late-duplicate-orphan',
          engineTaskId: RESERVED_GID,
          status: TaskStatus.Downloading,
        })
      )
    }
    expect(taskManager.getAll().map((candidate) => candidate.id)).toEqual([
      task.id,
    ])
  })
})

describe('characterization: reAddTask adapter call params', () => {
  it('reAddBt converts 0-based task selection to native 1-based indices', async () => {
    // Uses a non-trivial multi-index value so an accidental pass-through is
    // visible: the task aggregate is engine-neutral, AddTorrentParams is not.
    const task = makeBtTask({
      bt: makeDefaultBtExtension({ selectedFiles: [0, 2], isPrivate: true }),
    })
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    const arg = (deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(arg.selectedFiles).toEqual([1, 3])
    expect(arg.checkIntegrity).toBe(true)
    expect(arg.pause).toBe(false)
    expect(arg.isPrivate).toBe(task.bt!.isPrivate)
  })

  it('a failed BT retry re-adds into the in-flight .motrix container', async () => {
    // The partial content is at diskPath; checkIntegrity against finalPath
    // would scan an empty directory and restart the download from zero.
    const task = makeBtErrorTask()
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ saveDir: '/tmp/sample.motrix' })
    )
  })

  it('a completed reseed re-adds against the renamed final output', async () => {
    // finalize already renamed the container; the seedable content is at
    // finalPath even if a legacy row still carries a stale `.motrix`
    // diskPath.
    const task = makeBtTask({
      status: TaskStatus.Completed,
      diskPath: '/tmp/sample.motrix',
      finalPath: '/tmp/sample',
    })
    const deps = makeDeps(task)
    await reAddTask('t1', deps)
    expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ saveDir: '/tmp/sample' })
    )
    const params = (deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(params).not.toHaveProperty('prioritizePreviewPieces')
  })

  it('preserves preview piece priority when re-adding a video-only torrent', async () => {
    const task = makeBtErrorTask()
    const deps = makeDeps(task)
    ;(deps.torrentMetaStore.read as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildSingleFileTorrent('Movie.mp4')
    )

    await reAddTask('t1', deps)

    expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ prioritizePreviewPieces: true })
    )
  })
})
