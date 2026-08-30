import fs from 'node:fs'
import type { SegmentProgress } from '@core/download/segment-downloader'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaCoordinatorDeps, MediaJob } from './media-task-coordinator'
import { MediaTaskCoordinator } from './media-task-coordinator'
import { TaskManager } from './task-manager'

// ---------------------------------------------------------------------------
// Fake implementations
// ---------------------------------------------------------------------------

/** Fake SegmentDownloader: resolves immediately with stub paths. */
function makeDownloaderFake(opts?: {
  initPath?: string
  partPaths?: string[]
  hang?: boolean
  /** Progress sequence to emit; defaults to a byte-less 0.5 → 1 fraction. */
  report?: SegmentProgress[]
  /** Active segment gids this stream reports (Bug B). */
  activeGids?: string[]
}) {
  const cancelFn = vi.fn(async () => {})
  let rejectRun: ((err: Error) => void) | null = null

  const runFn = vi.fn(
    async (
      _plan: unknown,
      _headers: unknown,
      onProgress: (p: SegmentProgress) => void
    ): Promise<{ initPath?: string; partPaths: string[] }> => {
      if (opts?.hang) {
        return new Promise<{ initPath?: string; partPaths: string[] }>(
          (_resolve, reject) => {
            rejectRun = reject
            // Register cancel to trigger the rejection
            cancelFn.mockImplementation(async () => {
              rejectRun?.(new Error('SegmentDownloader: cancelled'))
            })
          }
        )
      }
      const reports = opts?.report ?? [
        { fraction: 0.5, downloadedBytes: 0, totalBytes: 0 },
        { fraction: 1, downloadedBytes: 0, totalBytes: 0 },
      ]
      for (const r of reports) onProgress(r)
      return {
        initPath: opts?.initPath,
        partPaths: opts?.partPaths ?? ['/tmp/000001.seg'],
      }
    }
  )

  return {
    run: runFn,
    cancel: cancelFn,
    getActiveGids: () => opts?.activeGids ?? [],
    getActiveGidCount: () => (opts?.activeGids ?? []).length,
    _rejectRun: () =>
      rejectRun?.call(null, new Error('SegmentDownloader: cancelled')),
  }
}

/** Fake SegmentDecryptor: identity (no actual decryption). */
function makeDecryptorFake() {
  return {
    decrypt: vi.fn((ct: Uint8Array, _key: Uint8Array, _iv: Uint8Array) => ct),
    getKey: vi.fn(async (_uri: string) => new Uint8Array(16)),
  }
}

/** Fake assembleSegments: just records calls. */
function makeAssembleFake() {
  return vi.fn(async (_args: unknown) => {})
}

/** Fake FfmpegService: resolves immediately. */
function makeFfmpegFake() {
  return {
    run: vi.fn(
      async (_job: unknown, onProgress: (p: { progress: number }) => void) => {
        onProgress({ progress: 0.5 })
        onProgress({ progress: 1 })
      }
    ),
    kill: vi.fn(),
    buildArgs: vi.fn(() => []),
  }
}

/** Fake FfmpegService that hangs until kill() is called. */
function makeBlockingFfmpegFake() {
  let rejectRun!: (err: Error) => void
  const killFn = vi.fn(() => {
    rejectRun(new Error('mux-aborted'))
  })
  const runFn = vi.fn(
    async (
      _job: unknown,
      _onProgress: (p: { progress: number }) => void
    ): Promise<void> => {
      return new Promise<void>((_resolve, reject) => {
        rejectRun = reject
      })
    }
  )
  return { run: runFn, kill: killFn, buildArgs: vi.fn(() => []) }
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<MediaCoordinatorDeps>): {
  deps: MediaCoordinatorDeps
  taskManager: TaskManager
  emitted: string[]
  downloaderFakes: ReturnType<typeof makeDownloaderFake>[]
  assembleFake: ReturnType<typeof makeAssembleFake>
  ffmpegFakes: ReturnType<typeof makeFfmpegFake>[]
  decryptorFake: ReturnType<typeof makeDecryptorFake>
} {
  const taskManager = new TaskManager()
  const emitted: string[] = []
  const eventBus = {
    emit: vi.fn((e: string, _payload?: unknown) => emitted.push(e)),
  }

  const downloaderFakes: ReturnType<typeof makeDownloaderFake>[] = []
  const assembleFake = makeAssembleFake()
  const ffmpegFakes: ReturnType<typeof makeFfmpegFake>[] = []
  const decryptorFake = makeDecryptorFake()

  const deps: MediaCoordinatorDeps = {
    taskManager,
    activityRecorder: {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    },
    eventBus,
    resolveFfmpegBinaryPath: vi.fn(async () => '/usr/bin/ffmpeg'),
    makeDownloader: (_tmpDir: string) => {
      const fake = makeDownloaderFake()
      downloaderFakes.push(fake)
      return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
    },
    decryptor:
      decryptorFake as unknown as import('@core/media/segment-decryptor').SegmentDecryptor,
    assemble:
      assembleFake as unknown as typeof import('@core/media/segment-assembler').assembleSegments,
    makeFfmpeg: () => {
      const fake = makeFfmpegFake()
      ffmpegFakes.push(fake)
      return fake as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService
    },
    mkdtemp: async () => '/tmp/fake-media-job',
    mintTaskId: () => 'stable-task-id',
    persist: vi.fn(async () => {}),
    // Identity picker: collision-free by default; placeholder-contract tests
    // override it to simulate an EEXIST re-pick.
    pickName: vi.fn(async (_dir: string, desired: string) => desired),
    // Spy pass-throughs: legacy emit-count/snapshot assertions stay valid
    // while the production path routes through the publisher.
    publishTaskUpdate: vi.fn(() => {
      eventBus.emit(Events.TaskUpdated, taskManager.getAll())
    }),
    publishTaskUpdateNow: vi.fn(() => {
      eventBus.emit(Events.TaskUpdated, taskManager.getAll())
    }),
    ...overrides,
  }

  return {
    deps,
    taskManager,
    emitted,
    downloaderFakes,
    assembleFake,
    ffmpegFakes,
    decryptorFake,
  }
}

// ---------------------------------------------------------------------------
// Base job shapes
// ---------------------------------------------------------------------------

const videoOnlyPlan = (): MediaJob['video'] => ({
  container: 'mpegts',
  segments: [{ url: 'https://cdn/seg1.ts', index: 0 }],
  isComplete: true,
})

