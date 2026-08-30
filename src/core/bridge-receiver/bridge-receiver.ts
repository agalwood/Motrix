import fs from 'node:fs'
import path from 'node:path'
import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { IdempotencyCache } from '@core/bridge/idempotency-cache'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import type { SegmentAria2 } from '@core/download/segment-downloader'
import { SegmentDownloader } from '@core/download/segment-downloader'
import { FfmpegService } from '@core/ffmpeg/ffmpeg-service'
import { newTaskId } from '@core/lib/ids'
import { fetchManifest } from '@core/media/manifest-fetcher'
import { assembleSegments } from '@core/media/segment-assembler'
import { SegmentDecryptor } from '@core/media/segment-decryptor'
import { MediaTaskCoordinator } from '@core/task/media-task-coordinator'
import type { TaskManager } from '@core/task/task-manager'
import {
  type DownloadSubmitParams,
  ErrorCodes,
  makeMdxpError,
} from '@motrix/mdxp'
import { clientKey } from '@shared/protocol/bridge'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type { BridgeErrorCode } from './errors'
import { BridgeReceiverError } from './errors'
import { stripHopByHopHeaders } from './header-replay'
import { DirectPipeline } from './pipelines/direct-pipeline'
import { HlsDashPipeline } from './pipelines/hls-dash-pipeline'
import { MagnetPipeline } from './pipelines/magnet-pipeline'
import { ensureMediaExtension } from './pipelines/media-final-name'
import { MuxPipeline } from './pipelines/mux-pipeline'
import {
  dispatchTaskUpdates,
  type TaskNotificationSink,
} from './progress-mapping'
import { ProgressPublisher } from './progress-publisher'
import {
  type AdaptedMux,
  type AdapterDeps,
  SubmitDownloadAdapter,
  sanitizeFilename,
} from './submit-download-adapter'

/**
 * Serialize a list of Cookie objects (from @motrix/mdxp Resource.cookies) into
 * a ready-to-send Cookie header string: `name=value; name=value`.
 * Empty array → empty string. Caller should treat '' as "no cookies".
 */
