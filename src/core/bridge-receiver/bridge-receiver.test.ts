import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import type { SegmentAria2 } from '@core/download/segment-downloader'
import { TaskManager } from '@core/task/task-manager'
import { ErrorCodes } from '@motrix/mdxp'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeReceiver } from './bridge-receiver'

/** Minimal fake SegmentAria2 — never actually called in routing tests. */
const fakeSegmentAria2: SegmentAria2 = {
  addUri: vi.fn(async () => 'gid-seg'),
  forceRemove: vi.fn(async () => {}),
  tellStatus: vi.fn(async () => null),
  onComplete: vi.fn(),
  onError: vi.fn(),
}

function fakeDeps(
  over: Partial<ConstructorParameters<typeof BridgeReceiver>[0]> = {}
) {
  return {
    dataDir: '',
    defaultSaveDir: '/tmp/save',
    pickName: async (_d: string, n: string) => n,
    createTask: vi.fn(async () => ({ gid: 'gid-1', taskId: 'task-abc' })),
    removeTask: vi.fn(async () => {}),
    submitMagnetForFileSelection: vi.fn(async () => 'magnet-task-1'),
    isMagnetFileSelectionEnabled: () => false,
    eventBus: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    },
    bridgeBus: {
      emitTaskProgress: vi.fn(),
      emitTaskCompleted: vi.fn(),
      emitTaskError: vi.fn(),
    },
    localize: (c: string) => c,
    // New media-stack deps. Default: null (ffmpeg unavailable) so existing
    // tests don't construct the media stack and tests that need it can override.
    ffmpegBinaryPath: null as string | null,
    taskManager: new TaskManager(),
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    segmentAria2: fakeSegmentAria2,
    tmpRoot: '/tmp/motrix-test',
    persistTask: vi.fn(async () => {}),
    ...over,
  }
}