const baseJob = (): MediaJob => ({
  video: videoOnlyPlan(),
  headers: { Referer: 'https://site.com' },
  saveDir: '/save',
  finalName: 'video.mp4',
  sourceMeta: null,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaTaskCoordinator.start', () => {
  // The coordinator touches the real fs: mkdir for temp subdirs + saveDir,
  // writeFile for the `.motrix` placeholder reservation, and rename for the
  // finalize `.motrix` → final move. Stub all three to no-ops so tests don't
  // touch the real filesystem (a fake saveDir like '/save' doesn't exist).
  let mkdirSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockResolvedValue(undefined as never)
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never)
    vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates the output saveDir before muxing (so ffmpeg never ENOENTs)', async () => {
    const { deps } = makeDeps()
    const c = new MediaTaskCoordinator(deps)
    await c.start(baseJob())
    expect(mkdirSpy).toHaveBeenCalledWith('/save', { recursive: true })
  })

  it('acks a detached submit after registration and cancels/drains it during shutdown', async () => {
    const hangingDownloader = makeDownloaderFake({ hang: true })
    const { deps, taskManager } = makeDeps({
      makeDownloader: () =>
        hangingDownloader as unknown as import('@core/download/segment-downloader').SegmentDownloader,
    })
    const coordinator = new MediaTaskCoordinator(deps)

    const result = await coordinator.submit(baseJob())

    expect(result).toEqual({ taskId: 'stable-task-id' })
    expect(taskManager.getById(result.taskId)?.status).toBe(
      TaskStatus.Downloading
    )

    await coordinator.stopAndDrain()

    expect(hangingDownloader.cancel).toHaveBeenCalledOnce()
    expect(taskManager.getById(result.taskId)).toMatchObject({
      status: TaskStatus.Error,
      errorMessage: 'mux-aborted',
    })
    await expect(coordinator.submit(baseJob())).rejects.toThrow(/stopped/)
  })

  it('registers ONE DownloadTask (kind Hls) keyed on a stable taskId', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    const { taskId } = await c.start(baseJob())

    expect(taskId).toBe('stable-task-id')
    const task = taskManager.getById(taskId)
    expect(task).toBeDefined()
    expect(task?.kind).toBe(TaskKind.Hls)
    expect(task?.id).toBe(taskId)
  })

  it('creates logical instances with gid:null (HlsSegment + FfmpegMux for video-only)', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    const { taskId } = await c.start(baseJob())

    const task = taskManager.getById(taskId)
    expect(task?.instances).toBeDefined()
    // Should have HlsSegment + FfmpegMux
    const phases = task?.instances.map((i) => i.phase) ?? []
    expect(phases).toContain(TaskInstancePhase.HlsSegment)
    expect(phases).toContain(TaskInstancePhase.FfmpegMux)
    expect(phases).not.toContain(TaskInstancePhase.HlsAudio)
    // All gid: null
    for (const inst of task?.instances ?? []) {
      expect(inst.gid).toBeNull()
    }
  })

  it('includes HlsAudio instance when audio plan is present', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    const job: MediaJob = {
      ...baseJob(),
      audio: {
        container: 'mpegts',
        segments: [{ url: 'https://cdn/aud1.ts', index: 0 }],
        isComplete: true,
      },
    }

    const { taskId } = await c.start(job)

    const task = taskManager.getById(taskId)
    const phases = task?.instances.map((i) => i.phase) ?? []
    expect(phases).toContain(TaskInstancePhase.HlsAudio)
  })

  it('gid=null instances are NOT in engineIndex (poller-safety)', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob())

    // engineIndex lookup with empty string (the sentinel for gid-less)
    // should be undefined — none of our null-gid instances indexed
    expect(taskManager.getByEngineTaskId('')).toBeUndefined()
  })

  it('emits Events.TaskUpdated at least once', async () => {
    const { deps, emitted } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob())

    expect(
      emitted.filter((e) => e === 'event:taskUpdated').length
    ).toBeGreaterThan(0)
  })

  it('task reaches Completed status after happy path', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    const { taskId } = await c.start(baseJob())

    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.Completed)
    expect(taskManager.getById(taskId)?.finishedAt).not.toBeNull()
  })

  it('uses taskId from job when provided', async () => {
    const { deps, taskManager } = makeDeps({
      mintTaskId: () => 'should-not-use',
    })
    const c = new MediaTaskCoordinator(deps)

    const { taskId } = await c.start({ ...baseJob(), taskId: 'explicit-id' })

    expect(taskId).toBe('explicit-id')
    expect(taskManager.getById('explicit-id')).toBeDefined()
  })

  it('calls assemble with index-ordered partPaths', async () => {
    const { deps, assembleFake } = makeDeps({
      makeDownloader: (_tmpDir: string) => {
        const fake = makeDownloaderFake({
          partPaths: ['/tmp/000001.seg', '/tmp/000002.seg'],
        })
        return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
    })
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob())

    expect(assembleFake).toHaveBeenCalled()
    const callArgs = assembleFake.mock.calls[0]?.[0] as { partPaths: string[] }
    expect(callArgs.partPaths).toEqual(['/tmp/000001.seg', '/tmp/000002.seg'])
  })

  it('passes fromMpegts:true for mpegts container to ffmpeg', async () => {
    const { deps, ffmpegFakes } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob()) // baseJob has container: 'mpegts'

    const ffmpeg = ffmpegFakes[0]
    const jobArg = ffmpeg?.run.mock.calls[0]?.[0] as { fromMpegts: boolean }
    expect(jobArg?.fromMpegts).toBe(true)
  })

  it('passes fromMpegts:false for fmp4 container to ffmpeg', async () => {
    const { deps, ffmpegFakes } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    await c.start({
      ...baseJob(),
      video: { ...videoOnlyPlan(), container: 'fmp4' },
    })

    const ffmpeg = ffmpegFakes[0]
    const jobArg = ffmpeg?.run.mock.calls[0]?.[0] as { fromMpegts: boolean }
    expect(jobArg?.fromMpegts).toBe(false)
  })

  it('resolves the current ffmpeg path immediately before muxing', async () => {
    const resolveFfmpegBinaryPath = vi.fn(
      async () => '/opt/homebrew/bin/ffmpeg'
    )
    const { deps, downloaderFakes, ffmpegFakes } = makeDeps({
      resolveFfmpegBinaryPath,
    })

    await new MediaTaskCoordinator(deps).start(baseJob())

    const jobArg = ffmpegFakes[0]?.run.mock.calls[0]?.[0] as {
      binaryPath: string
    }
    expect(resolveFfmpegBinaryPath).toHaveBeenCalledOnce()
    expect(jobArg.binaryPath).toBe('/opt/homebrew/bin/ffmpeg')
    expect(
      resolveFfmpegBinaryPath.mock.invocationCallOrder[0] ?? -1
    ).toBeGreaterThan(downloaderFakes[0]?.run.mock.invocationCallOrder[0] ?? -1)
  })

  it('does not spawn ffmpeg when no executable is available at mux time', async () => {
    const { deps, ffmpegFakes, taskManager } = makeDeps({
      resolveFfmpegBinaryPath: vi.fn(async () => null),
      mintTaskId: () => 'ffmpeg-missing-at-mux',
    })

    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).rejects.toThrow('mux-failed: ffmpeg executable is unavailable')

    expect(ffmpegFakes[0]?.run).not.toHaveBeenCalled()
    expect(taskManager.getById('ffmpeg-missing-at-mux')?.errorMessage).toBe(
      'mux-failed'
    )
  })

  it('calls decryptor.decrypt for segments with keys', async () => {
    const keyBytes = new Uint8Array(16).fill(0xab)
    const iv = new Uint8Array(16).fill(0x01)
    const fakeFileContent = Buffer.from(new Uint8Array(32).fill(0xff))

    // Mock fs.promises to avoid real I/O for decrypt verification
    const readFileSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockResolvedValue(fakeFileContent as unknown as string)
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue()
    // Also mock rm so temp cleanup doesn't fail
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue()

    const { deps, decryptorFake } = makeDeps({
      makeDownloader: (_tmpDir: string) => {
        const fake = makeDownloaderFake({ partPaths: ['/fake/enc.seg'] })
        return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
    })
    // Override getKey to return our test key
    decryptorFake.getKey.mockResolvedValue(keyBytes)

    const c = new MediaTaskCoordinator(deps)

    try {
      await c.start({
        ...baseJob(),
        video: {
          container: 'mpegts',
          segments: [
            {
              url: 'https://cdn/enc.ts',
              index: 0,
              key: { method: 'AES-128', uri: 'https://cdn/key', iv },
            },
          ],
          isComplete: true,
        },
      })
    } finally {
      readFileSpy.mockRestore()
      writeFileSpy.mockRestore()
      rmSpy.mockRestore()
    }

    expect(decryptorFake.getKey).toHaveBeenCalledWith('https://cdn/key')
    expect(decryptorFake.decrypt).toHaveBeenCalled()
  })

  it('cancel invokes downloader.cancel + ffmpeg.kill and sets Error/mux-aborted', async () => {
    // Use blocking ffmpeg so we have time to cancel
    const blockingFfmpeg = makeBlockingFfmpegFake()
    const { deps, taskManager } = makeDeps({
      makeFfmpeg: () =>
        blockingFfmpeg as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService,
      mintTaskId: () => 'cancel-test',
    })
    const c = new MediaTaskCoordinator(deps)

    // Kick off start (will hang at ffmpeg.run)
    // Observe cancellation rejection immediately so parallel/full-suite runs
    // cannot report it as an unhandled rejection before cancel() returns.
    const startPromise = c.start(baseJob()).catch(() => {})

    // Yield to let the coordinator reach the muxing phase
    await new Promise((r) => setTimeout(r, 10))

    // Cancel while ffmpeg is running
    await c.cancel('cancel-test')

    // Wait for start to settle
    await startPromise

    expect(blockingFfmpeg.kill).toHaveBeenCalledTimes(1)
    const task = taskManager.getById('cancel-test')
    expect(task?.status).toBe(TaskStatus.Error)
    expect(task?.errorMessage).toBe('mux-aborted')
  })

  it('cancel writes the terminal occurrence with cause "user-cancel" (not "media") and dispatches it', async () => {
    const blockingFfmpeg = makeBlockingFfmpegFake()
    const persistTaskWithOccurrence = vi.fn(async () => {})
    const dispatch = vi.fn(async () => {})
    const { deps, taskManager } = makeDeps({
      makeFfmpeg: () =>
        blockingFfmpeg as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService,
      mintTaskId: () => 'cancel-occurrence-test',
      recordTransition: vi.fn().mockResolvedValue(undefined),
      persistTaskWithOccurrence,
      occurrenceDispatcher: { dispatch },
    })
    const c = new MediaTaskCoordinator(deps)

    const startPromise = c.start(baseJob()).catch(() => {})
    await new Promise((r) => setTimeout(r, 10))
    await c.cancel('cancel-occurrence-test')
    await startPromise

    expect(taskManager.getById('cancel-occurrence-test')?.status).toBe(
      TaskStatus.Error
    )
    expect(persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: 'cancel-occurrence-test',
        status: TaskStatus.Error,
        errorMessage: 'mux-aborted',
      }),
      expect.objectContaining({
        type: 'terminal',
        taskId: 'cancel-occurrence-test',
        toStatus: TaskStatus.Error,
        cause: 'user-cancel',
      })
    )
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: 'user-cancel' })
    )
  })

  it('best-effort persists cancellation without masking cancel success', async () => {
    const blockingFfmpeg = makeBlockingFfmpegFake()
    const snapshots: Array<{
      status: TaskStatus
      errorMessage: string | null
    }> = []
    const persist = vi.fn(async (task: DownloadTask) => {
      snapshots.push({
        status: task.status,
        errorMessage: task.errorMessage,
      })
      throw new Error('db locked')
    })
    const { deps } = makeDeps({
      makeFfmpeg: () =>
        blockingFfmpeg as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService,
      mintTaskId: () => 'cancel-persist-test',
      persist,
    })
    const coordinator = new MediaTaskCoordinator(deps)
    const startPromise = coordinator.start(baseJob()).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(
      coordinator.cancel('cancel-persist-test')
    ).resolves.toBeUndefined()
    await startPromise

    expect(persist).toHaveBeenCalledTimes(1)
    expect(snapshots).toEqual([
      {
        status: TaskStatus.Error,
        errorMessage: 'mux-aborted',
      },
    ])
  })

  it('cancel invokes downloader.cancel during download phase', async () => {
    // Make a downloader that hangs
    let rejectDownload: ((err: Error) => void) | null = null
    const cancelFn = vi.fn(async () => {
      rejectDownload?.(new Error('SegmentDownloader: cancelled'))
    })
    const runFn = vi.fn(
      async (
        _plan: unknown,
        _headers: unknown,
        _onProgress: (p: SegmentProgress) => void
      ): Promise<{ initPath?: string; partPaths: string[] }> => {
        return new Promise((_resolve, reject) => {
          rejectDownload = reject
        })
      }
    )
    const hangingDownloader = {
      run: runFn,
      cancel: cancelFn,
      getActiveGids: () => [],
      getActiveGidCount: () => 0,
    }

    const { deps, taskManager } = makeDeps({
      makeDownloader: (_tmpDir: string) => {
        return hangingDownloader as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
      mintTaskId: () => 'cancel-dl-test',
    })
    const c = new MediaTaskCoordinator(deps)

    // Attach rejection handler before awaiting so it's never unhandled
    const startPromise = c.start(baseJob()).catch(() => {})
    // Yield so coordinator reaches downloader.run
    await new Promise((r) => setTimeout(r, 10))

    await c.cancel('cancel-dl-test')
    await startPromise

    expect(hangingDownloader.cancel).toHaveBeenCalled()
    const task = taskManager.getById('cancel-dl-test')
    expect(task?.status).toBe(TaskStatus.Error)
    expect(task?.errorMessage).toBe('mux-aborted')
  })

  it('ffmpeg non-cancel failure normalizes errorMessage to mux-failed', async () => {
    // A fake FfmpegService whose run rejects with 'mux-failed: ffmpeg exited 1'
    // (not via kill/cancel — a genuine ffmpeg process failure)
    const failingFfmpeg = {
      run: vi.fn(async () => {
        throw new Error('mux-failed: ffmpeg exited 1')
      }),
      kill: vi.fn(),
      buildArgs: vi.fn(() => []),
    }

    const { deps, taskManager } = makeDeps({
      makeFfmpeg: () =>
        failingFfmpeg as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService,
      mintTaskId: () => 'mux-fail-test',
    })
    const c = new MediaTaskCoordinator(deps)

    await expect(c.start(baseJob())).rejects.toThrow()

    const task = taskManager.getById('mux-fail-test')
    expect(task?.status).toBe(TaskStatus.Error)
    expect(task?.finishedAt).not.toBeNull()
    expect(task?.errorMessage).toBe('mux-failed')
    expect(task?.errorDetailKey).toBe('task.error.detail.muxFailed')
  })

  it('uses a stable taskId across the whole lifecycle', async () => {
    let id = 0
    const { deps, taskManager } = makeDeps({
      mintTaskId: () => `task-${++id}`,
    })
    const c = new MediaTaskCoordinator(deps)

    const r1 = await c.start(baseJob())
    const r2 = await c.start(baseJob())

    // Each start mints a new taskId (id increments each call)
    expect(r1.taskId).toBe('task-1')
    expect(r2.taskId).toBe('task-2')
    // Both tasks are registered
    expect(taskManager.getById('task-1')).toBeDefined()
    expect(taskManager.getById('task-2')).toBeDefined()
  })

  // C1: video and audio downloaders must get DISTINCT temp dirs
  it('makeDownloader is called with distinct dirs for video vs audio', async () => {
    const capturedDirs: string[] = []
    const { deps } = makeDeps({
      makeDownloader: (tmpDir: string) => {
        capturedDirs.push(tmpDir)
        const fake = makeDownloaderFake()
        return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
      mkdtemp: async () => '/tmp/fake-task',
    })
    const c = new MediaTaskCoordinator(deps)

    await c.start({
      ...baseJob(),
      audio: {
        container: 'mpegts',
        segments: [{ url: 'https://cdn/aud1.ts', index: 0 }],
        isComplete: true,
      },
    })

    // Both downloaders must have been created
    expect(capturedDirs).toHaveLength(2)
    // They must be distinct paths (not both the tmpDir root)
    expect(capturedDirs[0]).not.toBe(capturedDirs[1])
    // They must both be subdirectories of the task tmpDir
    expect(capturedDirs[0]).toContain('/tmp/fake-task/')
    expect(capturedDirs[1]).toContain('/tmp/fake-task/')
  })

  // C1: video and audio assembled output paths must differ
  it('video and audio assembled paths are distinct', async () => {
    const { deps, assembleFake } = makeDeps({
      mkdtemp: async () => '/tmp/fake-task',
    })
    const c = new MediaTaskCoordinator(deps)

    await c.start({
      ...baseJob(),
      audio: {
        container: 'mpegts',
        segments: [{ url: 'https://cdn/aud1.ts', index: 0 }],
        isComplete: true,
      },
    })

    expect(assembleFake).toHaveBeenCalledTimes(2)
    const videoOutPath = (
      assembleFake.mock.calls[0]?.[0] as { outPath: string }
    )?.outPath
    const audioOutPath = (
      assembleFake.mock.calls[1]?.[0] as { outPath: string }
    )?.outPath
    expect(videoOutPath).not.toBe(audioOutPath)
  })

  // Important 1: mux MediaJob → task.kind === TaskKind.Mux
  it('mux job produces task with kind TaskKind.Mux', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    const job: MediaJob = {
      ...baseJob(),
      kind: 'mux',
      audio: {
        container: 'single',
        segments: [{ url: 'https://cdn/audio.mp4', index: 0 }],
        isComplete: true,
      },
    }

    const { taskId } = await c.start(job)
    expect(taskManager.getById(taskId)?.kind).toBe(TaskKind.Mux)
  })

  // Important 1: hls/dash jobs produce task with kind TaskKind.Hls
  it('hls job produces task with kind TaskKind.Hls', async () => {
    const { deps, taskManager } = makeDeps()
    const c = new MediaTaskCoordinator(deps)

    const { taskId } = await c.start({ ...baseJob(), kind: 'hls' })
    expect(taskManager.getById(taskId)?.kind).toBe(TaskKind.Hls)
  })

  // Bug A: the task carries real byte counts summed across video + audio.
  it('sets task.downloadedBytes/totalBytes to the summed stream byte counts', async () => {
    let call = 0
    const { deps, taskManager } = makeDeps({
      makeDownloader: () => {
        call += 1
        const fake =
          call === 1
            ? makeDownloaderFake({
                report: [
                  { fraction: 0.5, downloadedBytes: 5, totalBytes: 10 },
                  { fraction: 1, downloadedBytes: 10, totalBytes: 10 },
                ],
              })
            : makeDownloaderFake({
                report: [{ fraction: 1, downloadedBytes: 6, totalBytes: 6 }],
              })
        return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
      mintTaskId: () => 'bytes-test',
    })
    const c = new MediaTaskCoordinator(deps)

    await c.start({
      ...baseJob(),
      audio: {
        container: 'single',
        segments: [{ url: 'https://cdn/audio.mp4', index: 0 }],
        isComplete: true,
      },
    })

    const task = taskManager.getById('bytes-test')
    // video 10 + audio 6 (never 0 — the reported "always 0 B" bug), and the
    // completed task persists downloaded === total so restore derives 100%.
    expect(task?.totalBytes).toBe(16)
    expect(task?.downloadedBytes).toBe(16)
    expect(task?.progress).toBe(1)
    expect(task?.status).toBe(TaskStatus.Completed)
    // The UI reads sizeWhenDone (list "size" column + detail "Total size"), not
    // totalBytes — the coordinator must mirror it or the size renders 0 B.
    expect(task?.sizeWhenDone).toBe(16)
    // A completed task has no segment in flight → 0 speed / 0 connections.
    expect(task?.connections).toBe(0)
    expect(task?.downloadSpeed).toBe(0)
  })

  // Perf follow-up: coalesce pure byte-progress emits, but never drop a status
  // change (terminal Completed/Error must always reach bridge consumers).
  it('throttles progress emits but always flushes status changes', async () => {
    const snapshots: DownloadTask[][] = []
    const { deps } = makeDeps({
      now: () => 5000, // constant clock ⇒ throttle window never elapses, so ONLY
      makeDownloader: () =>
        makeDownloaderFake({
          report: [
            { fraction: 0.3, downloadedBytes: 3, totalBytes: 10 },
            { fraction: 0.6, downloadedBytes: 6, totalBytes: 10 },
            { fraction: 1, downloadedBytes: 10, totalBytes: 10 },
          ],
        }) as unknown as import('@core/download/segment-downloader').SegmentDownloader,
      mintTaskId: () => 'throttle-test',
    })
    // Capture the emitted task-list snapshots (not just the event name).
    deps.eventBus.emit = vi.fn((e: string, payload: unknown) => {
      if (e === Events.TaskUpdated) snapshots.push(payload as DownloadTask[])
    })
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob())

    // The many progress updateTask calls (3 stream reports + ffmpeg ticks +
    // instance-status tweaks) are coalesced away by the constant-clock throttle;
    // only forced status transitions (add, Downloading, Finalizing, Completed)
    // get through — far fewer than the un-throttled ~10.
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(snapshots.length).toBeLessThanOrEqual(5)
    // Terminal state was emitted despite the throttle.
    expect(snapshots.at(-1)?.[0]?.status).toBe(TaskStatus.Completed)
  })

  // Bug A follow-up: the UI reads the aria2-task display fields (sizeWhenDone,
  // downloadSpeed, connections). A coordinator task must populate them during
  // download too, or the detail panel shows 0 B / 0 B/s / 0 connections.
  it('populates sizeWhenDone + connections + downloadSpeed during the download phase', async () => {
    let clock = 0
    const now = () => {
      clock += 1000 // advance 1s per read so the speed sampler has a delta
      return clock
    }
    let rejectRun: ((e: Error) => void) | null = null
    const { deps, taskManager } = makeDeps({
      now,
      makeDownloader: () =>
        ({
          run: vi.fn(
            (
              _p: unknown,
              _h: unknown,
              onProgress: (p: SegmentProgress) => void
            ) => {
              onProgress({
                fraction: 0.25,
                downloadedBytes: 1_000_000,
                totalBytes: 4_000_000,
              })
              onProgress({
                fraction: 0.5,
                downloadedBytes: 2_000_000,
                totalBytes: 4_000_000,
              })
              // Stay in the download phase so we can inspect live UI fields.
              return new Promise((_res, rej) => {
                rejectRun = rej
              })
            }
          ),
          cancel: vi.fn(async () => rejectRun?.(new Error('cancelled'))),
          getActiveGids: () => ['g1', 'g2'],
          getActiveGidCount: () => 2,
        }) as unknown as import('@core/download/segment-downloader').SegmentDownloader,
      mintTaskId: () => 'ui-live',
    })
    const c = new MediaTaskCoordinator(deps)

    const startPromise = c.start(baseJob()).catch(() => {})
    await new Promise((r) => setTimeout(r, 10))

    const task = taskManager.getById('ui-live')
    expect(task?.sizeWhenDone).toBe(4_000_000) // == totalBytes, not 0 B
    expect(task?.connections).toBe(2) // two segment gids in flight
    expect(task?.downloadSpeed).toBeGreaterThan(0)

    await c.cancel('ui-live')
    await startPromise
  })

  it('derives progress from bytes while downloading (video-only stream)', async () => {
    const emittedTasks: { downloadedBytes: number; totalBytes: number }[] = []
    const { deps } = makeDeps({
      makeDownloader: () => {
        const fake = makeDownloaderFake({
          report: [
            { fraction: 0.25, downloadedBytes: 250, totalBytes: 1000 },
            { fraction: 1, downloadedBytes: 1000, totalBytes: 1000 },
          ],
        })
        return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
      mintTaskId: () => 'video-bytes',
    })
    // Capture every persisted snapshot to prove real partial byte counts flow.
    const tm = deps.taskManager
    const origSet = tm.set.bind(tm)
    vi.spyOn(tm, 'set').mockImplementation((id, task) => {
      emittedTasks.push({
        downloadedBytes: task.downloadedBytes,
        totalBytes: task.totalBytes,
      })
      return origSet(id, task)
    })
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob())

    // At least one mid-download snapshot showed the real partial byte counts
    // (250/1000) — smooth progress, not a 0 → 100 jump.
    expect(
      emittedTasks.some(
        (t) => t.downloadedBytes === 250 && t.totalBytes === 1000
      )
    ).toBe(true)
  })

  // Bug B: expose the active segment gids for pause/resume.
  it('getActiveSegmentGids returns the running downloaders active gids', async () => {
    const gidsByCall = [['v1', 'v2'], ['a1']]
    let call = 0
    const { deps } = makeDeps({
      makeDownloader: () => {
        const gids = gidsByCall[call++] ?? []
        let rejectRun: ((e: Error) => void) | null = null
        const fake = {
          run: vi.fn(
            () =>
              new Promise<{ initPath?: string; partPaths: string[] }>(
                (_res, rej) => {
                  rejectRun = rej
                }
              )
          ),
          cancel: vi.fn(async () => {
            rejectRun?.(new Error('SegmentDownloader: cancelled'))
          }),
          getActiveGids: () => gids,
          getActiveGidCount: () => gids.length,
        }
        return fake as unknown as import('@core/download/segment-downloader').SegmentDownloader
      },
      mintTaskId: () => 'gids-test',
    })
    const c = new MediaTaskCoordinator(deps)

    const startPromise = c
      .start({
        ...baseJob(),
        audio: {
          container: 'single',
          segments: [{ url: 'https://cdn/audio.mp4', index: 0 }],
          isComplete: true,
        },
      })
      .catch(() => {})

    // Let start() reach the (concurrent) download phase.
    await new Promise((r) => setTimeout(r, 10))

    expect(c.getActiveSegmentGids('gids-test').slice().sort()).toEqual([
      'a1',
      'v1',
      'v2',
    ])
    expect(c.getActiveSegmentGids('unknown-task')).toEqual([])

    await c.cancel('gids-test')
    await startPromise
  })

  // Important 2: mkdtemp override routes temp dirs through injected factory
  it('uses injected mkdtemp and tmpRoot base for temp dirs', async () => {
    const capturedPaths: string[] = []
    // Use /tmp so the subsequent mkdir(videoDir) succeeds
    const mkdtempFn = vi.fn(async () => {
      const p = '/tmp/custom-tmp-root-motrix-media-abc123'
      capturedPaths.push(p)
      return p
    })
    const { deps } = makeDeps({ mkdtemp: mkdtempFn })
    const c = new MediaTaskCoordinator(deps)

    await c.start(baseJob())

    expect(mkdtempFn).toHaveBeenCalledTimes(1)
    expect(capturedPaths[0]).toContain(
      '/tmp/custom-tmp-root-motrix-media-abc123'
    )
  })
})