export function serializeCookieHeader(
  cookies: ReadonlyArray<{ name: string; value: string }>
): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export interface BridgeReceiverDeps {
  dataDir: string
  defaultSaveDir: string
  pickName: AdapterDeps['pickName']
  createTask: ConstructorParameters<typeof DirectPipeline>[0]['createTask']
  removeTask: ConstructorParameters<typeof DirectPipeline>[0]['removeTask']
  submitMagnetForFileSelection: ConstructorParameters<
    typeof MagnetPipeline
  >[0]['submitMagnetForFileSelection']
  isMagnetFileSelectionEnabled: ConstructorParameters<
    typeof MagnetPipeline
  >[0]['isMagnetFileSelectionEnabled']
  eventBus: {
    on(event: string, listener: (payload: unknown) => void): unknown
    off(event: string, listener: (payload: unknown) => void): unknown
    emit?(event: string, payload: unknown): void
  }
  bridgeBus: BridgeEventBus
  localize: (code: BridgeErrorCode) => string
  /** Path to ffmpeg binary. When null, hls/dash/mux submissions are rejected. */
  ffmpegBinaryPath: string | null
  /**
   * Live resolver used immediately before muxing. Defaults to the startup
   * path for shells/tests that do not provide dynamic resolution.
   */
  resolveFfmpegBinaryPath?: () => Promise<string | null>
  taskManager: TaskManager
  activityRecorder: TaskActivityRecorder
  /** Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher),
   *  threaded into the MediaTaskCoordinator this receiver constructs. */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  segmentAria2: SegmentAria2
  tmpRoot: string
  /**
   * Durable-save hook for the media coordinator's completion flip (media
   * tasks bypass the aria2 poll loop's transition saves). Wired to the main
   * shell's persistTask; optional so tests and the Node shell can omit it.
   */
  persistTask: (task: DownloadTask) => Promise<void>
  /**
   * Persist a media task and (when non-null) its terminal occurrence in a
   * single durable transaction — used INSTEAD OF `persistTask` whenever a
   * status transition qualifies for one. Optional; absence degrades to
   * plain `persistTask`.
   */
  persistTaskWithOccurrence?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['persistTaskWithOccurrence']
  /** Delivers a just-committed terminal occurrence to in-process consumers. */
  occurrenceDispatcher?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['occurrenceDispatcher']
  /**
   * Inspector Activity parent-row barrier for coordinator-owned media tasks.
   * The task must not enter TaskManager until this resolves.
   */
  parentTaskCreated?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['parentTaskCreated']
  /**
   * Exact post-durable lifecycle recorder for media status transitions.
   */
  recordTransition?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['recordTransition']
  runTaskMutation?: ConstructorParameters<
    typeof MediaTaskCoordinator
  >[0]['runTaskMutation']
  /**
   * Optional override for manifest fetching. Defaults to the real fetchManifest.
   * Inject a stub in tests to avoid network calls.
   */
  fetchManifest?: (
    url: string,
    opts: { headers?: Record<string, string> }
  ) => Promise<string>
  /**
   * Optional submit-path pre-resolver. When present and the adapted URL is a
   * YouTube watch page or bilibili page, this is called before kind-routing.
   * If it returns a mux pair the direct submit is transparently re-routed to
   * the MuxPipeline. Absent or returning null → direct download proceeds.
   * All error handling lives in the bootstrap factory (returns null on failure).
   * An optional cookieHeader (2nd arg) is forwarded when the submit carries
   * cookies (bilibili HD path). Omitted for YouTube and desktop submits.
   */
  resolveToMux?: (
    url: string,
    cookieHeader?: string
  ) => Promise<{
    videoUrl: string
    audioUrl: string
    container: 'mp4' | 'mkv'
    headers?: Record<string, string>
    title?: string
  } | null>
  /**
   * Optional startup gate awaited before any submit reaches a pipeline.
   * The bootstrap resolves it once engine start + SessionManager.restore()
   * have settled. Without it, a submit racing startup restore gets its
   * freshly-registered task wiped by restore's clear() and re-adopted as an
   * engine orphan: name keeps the `.motrix` placeholder, source flips to
   * 'user', sourceMeta is lost, and the taskId already acked to the
   * extension points at a task that no longer exists. Absent ⇒ no gate
   * (tests, Node shell back-compat).
   */
  waitForReady?: () => Promise<void>
}

/**
 * Entry point of subsystem ③. Implements SubmitDownloadHandler from
 * src/core/bridge/web-socket-bridge-server.ts:45 — synchronously returns
 * { taskId } so the server can ack the extension immediately. All
 * progress / completion / error events flow asynchronously via
 * BridgeEventBus.
 */
export class BridgeReceiver {
  private readonly adapter: SubmitDownloadAdapter
  private readonly direct: DirectPipeline
  private readonly magnet: MagnetPipeline
  private readonly publisher: ProgressPublisher
  private readonly hlsDash: HlsDashPipeline | undefined
  private readonly mux: MuxPipeline | undefined
  private readonly coordinator: MediaTaskCoordinator | undefined
  // Terminal-transition dedup for the WS push (same harness as the SSE source).
  private readonly terminalEmitted = new Map<string, string>()
  /**
   * In-flight and settled download/submit results keyed by
   * [clientKey(identity), idempotencyKey]. A retransmit of the same logical
   * submit (lost response, reconnect replay) awaits or receives the original
   * result instead of creating a duplicate task — dedup semantics live in
   * IdempotencyCache (failure eviction, settled-only capacity eviction).
   */
  private readonly submitsByKey = new IdempotencyCache<{ taskId: string }>()