describe('BridgeReceiver', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bridge-recv-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('handle: direct submit returns taskId and calls createTask', async () => {
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    const result = await r.handle(
      {
        source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
        selection: {
          kind: 'direct',
          primary: {
            url: 'http://x/f.mp4',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        },
        meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
      },
      {
        identity: { kind: 'extension', browser: 'chromium', extensionId: 'e' },
        startedAt: 0,
        isReady: () => false,
        markReady: () => {},
        pendingPair: null,
      } as never
    )
    expect(result.taskId).toBe('task-abc')
    expect(deps.createTask).toHaveBeenCalledTimes(1)
  })

  it('cancelMedia tears down the coordinator only and never re-enters removeTask', async () => {
    // Regression: removeTask's media branch calls cancelMedia; if cancelMedia
    // routed through cancel() -> DirectPipeline.cancel -> removeTask, removing a
    // media task would recurse infinitely (stack overflow). cancelMedia must
    // touch ONLY the coordinator.
    const removeTask = vi.fn(async () => {})
    const deps = fakeDeps({
      dataDir,
      removeTask,
      ffmpegBinaryPath: '/usr/bin/ffmpeg', // construct the media coordinator
    })
    const r = new BridgeReceiver(deps as never)

    // Baseline: the submit-cancel path (cancel) DOES route through
    // DirectPipeline.cancel -> removeTask.
    await r.cancel('some-direct-task')
    expect(removeTask).toHaveBeenCalled()

    // The remove-teardown path (cancelMedia) must NOT — else the loop above.
    removeTask.mockClear()
    await r.cancelMedia('some-media-task')
    expect(removeTask).not.toHaveBeenCalled()
  })

  it('handle: rejects a non-extension (cli) session identity', async () => {
    // download/submit is extension-only. The agent-facing gate already keeps a
    // cli off this method at the unary layer; this is the defense-in-depth
    // guard so the receiver never reads extensionId/browser off a cli identity.
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    await expect(
      r.handle(
        {
          source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
          selection: {
            kind: 'direct',
            primary: {
              url: 'http://x/f.mp4',
              headers: {},
              cookies: [],
              refererPolicy: 'strict-origin-when-cross-origin',
            },
          },
          meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
        },
        {
          identity: { kind: 'cli', id: 'local' },
          startedAt: 0,
          isReady: () => true,
          markReady: () => {},
          pendingPair: null,
        } as never
      )
    ).rejects.toMatchObject({ code: ErrorCodes.CapabilityNotSupported })
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  it('start: subscribes to EventBus.TaskUpdated', () => {
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    r.start()
    expect(deps.eventBus.on).toHaveBeenCalled()
  })

  it('start: derives per-task progress + completed from a TaskUpdated array (bridge tasks only)', () => {
    // Regression for the discovered Plan 02 bug: Events.TaskUpdated carries
    // taskManager.getAll() (an array), and TaskCompleted/TaskFailed are never
    // emitted on the core bus — so the WS push must iterate + derive.
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    r.start()
    const listener = (
      deps.eventBus.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([ev]) => ev === Events.TaskUpdated)?.[1] as (
      p: unknown
    ) => void
    expect(listener).toBeDefined()

    const meta = {
      kind: 'direct' as const,
      extensionId: 'e',
      browser: 'chromium' as const,
      sessionKey: 'chromium:e',
      pageUrl: '',
      pageTitle: '',
      qualityLabel: '',
      durationSec: null,
      submittedAt: 0,
    }
    const bridge = (over: Partial<DownloadTask>) =>
      makeDownloadTask({ source: 'bridge', sourceMeta: meta, ...over })

    listener([
      bridge({ id: 'b1', status: TaskStatus.Downloading }),
      bridge({ id: 'b2', status: TaskStatus.Completed, finalPath: '/dl/x' }),
      // user task is filtered out by ProgressPublisher's source guard
      makeDownloadTask({ id: 'u1', status: TaskStatus.Downloading }),
    ])

    expect(deps.bridgeBus.emitTaskProgress).toHaveBeenCalledTimes(1)
    expect(deps.bridgeBus.emitTaskCompleted).toHaveBeenCalledTimes(1)
  })

  it('cancel: delegates to removeTask using the public taskId', async () => {
    // Boundary test: BridgeReceiver.cancel → DirectPipeline.cancel → deps.removeTask.
    // The deps.removeTask now takes the MDXP taskId (== DownloadTask.id)
    // directly; the core removeTask action also keys by task.id, so the
    // identity round-trips end-to-end without a gid lookup.
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    await r.cancel('task-abc')
    expect(deps.removeTask).toHaveBeenCalledWith('task-abc')
  })

  it('stop: unsubscribes the same TaskUpdated listener it registered', () => {
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    r.start()
    const onListener = (
      deps.eventBus.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([ev]) => ev === Events.TaskUpdated)?.[1]
    r.stop()
    expect(deps.eventBus.off).toHaveBeenCalledWith(
      Events.TaskUpdated,
      onListener
    )
  })

  it('restoreInflight: no-op', async () => {
    const deps = fakeDeps({ dataDir })
    const r = new BridgeReceiver(deps as never)
    await r.restoreInflight()
  })

  it('routes a magnet submit to a bt createTask', async () => {
    const createTask = vi.fn(async () => ({ gid: 'g', taskId: 'mt1' }))
    const deps = fakeDeps({ dataDir, createTask })
    const receiver = new BridgeReceiver(deps as never)
    const out = await receiver.handle(
      {
        source: {
          pageUrl: 'https://example.com/p',
          pageTitle: 'P',
          detectedAt: 1,
        },
        selection: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc' },
        meta: { suggestedFilename: 'm', qualityLabel: 'file' },
      },
      {
        identity: { kind: 'extension', extensionId: 'e', browser: 'chromium' },
      } as never
    )
    expect(out).toEqual({ taskId: 'mt1' })
    expect((createTask.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      type: 'bt',
      payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc' },
    })
  })

  // ---------------------------------------------------------------------------
  // Media pipeline routing tests
  // Strategy: inject deps.fetchManifest as a seam so tests never hit the network.
  // ffmpegBinaryPath=null → unsupported-kind (pipeline not built)
  // ffmpegBinaryPath set + fetchManifest stub → routed to HlsDashPipeline,
  //   which calls coordinator.start → returns { taskId }. coordinator.start
  //   is async and performs real I/O, so we spy on HlsDashPipeline.dispatch
  //   instead of letting the full stack run (which would need a real aria2 + ffmpeg).
  // ---------------------------------------------------------------------------

  describe('media pipeline routing', () => {
    const hlsSubmitParams = {
      source: { pageUrl: 'https://x.com', pageTitle: 'X', detectedAt: 1 },
      selection: {
        kind: 'hls' as const,
        primary: {
          url: 'http://example.com/index.m3u8',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
        container: 'mp4' as const,
      },
      meta: { suggestedFilename: 'video.mp4', qualityLabel: '1080p' },
    }

    const muxSubmitParams = {
      source: { pageUrl: 'https://x.com', pageTitle: 'X', detectedAt: 1 },
      selection: {
        kind: 'mux' as const,
        video: {
          url: 'http://example.com/video.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
        audio: {
          url: 'http://example.com/audio.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
        container: 'mp4' as const,
      },
      meta: { suggestedFilename: 'out.mp4', qualityLabel: '1080p' },
    }

    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    it('hls submit throws unsupported-kind when ffmpegBinaryPath is null', async () => {
      const deps = fakeDeps({ dataDir, ffmpegBinaryPath: null })
      const r = new BridgeReceiver(deps as never)
      await expect(r.handle(hlsSubmitParams, extCtx)).rejects.toMatchObject({
        name: 'BridgeReceiverError',
        code: 'unsupported-kind',
      })
    })

    it('dash submit throws unsupported-kind when ffmpegBinaryPath is null', async () => {
      const dashParams = {
        ...hlsSubmitParams,
        selection: {
          ...hlsSubmitParams.selection,
          kind: 'dash' as const,
          container: 'mp4' as const,
        },
      }
      const deps = fakeDeps({ dataDir, ffmpegBinaryPath: null })
      const r = new BridgeReceiver(deps as never)
      await expect(r.handle(dashParams, extCtx)).rejects.toMatchObject({
        name: 'BridgeReceiverError',
        code: 'unsupported-kind',
      })
    })

    it('mux submit throws unsupported-kind when ffmpegBinaryPath is null', async () => {
      const deps = fakeDeps({ dataDir, ffmpegBinaryPath: null })
      const r = new BridgeReceiver(deps as never)
      await expect(r.handle(muxSubmitParams, extCtx)).rejects.toMatchObject({
        name: 'BridgeReceiverError',
        code: 'unsupported-kind',
      })
    })

    it('hls submit routes to HlsDashPipeline.dispatch when ffmpegBinaryPath is set', async () => {
      // Stub fetchManifest to return a tiny HLS media playlist (no network).
      const fakeM3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:5',
        '#EXTINF:5.0,',
        'http://example.com/seg0.ts',
        '#EXT-X-ENDLIST',
      ].join('\n')
      const stubFetchManifest = vi.fn(async () => fakeM3u8)

      // Stub coordinator.start so the real download pipeline is never executed.
      // We inject it via MediaTaskCoordinator's deps by spying on the pipeline
      // AFTER construction — capture HlsDashPipeline.dispatch via module spy trick.
      // Easier: pass a fetchManifest that returns the playlist; then stub the
      // HlsDashPipeline by replacing the internal coordinator.start.
      // Approach: replace deps.fetchManifest and stub coordinator via the
      // MediaTaskCoordinator mkdtemp + makeDownloader injection.
      // Simplest offline approach: spy on the dispatch method post-construction.
      const deps = fakeDeps({
        dataDir,
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: stubFetchManifest,
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
      })
      const r = new BridgeReceiver(deps as never)

      // Spy on internal hlsDash.dispatch to short-circuit actual segment work.
      // This verifies the routing wires up correctly without running aria2/ffmpeg.
      const hlsDash = (
        r as unknown as {
          hlsDash: {
            dispatch: (...a: unknown[]) => Promise<{ taskId: string }>
          }
        }
      ).hlsDash
      expect(hlsDash).toBeDefined()
      const dispatchSpy = vi
        .spyOn(hlsDash, 'dispatch')
        .mockResolvedValue({ taskId: 'media-task-1' })

      const result = await r.handle(hlsSubmitParams, extCtx)
      expect(result).toEqual({ taskId: 'media-task-1' })
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    })

    it('mux submit routes to MuxPipeline.dispatch when ffmpegBinaryPath is set', async () => {
      const deps = fakeDeps({
        dataDir,
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: vi.fn(async () => ''),
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
      })
      const r = new BridgeReceiver(deps as never)

      const mux = (
        r as unknown as {
          mux: { dispatch: (...a: unknown[]) => Promise<{ taskId: string }> }
        }
      ).mux
      expect(mux).toBeDefined()
      const dispatchSpy = vi
        .spyOn(mux, 'dispatch')
        .mockResolvedValue({ taskId: 'mux-task-1' })

      const result = await r.handle(muxSubmitParams, extCtx)
      expect(result).toEqual({ taskId: 'mux-task-1' })
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // resolveToMux seam tests (Task 5 — submit-path pre-resolve)
  // ---------------------------------------------------------------------------

  describe('resolveToMux seam', () => {
    const directParams = {
      source: {
        pageUrl: 'https://www.youtube.com/watch?v=abc',
        pageTitle: 'T',
        detectedAt: 1,
      },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'https://www.youtube.com/watch?v=abc',
          headers: { 'x-custom': 'val' },
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'vid.mp4', qualityLabel: '1080p' },
    }

    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    it('resolveToMux returning a mux pair routes direct submit to MuxPipeline (not DirectPipeline)', async () => {
      // Set up resolveToMux to return a mux pair
      const resolveToMux = vi.fn(async (_url: string) => ({
        videoUrl: 'https://rr1.googlevideo.com/video.mp4',
        audioUrl: 'https://rr1.googlevideo.com/audio.mp4',
        container: 'mp4' as const,
        headers: { 'x-ytdl': '1' },
      }))

      const deps = fakeDeps({
        dataDir,
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: vi.fn(async () => ''),
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
        resolveToMux,
      })
      const r = new BridgeReceiver(deps as never)

      // Spy on mux.dispatch to verify routing without running the real pipeline
      const mux = (
        r as unknown as {
          mux: { dispatch: (...a: unknown[]) => Promise<{ taskId: string }> }
        }
      ).mux
      expect(mux).toBeDefined()
      const muxDispatchSpy = vi
        .spyOn(mux, 'dispatch')
        .mockResolvedValue({ taskId: 'pre-resolved-mux-1' })

      // Also spy on direct.dispatch to confirm it was NOT called
      const direct = (
        r as unknown as {
          direct: { dispatch: (...a: unknown[]) => Promise<{ taskId: string }> }
        }
      ).direct
      const directDispatchSpy = vi.spyOn(direct, 'dispatch')

      const result = await r.handle(directParams, extCtx)

      expect(result).toEqual({ taskId: 'pre-resolved-mux-1' })
      expect(muxDispatchSpy).toHaveBeenCalledTimes(1)
      expect(directDispatchSpy).not.toHaveBeenCalled()

      // The adapted taskId from the direct adapt must be reused in the mux call
      const muxArg = muxDispatchSpy.mock.calls[0]?.[0] as {
        kind: string
        taskId: string
        videoUrl: string
        audioUrl: string
        container: string
      }
      expect(muxArg.kind).toBe('mux')
      expect(typeof muxArg.taskId).toBe('string')
      expect(muxArg.videoUrl).toBe('https://rr1.googlevideo.com/video.mp4')
      expect(muxArg.audioUrl).toBe('https://rr1.googlevideo.com/audio.mp4')
      expect(muxArg.container).toBe('mp4')
    })

    it('re-picks the resolver title WITH its container extension (dedup runs on the on-disk name)', async () => {
      const resolveToMux = vi.fn(async () => ({
        videoUrl: 'https://v/v.mp4',
        audioUrl: 'https://a/a.m4a',
        container: 'mp4' as const,
        title: 'Human Title',
      }))
      const picked: string[] = []
      const deps = fakeDeps({
        dataDir,
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: vi.fn(async () => ''),
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
        resolveToMux,
        pickName: async (_d: string, n: string) => {
          picked.push(n)
          return n
        },
      })
      const r = new BridgeReceiver(deps as never)
      const mux = (
        r as unknown as {
          mux: { dispatch: (...a: unknown[]) => Promise<{ taskId: string }> }
        }
      ).mux
      const muxDispatchSpy = vi
        .spyOn(mux, 'dispatch')
        .mockResolvedValue({ taskId: 't' })

      await r.handle(directParams, extCtx)

      // The re-route pick must see the name that lands on disk — extension
      // included — otherwise the dedup counter is computed on 'Human Title'
      // while the file is 'Human Title.mp4'.
      expect(picked).toContain('Human Title.mp4')
      const muxArg = muxDispatchSpy.mock.calls[0]?.[0] as { finalName: string }
      expect(muxArg.finalName).toBe('Human Title.mp4')
    })

    it('resolveToMux returning null falls through to direct dispatch (no regression)', async () => {
      const resolveToMux = vi.fn(async (_url: string) => null)

      const deps = fakeDeps({
        dataDir,
        resolveToMux,
      })
      const r = new BridgeReceiver(deps as never)

      const result = await r.handle(directParams, extCtx)

      // resolveToMux returned null → direct pipeline; createTask was called
      expect(result.taskId).toBeDefined()
      expect(deps.createTask).toHaveBeenCalledTimes(1)
      // Empty cookies → cookieHeader is undefined (not forwarded)
      expect(resolveToMux).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=abc',
        undefined
      )
    })

    it('resolveToMux absent (undefined) falls through to direct dispatch (full no-regression)', async () => {
      // When resolveToMux is not set at all, direct submit proceeds as before
      const deps = fakeDeps({ dataDir })
      const r = new BridgeReceiver(deps as never)

      const result = await r.handle(directParams, extCtx)

      expect(result.taskId).toBeDefined()
      expect(deps.createTask).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // serializeCookieHeader helper tests (BIL-HD)
  // ---------------------------------------------------------------------------

  describe('serializeCookieHeader()', () => {
    it('serializes two cookies to a Cookie header string', async () => {
      // Import the helper directly from BridgeReceiver module
      const { serializeCookieHeader } = await import('./bridge-receiver')
      const cookies = [
        { name: 'SESSDATA', value: 'abc' },
        { name: 'bili_jct', value: 'x' },
      ]
      expect(serializeCookieHeader(cookies)).toBe('SESSDATA=abc; bili_jct=x')
    })

    it('returns empty string for empty array', async () => {
      const { serializeCookieHeader } = await import('./bridge-receiver')
      expect(serializeCookieHeader([])).toBe('')
    })

    it('serializes a single cookie', async () => {
      const { serializeCookieHeader } = await import('./bridge-receiver')
      expect(
        serializeCookieHeader([{ name: 'SESSDATA', value: 'tok123' }])
      ).toBe('SESSDATA=tok123')
    })
  })

  // ---------------------------------------------------------------------------
  // BridgeReceiver cookie seam tests (BIL-HD)
  // ---------------------------------------------------------------------------

  describe('cookie seam: resolveToMux receives cookieHeader', () => {
    const bilibiliPageParams = {
      source: {
        pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
        pageTitle: 'B',
        detectedAt: 1,
      },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          headers: {},
          cookies: [
            {
              name: 'SESSDATA',
              value: 'abc',
              domain: '.bilibili.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'lax' as const,
            },
            {
              name: 'bili_jct',
              value: 'x',
              domain: '.bilibili.com',
              path: '/',
              secure: false,
              httpOnly: false,
              sameSite: 'lax' as const,
            },
          ],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'vid', qualityLabel: '1080p' },
    }

    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    it('direct submit with cookies → resolveToMux called with serialized cookie header as 2nd arg', async () => {
      const resolveToMux = vi.fn(async () => null)
      const deps = fakeDeps({ dataDir, resolveToMux })
      const r = new BridgeReceiver(deps as never)
      await r.handle(bilibiliPageParams, extCtx)
      expect(resolveToMux).toHaveBeenCalledWith(
        'https://www.bilibili.com/video/BV1xx411c7mD',
        'SESSDATA=abc; bili_jct=x'
      )
    })

    it('direct submit with empty cookies → resolveToMux called with url only (2nd arg undefined)', async () => {
      const resolveToMux = vi.fn(async () => null)
      const paramsNoCookies = {
        ...bilibiliPageParams,
        selection: {
          ...bilibiliPageParams.selection,
          primary: {
            ...bilibiliPageParams.selection.primary,
            cookies: [],
          },
        },
      }
      const deps = fakeDeps({ dataDir, resolveToMux })
      const r = new BridgeReceiver(deps as never)
      await r.handle(paramsNoCookies, extCtx)
      // 2nd arg should be undefined (empty cookies → no cookie forwarding)
      expect(resolveToMux).toHaveBeenCalledWith(
        'https://www.bilibili.com/video/BV1xx411c7mD',
        undefined
      )
    })
  })

  // ---------------------------------------------------------------------------
  // download/submit idempotency (dedup on session + idempotencyKey)
  // ---------------------------------------------------------------------------

  describe('submit idempotency', () => {
    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    const submitParams = (idempotencyKey?: string) => ({
      source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'http://x/f.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })

    it('collapses a retransmit with the same key onto the pending submit', async () => {
      let resolveCreate!: (v: { gid: string; taskId: string }) => void
      const createTask = vi.fn(
        () =>
          new Promise<{ gid: string; taskId: string }>((r) => {
            resolveCreate = r
          })
      )
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const p1 = r.handle(submitParams('key-aaaaaaaa'), extCtx)
      const p2 = r.handle(submitParams('key-aaaaaaaa'), extCtx)
      // createTask is reached only after the async adapt (cookie-jar write);
      // wait for the first dispatch to arrive there before releasing it.
      await vi.waitFor(() => expect(createTask).toHaveBeenCalled())
      resolveCreate({ gid: 'g', taskId: 'task-1' })
      const [r1, r2] = await Promise.all([p1, p2])

      expect(createTask).toHaveBeenCalledTimes(1)
      expect(r1.taskId).toBe(r2.taskId)
    })

    it('a settled key keeps returning the original task (exact retransmit after completion)', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const r1 = await r.handle(submitParams('key-bbbbbbbb'), extCtx)
      const r2 = await r.handle(submitParams('key-bbbbbbbb'), extCtx)
      expect(createTask).toHaveBeenCalledTimes(1)
      expect(r2.taskId).toBe(r1.taskId)
    })

    it('different keys create independent tasks', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const r1 = await r.handle(submitParams('key-cccccccc'), extCtx)
      const r2 = await r.handle(submitParams('key-dddddddd'), extCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
      expect(r1.taskId).not.toBe(r2.taskId)
    })

    it('a failed submit is NOT cached — the same key retries for real', async () => {
      const createTask = vi
        .fn()
        .mockRejectedValueOnce(new Error('engine down'))
        .mockResolvedValueOnce({ gid: 'g', taskId: 'task-retry' })
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      await expect(
        r.handle(submitParams('key-eeeeeeee'), extCtx)
      ).rejects.toThrow('engine down')
      const r2 = await r.handle(submitParams('key-eeeeeeee'), extCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
      expect(r2.taskId).toBe('task-retry')
    })

    it('no key → no dedup (back-compat with older extensions)', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      await r.handle(submitParams(), extCtx)
      await r.handle(submitParams(), extCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
    })

    it('eviction never drops a PENDING submit (a long media submit survives a keyed burst)', async () => {
      let resolveCreate!: (v: { gid: string; taskId: string }) => void
      const first = new Promise<{ gid: string; taskId: string }>((r) => {
        resolveCreate = r
      })
      const createTask = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockImplementation(async () => ({ gid: 'g', taskId: 'quick' }))
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const pending = r.handle(submitParams('key-pending-000'), extCtx)
      await vi.waitFor(() => expect(createTask).toHaveBeenCalled())

      // A burst larger than the dedup cache capacity. Capacity eviction must
      // skip the still-pending entry — evicting it would let a reconnect
      // replay re-dispatch the same logical submit as a duplicate task.
      for (let i = 0; i < 500; i++) {
        await r.handle(
          submitParams(`key-burst-${String(i).padStart(8, '0')}`),
          extCtx
        )
      }

      const callsBefore = createTask.mock.calls.length
      const replay = r.handle(submitParams('key-pending-000'), extCtx)
      resolveCreate({ gid: 'g', taskId: 'task-first' })
      const [a, b] = await Promise.all([pending, replay])

      expect(a.taskId).toBe('task-first')
      expect(b.taskId).toBe('task-first')
      expect(createTask.mock.calls.length).toBe(callsBefore)
    })

    it('keys are scoped per session — same key from another extension is a new submit', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ dataDir, createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)
      const otherCtx = {
        identity: {
          kind: 'extension' as const,
          extensionId: 'other',
          browser: 'firefox' as const,
        },
      } as never

      await r.handle(submitParams('key-ffffffff'), extCtx)
      await r.handle(submitParams('key-ffffffff'), otherCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
    })
  })

  // A submit that lands while SessionManager.restore() is still running gets
  // its freshly-registered task wiped by restore's clear() and re-adopted as
  // an engine orphan (name with `.motrix`, source/sourceMeta lost, extension
  // progress notifications orphaned). The bootstrap passes a waitForReady
  // gate that resolves once startup restore has settled; every submit must
  // await it BEFORE any pipeline work reaches the engine.
  describe('startup ready gate (waitForReady)', () => {
    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    const directParams = () => ({
      source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'http://x/f.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
    })

    it('holds a submit until waitForReady resolves', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const createTask = vi.fn(async () => ({ gid: 'g', taskId: 'task-abc' }))
      const deps = fakeDeps({
        dataDir,
        createTask: createTask as never,
        waitForReady: () => gate,
      } as never)
      const r = new BridgeReceiver(deps as never)

      const pending = r.handle(directParams(), extCtx)
      // Drain a few macrotask turns — without the gate the dispatch would
      // have reached createTask by now (adapt's cookie-jar write is the
      // only other async step).
      await new Promise((res) => setTimeout(res, 10))
      expect(createTask).not.toHaveBeenCalled()

      release()
      const result = await pending
      expect(result.taskId).toBe('task-abc')
      expect(createTask).toHaveBeenCalledTimes(1)
    })

    it('dispatches immediately when no gate is wired (back-compat)', async () => {
      const deps = fakeDeps({ dataDir })
      const r = new BridgeReceiver(deps as never)
      const result = await r.handle(directParams(), extCtx)
      expect(result.taskId).toBe('task-abc')
    })
  })
})