// ---------------------------------------------------------------------------
// .motrix placeholder contract — media tasks mirror the HTTP task lifecycle:
// reserve `<finalName>.motrix` in saveDir at start (atomic wx create, re-pick
// on EEXIST), keep diskPath on the temp path while in flight, mux INTO the
// placeholder, and rename to finalPath before flipping to Completed.
// ---------------------------------------------------------------------------

describe('MediaTaskCoordinator .motrix placeholder contract', () => {
  const TEMP = '/save/video.mp4.motrix'
  const FINAL = '/save/video.mp4'

  let mkdirSpy: ReturnType<typeof vi.spyOn>
  let writeFileSpy: ReturnType<typeof vi.spyOn>
  let renameSpy: ReturnType<typeof vi.spyOn>
  let accessSpy: ReturnType<typeof vi.spyOn>
  let unlinkSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockResolvedValue(undefined as never)
    writeFileSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockResolvedValue(undefined as never)
    renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockResolvedValue(undefined as never)
    // Default: the final path does NOT exist (reservation's post-claim check).
    accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    unlinkSpy = vi
      .spyOn(fs.promises, 'unlink')
      .mockResolvedValue(undefined as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reserves the slot: creates the .motrix placeholder with wx before downloading', async () => {
    const { deps, downloaderFakes } = makeDeps()
    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(writeFileSpy).toHaveBeenCalledWith(TEMP, '', { flag: 'wx' })
    const writeOrder = writeFileSpy.mock.invocationCallOrder[0] ?? -1
    const runOrder =
      downloaderFakes[0]?.run.mock.invocationCallOrder[0] ??
      Number.POSITIVE_INFINITY
    expect(writeOrder).toBeLessThan(runOrder)
  })

  it('creates saveDir before writing the placeholder', async () => {
    const { deps } = makeDeps()
    await new MediaTaskCoordinator(deps).start(baseJob())

    const saveIdx = mkdirSpy.mock.calls.findIndex(
      (c: unknown[]) => c[0] === '/save'
    )
    expect(saveIdx).toBeGreaterThanOrEqual(0)
    expect(mkdirSpy.mock.invocationCallOrder[saveIdx] ?? -1).toBeLessThan(
      writeFileSpy.mock.invocationCallOrder[0] ?? -1
    )
  })

  it('in-flight task and instances carry the temp diskPath', async () => {
    const hangFake = makeDownloaderFake({ hang: true })
    const { deps, taskManager } = makeDeps({
      makeDownloader: () =>
        hangFake as unknown as import('@core/download/segment-downloader').SegmentDownloader,
    })
    const c = new MediaTaskCoordinator(deps)
    // Observe cancellation rejection immediately so parallel/full-suite runs
    // cannot report it as an unhandled rejection before cancel() returns.
    const startPromise = c.start(baseJob()).catch(() => {})
    await new Promise((r) => setTimeout(r, 10))

    const task = taskManager.getById('stable-task-id')
    expect(task?.diskPath).toBe(TEMP)
    expect(task?.finalPath).toBe(FINAL)
    for (const inst of task?.instances ?? []) {
      expect(inst.diskPath).toBe(TEMP)
    }

    await c.cancel('stable-task-id')
    await startPromise
  })

  it('muxes into the placeholder path with an explicit -f muxer', async () => {
    const { deps, ffmpegFakes } = makeDeps()
    await new MediaTaskCoordinator(deps).start(baseJob())

    const jobArg = ffmpegFakes[0]?.run.mock.calls[0]?.[0] as {
      output: string
      format?: string
    }
    expect(jobArg.output).toBe(TEMP)
    expect(jobArg.format).toBe('mp4')
  })

  it('derives the muxer from the final name extension (mkv → matroska)', async () => {
    const { deps, ffmpegFakes } = makeDeps()
    await new MediaTaskCoordinator(deps).start({
      ...baseJob(),
      finalName: 'video.mkv',
    })

    const jobArg = ffmpegFakes[0]?.run.mock.calls[0]?.[0] as {
      output: string
      format?: string
    }
    expect(jobArg.output).toBe('/save/video.mkv.motrix')
    expect(jobArg.format).toBe('matroska')
  })

  it('renames placeholder → finalPath while still Finalizing, then completes with rewritten diskPath', async () => {
    const { deps, taskManager } = makeDeps()
    let statusAtRename: TaskStatus | undefined
    renameSpy.mockImplementation(async () => {
      statusAtRename = taskManager.getById('stable-task-id')?.status
    })
    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(renameSpy).toHaveBeenCalledWith(TEMP, FINAL)
    // The file must land on finalPath BEFORE status flips to Completed —
    // bridge consumers read finalPath off the Completed tick and may open it.
    expect(statusAtRename).toBe(TaskStatus.Finalizing)

    const task = taskManager.getById('stable-task-id')
    expect(task?.status).toBe(TaskStatus.Completed)
    expect(task?.diskPath).toBe(FINAL)
    for (const inst of task?.instances ?? []) {
      expect(inst.diskPath).toBe(FINAL)
    }
  })

  it('re-picks the name when the placeholder already exists (EEXIST)', async () => {
    const pickName = vi.fn(async () => 'video (1).mp4')
    const { deps, taskManager, ffmpegFakes } = makeDeps({ pickName })
    writeFileSpy.mockRejectedValueOnce(
      Object.assign(new Error('EEXIST: file already exists'), {
        code: 'EEXIST',
      })
    )
    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(pickName).toHaveBeenCalledWith('/save', 'video.mp4')
    expect(writeFileSpy).toHaveBeenLastCalledWith(
      '/save/video (1).mp4.motrix',
      '',
      { flag: 'wx' }
    )
    const task = taskManager.getById('stable-task-id')
    expect(task?.name).toBe('video (1).mp4')
    expect(task?.finalName).toBe('video (1).mp4')
    expect(task?.finalPath).toBe('/save/video (1).mp4')
    expect(task?.diskPath).toBe('/save/video (1).mp4')
    const jobArg = ffmpegFakes[0]?.run.mock.calls[0]?.[0] as { output: string }
    expect(jobArg.output).toBe('/save/video (1).mp4.motrix')
    expect(renameSpy).toHaveBeenCalledWith(
      '/save/video (1).mp4.motrix',
      '/save/video (1).mp4'
    )
  })

  it('treats an existing FINAL file as a collision: releases the claimed placeholder and re-picks', async () => {
    // A sibling that picked the same name earlier completed (its placeholder
    // was renamed to the final name) during our pick→reserve window. The wx
    // create then SUCCEEDS (the placeholder path is free again) — but muxing
    // and renaming would silently overwrite the sibling's finished file.
    const pickName = vi.fn(async () => 'video (1).mp4')
    const { deps, taskManager } = makeDeps({ pickName })
    accessSpy.mockResolvedValueOnce(undefined as never) // '/save/video.mp4' exists

    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(pickName).toHaveBeenCalledWith('/save', 'video.mp4')
    // The falsely-claimed placeholder for the taken name must be released.
    expect(unlinkSpy).toHaveBeenCalledWith(TEMP)
    const task = taskManager.getById('stable-task-id')
    expect(task?.finalName).toBe('video (1).mp4')
    expect(renameSpy).toHaveBeenCalledWith(
      '/save/video (1).mp4.motrix',
      '/save/video (1).mp4'
    )
  })

  it('a non-EEXIST placeholder failure rejects the submit without registering a task', async () => {
    writeFileSpy.mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    )
    const { deps, taskManager } = makeDeps()
    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).rejects.toThrow(/EACCES/)
    expect(taskManager.getById('stable-task-id')).toBeUndefined()
  })

  it('persists rename intent before rename and the finalized task after Completed', async () => {
    // Bridge-submitted media tasks otherwise rely on the engine-activity-gated
    // auto-save; with an idle engine nothing durable records the completion
    // until quit, and a crash restores the task as mediaInterrupted/Error
    // pointing at the renamed-away placeholder.
    const persisted: Array<{
      status: TaskStatus
      diskPath: string
      instancePhases: TransitionPhase[]
      instanceStatuses: TaskStatus[]
    }> = []
    const persist = vi.fn(async (t: DownloadTask) => {
      persisted.push({
        status: t.status,
        diskPath: t.diskPath,
        instancePhases: t.instances.map((instance) => instance.transitionPhase),
        instanceStatuses: t.instances.map((instance) => instance.status),
      })
    })
    const { deps } = makeDeps({ persist })
    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persisted[0]).toEqual({
      status: TaskStatus.Finalizing,
      diskPath: TEMP,
      instancePhases: [TransitionPhase.Renaming, TransitionPhase.Renaming],
      instanceStatuses: [TaskStatus.Downloading, TaskStatus.Downloading],
    })
    expect(persisted[1]).toEqual({
      status: TaskStatus.Completed,
      diskPath: FINAL,
      instancePhases: [TransitionPhase.Idle, TransitionPhase.Idle],
      instanceStatuses: [TaskStatus.Completed, TaskStatus.Completed],
    })
  })

  it('crosses the parent barrier and every status barrier before publication', async () => {
    const persistedStatuses: TaskStatus[] = []
    const persist = vi.fn(async (task: DownloadTask) => {
      persistedStatuses.push(task.status)
    })
    const parentTaskCreated = vi.fn(
      async (
        _task: DownloadTask,
        persistParent: () => void | Promise<void>
      ) => {
        await persistParent()
      }
    )
    const recordTransition = vi.fn().mockResolvedValue(undefined)
    const { deps, taskManager } = makeDeps({
      persist,
      parentTaskCreated,
      recordTransition,
    })

    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(parentTaskCreated).toHaveBeenCalledOnce()
    expect(persistedStatuses).toEqual([
      TaskStatus.Queued,
      TaskStatus.Downloading,
      TaskStatus.Finalizing,
      TaskStatus.Completed,
    ])
    expect(
      recordTransition.mock.calls.map(([input]) => [
        input.previousStatus,
        input.nextStatus,
      ])
    ).toEqual([
      [TaskStatus.Queued, TaskStatus.Downloading],
      [TaskStatus.Downloading, TaskStatus.Finalizing],
      [TaskStatus.Finalizing, TaskStatus.Completed],
    ])
    expect(taskManager.getById('stable-task-id')?.status).toBe(
      TaskStatus.Completed
    )
  })

  it('does not publish or record a status whose durable barrier failed', async () => {
    const persist = vi.fn(async (task: DownloadTask) => {
      if (task.status === TaskStatus.Finalizing) {
        throw new Error('database busy')
      }
    })
    const parentTaskCreated = vi.fn(
      async (
        _task: DownloadTask,
        persistParent: () => void | Promise<void>
      ) => {
        await persistParent()
      }
    )
    const recordTransition = vi.fn().mockResolvedValue(undefined)
    const { deps, taskManager } = makeDeps({
      persist,
      parentTaskCreated,
      recordTransition,
    })

    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).rejects.toThrow('database busy')

    expect(taskManager.getById('stable-task-id')?.status).toBe(
      TaskStatus.Downloading
    )
    expect(recordTransition).not.toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: TaskStatus.Finalizing,
      })
    )
    expect(renameSpy).not.toHaveBeenCalled()
  })

  it('isolates Activity failure after each durable media transition', async () => {
    const persist = vi.fn(async () => {})
    const parentTaskCreated = vi.fn(
      async (
        _task: DownloadTask,
        persistParent: () => void | Promise<void>
      ) => {
        await persistParent()
      }
    )
    const recordTransition = vi
      .fn()
      .mockRejectedValue(new Error('activity database busy'))
    const { deps, taskManager } = makeDeps({
      persist,
      parentTaskCreated,
      recordTransition,
    })

    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).resolves.toEqual({ taskId: 'stable-task-id' })

    expect(taskManager.getById('stable-task-id')?.status).toBe(
      TaskStatus.Completed
    )
  })

  it('records submission before the first update and completion between rename and durable completion', async () => {
    const persist = vi.fn(async () => {})
    const { deps, taskManager } = makeDeps({ persist })
    const add = vi.spyOn(taskManager, 'add')
    const recordSubmitted = deps.activityRecorder.recordSubmitted as ReturnType<
      typeof vi.fn
    >
    const recordDownloadCompleted = deps.activityRecorder
      .recordDownloadCompleted as ReturnType<typeof vi.fn>
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>

    await new MediaTaskCoordinator(deps).start(baseJob())

    const task = taskManager.getById('stable-task-id')
    expect(recordSubmitted).toHaveBeenCalledWith({
      taskId: 'stable-task-id',
      occurredAt: task?.createdAt,
    })
    expect(recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 'stable-task-id',
      occurredAt: task?.finishedAt,
    })
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(
      recordSubmitted.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(recordSubmitted.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(renameSpy.mock.invocationCallOrder[0]).toBeLessThan(
      recordDownloadCompleted.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(recordDownloadCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      persist.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    )
  })

  it('a failing post-rename persist hook does not fail the completed task', async () => {
    const persist = vi
      .fn<(task: DownloadTask) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('db locked'))
    const { deps, taskManager } = makeDeps({ persist })
    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(taskManager.getById('stable-task-id')?.status).toBe(
      TaskStatus.Completed
    )
  })

  it('a synchronously-throwing post-rename persist hook does not fail the completed task', async () => {
    // The type promises Promise<void>, but a sync throw before the promise
    // exists would land in start()'s outer catch and flip an already-renamed,
    // Completed task to Error — guard against convention violations.
    let calls = 0
    const persist = vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.resolve()
      throw new Error('sync boom')
    }) as MediaCoordinatorDeps['persist']
    const { deps, taskManager } = makeDeps({ persist })
    await new MediaTaskCoordinator(deps).start(baseJob())

    expect(taskManager.getById('stable-task-id')?.status).toBe(
      TaskStatus.Completed
    )
  })

  it('blocks the final rename when the durable recovery intent cannot be persisted', async () => {
    const persist = vi.fn(async () => {
      throw new Error('db locked before rename')
    })
    const { deps, taskManager } = makeDeps({ persist })
    const recordDownloadCompleted = deps.activityRecorder
      .recordDownloadCompleted as ReturnType<typeof vi.fn>

    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).rejects.toThrow(/db locked before rename/)

    expect(renameSpy).not.toHaveBeenCalled()
    expect(recordDownloadCompleted).not.toHaveBeenCalled()
    expect(taskManager.getById('stable-task-id')).toMatchObject({
      status: TaskStatus.Error,
      diskPath: TEMP,
      transitionPhase: 'renaming',
    })
  })

  it('a failed mux keeps the temp diskPath and never renames', async () => {
    const { deps, taskManager } = makeDeps({
      makeFfmpeg: () =>
        ({
          run: vi.fn(async () => {
            throw new Error('mux-failed: ffmpeg exited 234')
          }),
          kill: vi.fn(),
          buildArgs: vi.fn(() => []),
        }) as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService,
    })
    const c = new MediaTaskCoordinator(deps)
    await expect(c.start(baseJob())).rejects.toThrow(/mux-failed/)

    const task = taskManager.getById('stable-task-id')
    expect(task?.status).toBe(TaskStatus.Error)
    expect(task?.diskPath).toBe(TEMP)
    expect(renameSpy).not.toHaveBeenCalled()
  })

  it('best-effort persists mux Error without masking the original failure', async () => {
    const snapshots: Array<{
      status: TaskStatus
      errorMessage: string | null
    }> = []
    const persist = vi.fn(async (task: DownloadTask) => {
      snapshots.push({
        status: task.status,
        errorMessage: task.errorMessage,
      })
      throw new Error('db locked')
    })
    const { deps } = makeDeps({
      persist,
      makeFfmpeg: () =>
        ({
          run: vi.fn(async () => {
            throw new Error('mux-failed: original ffmpeg failure')
          }),
          kill: vi.fn(),
          buildArgs: vi.fn(() => []),
        }) as unknown as import('@core/ffmpeg/ffmpeg-service').FfmpegService,
    })

    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).rejects.toThrow('mux-failed: original ffmpeg failure')

    expect(persist).toHaveBeenCalledTimes(1)
    expect(snapshots).toEqual([
      {
        status: TaskStatus.Error,
        errorMessage: 'mux-failed',
      },
    ])
  })

  it('a failed rename lands the task in Error with the fs message', async () => {
    renameSpy.mockRejectedValue(new Error('EACCES: permission denied'))
    const { deps, taskManager } = makeDeps()
    await expect(
      new MediaTaskCoordinator(deps).start(baseJob())
    ).rejects.toThrow(/EACCES/)
    const task = taskManager.getById('stable-task-id')
    expect(task?.status).toBe(TaskStatus.Error)
    expect(task?.errorMessage).toMatch(/EACCES/)
    expect(task?.errorDetailKey).toBe('task.error.detail.muxFailed')
    expect(task?.diskPath).toBe(TEMP)
  })
})