  constructor(private readonly deps: BridgeReceiverDeps) {
    this.adapter = new SubmitDownloadAdapter({
      dataDir: deps.dataDir,
      defaultSaveDir: deps.defaultSaveDir,
      pickName: deps.pickName,
      mintTaskId: newTaskId,
    })
    this.direct = new DirectPipeline({
      createTask: deps.createTask,
      removeTask: deps.removeTask,
    })
    this.magnet = new MagnetPipeline({
      createTask: deps.createTask,
      removeTask: deps.removeTask,
      submitMagnetForFileSelection: deps.submitMagnetForFileSelection,
      isMagnetFileSelectionEnabled: deps.isMagnetFileSelectionEnabled,
    })
    this.publisher = new ProgressPublisher(deps.bridgeBus, deps.localize)

    if (deps.ffmpegBinaryPath !== null) {
      const eventBusWithEmit = deps.eventBus as {
        on(event: string, listener: (payload: unknown) => void): unknown
        off(event: string, listener: (payload: unknown) => void): unknown
        emit(event: string, payload: unknown): void
      }
      const tmpRoot = deps.tmpRoot
      const coordinator = new MediaTaskCoordinator({
        taskManager: deps.taskManager,
        activityRecorder: deps.activityRecorder,
        eventBus: eventBusWithEmit,
        publishTaskUpdate: deps.publishTaskUpdate,
        publishTaskUpdateNow: deps.publishTaskUpdateNow,
        resolveFfmpegBinaryPath:
          deps.resolveFfmpegBinaryPath ??
          (() => Promise.resolve(deps.ffmpegBinaryPath)),
        pickName: deps.pickName,
        persist: deps.persistTask,
        persistTaskWithOccurrence: deps.persistTaskWithOccurrence,
        occurrenceDispatcher: deps.occurrenceDispatcher,
        parentTaskCreated: deps.parentTaskCreated,
        recordTransition: deps.recordTransition,
        runTaskMutation: deps.runTaskMutation,
        makeDownloader: (tmpDir: string) =>
          new SegmentDownloader({ aria2: deps.segmentAria2, tmpDir }),
        decryptor: new SegmentDecryptor(),
        assemble: assembleSegments,
        makeFfmpeg: () => new FfmpegService(),
        mkdtemp: async () => {
          // mkdtemp requires its PARENT to exist. tmpRoot (app temp/motrix-media)
          // is not created anywhere else, so ensure it first — otherwise the
          // first mux/hls/dash task fails with ENOENT on mkdtemp.
          await fs.promises.mkdir(tmpRoot, { recursive: true })
          const base = path.join(tmpRoot, 'motrix-media-')
          return fs.promises.mkdtemp(base)
        },
      })
      this.coordinator = coordinator
      const resolvedFetchManifest = deps.fetchManifest ?? fetchManifest
      this.hlsDash = new HlsDashPipeline({
        fetchManifest: resolvedFetchManifest,
        coordinator,
      })
      this.mux = new MuxPipeline({ coordinator })
    }
  }

  /**
   * Read-only access to the shared MuxPipeline. Used by the desktop
   * Add-Task path (main/index.ts createDeps) to reuse the same
   * coordinator/mux-pipeline instance — avoids the SP-1 phantom-task
   * bug that would arise from constructing a second coordinator.
   * Undefined when ffmpeg is unavailable (mux pipeline not active).
   */
  get muxPipeline(): MuxPipeline | undefined {
    return this.mux
  }

  /**
   * Active aria2 segment gids for a coordinator-managed media task (kind
   * Mux/Hls). These ARE real aria2 gids — unlike the task's empty engineTaskId
   * — so pause/resume can act on them. Returns [] when the task is unknown, is
   * past the download phase, or ffmpeg (and thus the coordinator) is absent.
   */
  getMediaSegmentGids(taskId: string): string[] {
    return this.coordinator?.getActiveSegmentGids(taskId) ?? []
  }

  /** SubmitDownloadHandler: the bridge dispatcher injects this. */
  async handle(
    params: DownloadSubmitParams,
    ctx: MdxpSessionContext
  ): Promise<{ taskId: string }> {
    // download/submit is extension-only. The agent-facing gate already keeps a
    // cli off this method at the unary layer; this is the defense-in-depth
    // guard so the receiver never reads extensionId/browser off a cli identity.
    if (ctx.identity.kind !== 'extension') {
      throw makeMdxpError(
        ErrorCodes.CapabilityNotSupported,
        `download/submit is not available to ${ctx.identity.kind} clients`
      )
    }
    const identity = ctx.identity
    const key = params.idempotencyKey
    if (!key) return this.dispatchSubmit(params, identity)

    return this.submitsByKey.run(
      JSON.stringify([clientKey(identity), key]),
      () => this.dispatchSubmit(params, identity)
    )
  }

  private async dispatchSubmit(
    params: DownloadSubmitParams,
    identity: Extract<MdxpSessionContext['identity'], { kind: 'extension' }>
  ): Promise<{ taskId: string }> {
    // Hold the submit until startup restore has settled (see the dep doc).
    // Awaited before adapt so even the name pick / cookie-jar write see the
    // final on-disk state left by restore/recovery.
    if (this.deps.waitForReady) {
      await this.deps.waitForReady()
    }
    const adapted = await this.adapter.adapt(params, {
      extensionId: identity.extensionId,
      browser: identity.browser,
    })

    // Submit-path pre-resolve: if the adapted result is a direct download and
    // a resolveToMux factory is wired (bootstrap only), call it. On a non-null
    // mux pair the direct submit is transparently re-routed to MuxPipeline.
    // resolveToMux owns its own error handling (catches → null), so we never
    // wrap this in try/catch here — a null means "proceed as direct".
    //
    // Cookie handoff (bilibili HD): when the extension submits a direct download
    // with cookies (e.g. SESSDATA for bilibili), serialize them into a Cookie
    // header string and pass it as the 2nd arg to resolveToMux. The resolver
    // attaches the header ONLY to api.bilibili.com calls — never to CDN URLs.
    if (adapted.kind === 'direct' && this.deps.resolveToMux) {
      const rawCookies =
        params.selection.kind === 'direct'
          ? params.selection.primary.cookies
          : []
      const serialized = serializeCookieHeader(rawCookies)
      const cookieHeader = serialized || undefined
      const m = await this.deps.resolveToMux(adapted.primaryUrl, cookieHeader)
      if (m) {
        if (!this.mux) {
          throw new BridgeReceiverError(
            'unsupported-kind',
            'ffmpeg unavailable — mux pipeline not active'
          )
        }
        // Prefer the resolver's human title over the URL-derived name (a bvid
        // like BV1xxx is meaningless). Sanitize, append the container
        // extension, THEN dedup — the pick must run on the on-disk name.
        const titleBase = m.title ? sanitizeFilename(m.title).trim() : ''
        const finalName = titleBase
          ? await this.deps.pickName(
              adapted.saveDir,
              ensureMediaExtension(titleBase, m.container)
            )
          : adapted.finalName
        const muxAdapted: AdaptedMux = {
          kind: 'mux',
          taskId: adapted.taskId,
          saveDir: adapted.saveDir,
          finalName,
          videoUrl: m.videoUrl,
          audioUrl: m.audioUrl,
          sanitizedHeaders: m.headers
            ? stripHopByHopHeaders(m.headers)
            : adapted.sanitizedHeaders,
          container: m.container,
          sourceMeta: adapted.sourceMeta,
          ...(adapted.sourceMeta.durationSec != null
            ? { durationSec: adapted.sourceMeta.durationSec }
            : {}),
        }
        return this.mux.dispatch(muxAdapted)
      }
    }

    if (adapted.kind === 'magnet') {
      return this.magnet.dispatch(adapted)
    }
    if (adapted.kind === 'hls' || adapted.kind === 'dash') {
      if (!this.hlsDash) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg unavailable — hls/dash pipeline not active'
        )
      }
      return this.hlsDash.dispatch(adapted)
    }
    if (adapted.kind === 'mux') {
      if (!this.mux) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg unavailable — mux pipeline not active'
        )
      }
      return this.mux.dispatch(adapted)
    }
    return this.direct.dispatch(adapted)
  }

  private readonly sink: TaskNotificationSink = {
    onProgress: (task) => this.publisher.onTaskUpdated(task),
    onCompleted: (task) => this.publisher.onTaskCompleted(task),
    onError: (task, code) => this.publisher.onTaskFailed(task, code),
  }

  // Stored so stop() can unsubscribe the exact reference.
  private readonly handleTaskUpdated = (payload: unknown): void => {
    if (!Array.isArray(payload)) return
    dispatchTaskUpdates(
      payload as DownloadTask[],
      this.terminalEmitted,
      this.sink
    )
  }

  /**
   * Subscribe to the core EventBus. The only reliable task signal is
   * `Events.TaskUpdated`, which carries the FULL task list each poll tick
   * (TaskCompleted/TaskFailed are never emitted on the core bus). So iterate the
   * array through the shared `dispatchTaskUpdates` harness — it emits progress
   * per task and DERIVES completed/error from terminal status (deduped) — and
   * let `ProgressPublisher` apply the `source==='bridge'` filter + per-session
   * routing. Same derivation the SSE firehose uses.
   */
  start(): void {
    this.deps.eventBus.on(Events.TaskUpdated, this.handleTaskUpdated)
  }

  /**
   * Unsubscribe from the core EventBus. Called from the bootstrap shutdown so a
   * re-enabled bridge doesn't leak this (now dead) receiver instance — the core
   * EventBus is a process-lifetime singleton.
   */
  stop(): void {
    this.deps.eventBus.off(Events.TaskUpdated, this.handleTaskUpdated)
    this.terminalEmitted.clear()
  }

  /**
   * Stop publishing and cancel/drain every coordinator-owned media run.
   * Direct/aria2 downloads remain owned by the engine lifecycle; only the
   * long-lived HLS/DASH/mux processes created by this receiver are joined here.
   */
  async stopAndDrain(): Promise<void> {
    this.stop()
    await this.coordinator?.stopAndDrain()
  }

  /** Extension-initiated cancel. `taskId` is the MDXP public id
   *  (== DownloadTask.id), not an aria2 gid. The receiver does not know
   *  which subsystem owns the task, so both the direct pipeline and the
   *  media coordinator are tried defensively; not-found is silently swallowed. */
  async cancel(taskId: string): Promise<void> {
    await Promise.allSettled([
      this.direct.cancel(taskId),
      this.coordinator?.cancel(taskId),
    ])
  }

  /**
   * Tear down ONLY a coordinator-managed media task's in-flight run (segment
   * downloaders + ffmpeg + temp dir). No-op once the run has finished. Unlike
   * cancel(), this deliberately does NOT touch the DirectPipeline:
   * DirectPipeline.cancel routes back into removeTask, and this method is
   * invoked FROM removeTask's media-teardown branch — going through cancel()
   * would recurse (removeTask → cancelMedia → direct.cancel → removeTask → …).
   */
  async cancelMedia(taskId: string): Promise<void> {
    await this.coordinator?.cancel(taskId)
  }

  /**
   * On startup, revive any bridge-sourced state that survives a restart.
   * v1.0 needs nothing here: the aria2 session resumes in-flight tasks and
   * start() arms the EventBus subscriptions. Kept as the v1.1+ hook for
   * HLS / mux segment revival.
   */
  async restoreInflight(): Promise<void> {}
}
