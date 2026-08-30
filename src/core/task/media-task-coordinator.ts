import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  SegmentDownloader,
  SegmentProgress,
} from '@core/download/segment-downloader'
import {
  type FfmpegService,
  muxerForOutputName,
} from '@core/ffmpeg/ffmpeg-service'
import { pathExists } from '@core/fs/path-exists'
import { getLogger } from '@core/logger'
import type { assembleSegments } from '@core/media/segment-assembler'
import type { SegmentDecryptor } from '@core/media/segment-decryptor'
import type { SegmentPlan } from '@core/media/segment-plan'
import type { SourceMeta } from '@shared/types/task'
import {
  type DownloadTask,
  makeDownloadTask,
  type TaskInstance,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import {
  buildTerminalOccurrence,
  persistWithOccurrenceOrWarn,
  type TaskTransitionRecordInput,
  terminalSnapshotFromTask,
} from './actions/shared'
import { applyTerminalTransition } from './apply-terminal-transition'
import type { OccurrenceDispatcher } from './occurrences/occurrence-dispatcher'
import { toTempPath } from './paths'
import {
  applyTerminalStatusToTask,
  completeTaskAfterRename,
  setTaskTransitionPhase,
} from './task-instance'
import type { TaskManager } from './task-manager'

const log = getLogger('media-coordinator')

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MediaJob {
  taskId?: string
  video: SegmentPlan
  audio?: SegmentPlan
  headers: Record<string, string>
  saveDir: string
  finalName: string
  sourceMeta: SourceMeta
  durationSec?: number
  /** Pipeline kind — used to set the correct TaskKind on the DownloadTask. */
  kind?: 'hls' | 'dash' | 'mux'
}

export interface MediaCoordinatorDeps {
  taskManager: TaskManager
  activityRecorder: TaskActivityRecorder
  eventBus: { emit(event: string, payload: unknown): void }
  /**
   * Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher).
   * `emitUpdate` keeps its own coarser EMIT_THROTTLE_MS gate for pure
   * byte-progress and routes the surviving publications here: forced
   * status changes (especially terminal Completed/Error) flush
   * immediately, progress rides the trailing window.
   */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  /**
   * Resolve the executable immediately before muxing. Media downloads can run
   * for a long time, so a path captured at app startup may have been removed
   * or superseded by a settings change before FFmpeg is actually spawned.
   */
  resolveFfmpegBinaryPath: () => Promise<string | null>
  makeDownloader: (tmpDir: string) => SegmentDownloader
  decryptor: SegmentDecryptor
  assemble: typeof assembleSegments
  makeFfmpeg: () => FfmpegService
  mkdtemp?: () => Promise<string>
  mintTaskId?: () => string
  /** Injectable clock (ms) for the download-speed sampler; tests drive it. */
  now?: () => number
  /**
   * Collision-safe name picker (same FinalNamePicker the HTTP path uses).
   * start() re-picks through this when the `.motrix` placeholder it tries to
   * reserve already exists — the atomic wx create is the authoritative dedup,
   * because pickName ran seconds earlier (network round-trips sit between the
   * pipelines' pick and this start) and can be stale by now.
   */
  pickName: (dir: string, desired: string) => Promise<string>
  /**
   * Durable-save hook. The pre-rename Finalizing/Renaming intent is a hard
   * recovery barrier: if it cannot be persisted, the final rename must not
   * happen. Writes after terminal Completed/Error remain best-effort because
   * the usable output or original pipeline error already exists by then.
   */
  persist: (task: DownloadTask) => Promise<void>
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction — used INSTEAD OF `persist` whenever a status
   * transition qualifies for one (see `buildTerminalOccurrence`). Optional;
   * absence degrades to plain `persist`.
   */
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  /** Delivers a just-committed terminal occurrence to in-process consumers.
   *  Narrowed to `dispatch` so tests can supply a plain `{ dispatch }`
   *  double. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  parentTaskCreated?: (
    task: DownloadTask,
    persistParent: () => void | Promise<void>
  ) => Promise<void>
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  monotonicNow?: () => number
}

// ---------------------------------------------------------------------------
// Internal per-task state tracked for cancel
// ---------------------------------------------------------------------------

interface RunState {
  downloaders: SegmentDownloader[]
  ffmpeg: FfmpegService | null
  tmpDir: string
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// MediaTaskCoordinator
// ---------------------------------------------------------------------------

/**
 * Coalesce pure byte-progress emits to at most one per this window. A media
 * download polls each segment ~every 700ms (video + audio concurrently), so
 * un-throttled it would fan the full task list to every consumer several times
 * a second. Status changes bypass this entirely (see updateTask).
 */
const EMIT_THROTTLE_MS = 250

export class MediaTaskCoordinator {
  private readonly running = new Map<string, RunState>()
  private readonly backgroundRuns = new Set<Promise<unknown>>()
  private readonly now: () => number
  private acceptingSubmissions = true
  private drainPromise: Promise<void> | null = null
  /** Wall-clock (ms) of the last emitted TaskUpdated, for progress throttling. */
  private lastEmitAt = 0

  constructor(private readonly deps: MediaCoordinatorDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Register a media task durably, start its long-running transfer in the
   * coordinator-owned background, and acknowledge once cancellation ownership
   * has been installed. Transport/request lifetimes must use this method so an
   * hours-long download is never part of an IPC/MDXP shutdown drain.
   */
  async submit(job: MediaJob): Promise<{ taskId: string }> {
    if (!this.acceptingSubmissions) {
      throw new Error('MediaTaskCoordinator is stopped')
    }

    const taskId = job.taskId ?? this.deps.mintTaskId?.() ?? crypto.randomUUID()
    let accepted = false
    let resolveAccepted!: () => void
    let rejectAccepted!: (error: unknown) => void
    const acceptedPromise = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    })
    const run = this.run(job, taskId, () => {
      accepted = true
      resolveAccepted()
    })
    this.backgroundRuns.add(run)
    void run
      .catch((err) => {
        if (!accepted) {
          rejectAccepted(err)
          return
        }
        log.warn(
          {
            taskId,
            err: err instanceof Error ? err.message : String(err),
          },
          'detached media task ended with an error'
        )
      })
      .finally(() => {
        this.backgroundRuns.delete(run)
      })

    await acceptedPromise
    return { taskId }
  }

  /**
   * Test/recovery primitive that retains the historical run-to-completion
   * contract. Production bridge and desktop submit paths use submit().
   */
  async start(job: MediaJob): Promise<{ taskId: string }> {
    const taskId = job.taskId ?? this.deps.mintTaskId?.() ?? crypto.randomUUID()
    return this.run(job, taskId)
  }

  private async run(
    job: MediaJob,
    taskId: string,
    onAccepted?: () => void
  ): Promise<{ taskId: string }> {
    const now = Date.now()

    // Reserve the final name by creating the `.motrix` placeholder in saveDir —
    // the same slot the HTTP path reserves via aria2's `out=<name>.motrix`.
    // FinalNamePicker treats both `<name>` and `<name>.motrix` as taken, so a
    // concurrent submit of the same title dedups to `<name> (1)` instead of
    // silently sharing one finalPath. The wx flag makes check-and-create one
    // atomic syscall; on EEXIST (someone won the slot between the pipeline's
    // pickName and here) we re-pick and try again. Runs BEFORE makeTask so a
    // reservation failure rejects the submit without leaving a ghost task.
    await fs.promises.mkdir(job.saveDir, { recursive: true })
    let finalName = job.finalName
    let finalPath = path.join(job.saveDir, finalName)
    let diskPath = toTempPath(finalPath)
    const MAX_RESERVE_ATTEMPTS = 10
    for (let attempt = 0; ; attempt++) {
      let claimed = false
      try {
        await fs.promises.writeFile(diskPath, '', { flag: 'wx' })
        claimed = true
        // Claiming the placeholder is not enough: a sibling that picked the
        // same name can have COMPLETED (its placeholder renamed onto the final
        // name) during our pick→reserve window, leaving the placeholder path
        // free while the final name is taken — muxing on would silently
        // overwrite its finished file. rename(2) is atomic, so a sibling is
        // always visible as either its placeholder (the wx above fails) or its
        // final file (this check): there is no in-between state to miss.
        if (!(await pathExists(finalPath))) break
        await fs.promises.unlink(diskPath).catch(() => {})
      } catch (err) {
        if (claimed) throw err
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw err
      }
      if (attempt >= MAX_RESERVE_ATTEMPTS) {
        throw new Error(
          `media name reservation exhausted for "${job.finalName}" in ${job.saveDir}`
        )
      }
      finalName = await this.deps.pickName(job.saveDir, finalName)
      finalPath = path.join(job.saveDir, finalName)
      diskPath = toTempPath(finalPath)
    }
    if (finalName !== job.finalName) {
      log.info(
        { taskId, requested: job.finalName, reserved: finalName },
        'media final name re-picked at reservation (placeholder existed)'
      )
    }

    // Build logical instances (gid: null — NOT added to engineIndex). Instance
    // diskPath is the placeholder path while in flight: SessionManager rebuilds
    // the task-level diskPath from the primary instance on restore, so an
    // interrupted media task points at the placeholder, not the final name.
    const instances: TaskInstance[] = []
    instances.push(
      makeInstance(
        `seg:${taskId}`,
        taskId,
        TaskInstancePhase.HlsSegment,
        diskPath,
        now
      )
    )
    if (job.audio) {
      instances.push(
        makeInstance(
          `aud:${taskId}`,
          taskId,
          TaskInstancePhase.HlsAudio,
          diskPath,
          now
        )
      )
    }
    instances.push(
      makeInstance(
        `mux:${taskId}`,
        taskId,
        TaskInstancePhase.FfmpegMux,
        diskPath,
        now
      )
    )

    const task = this.makeTask(
      taskId,
      job,
      finalName,
      finalPath,
      diskPath,
      instances,
      now
    )
    if (this.deps.parentTaskCreated) {
      await this.deps.parentTaskCreated(task, () => this.deps.persist(task))
    }
    this.deps.taskManager.add(task)
    this.deps.activityRecorder.recordSubmitted({
      taskId: task.id,
      occurredAt: task.createdAt,
    })
    this.emitUpdate(true)

    // Create temp dir
    const mkdtemp = this.deps.mkdtemp ?? defaultMkdtemp
    const tmpDir = await mkdtemp()

    // Per-stream subdirs so segment filenames (000000.seg…) never collide.
    const videoDir = path.join(tmpDir, 'video')
    const audioDir = path.join(tmpDir, 'audio')
    await fs.promises.mkdir(videoDir, { recursive: true })

    // Register run state for cancel support
    const state: RunState = {
      downloaders: [],
      ffmpeg: null,
      tmpDir,
      cancelled: false,
    }
    this.running.set(taskId, state)
    onAccepted?.()

    // A shutdown can race a submit while the latter is crossing its durable
    // registration barrier. Once cancellation ownership exists, honor the
    // already-closed gate before starting any segment transfer.
    if (!this.acceptingSubmissions) {
      await this.cancel(taskId)
      throw new Error('MediaTaskCoordinator stopped during submit')
    }

    // When a genuine (non-cancel) failure preserves the temp inputs for
    // inspection, this flips true and the finally block skips cleanDir.
    let keepTmp = false

    try {
      // -----------------------------------------------------------------------
      // Phase: downloading
      // -----------------------------------------------------------------------
      // Same recordTransition fork as transition(), EXCEPT the unwired arm
      // must stay fully synchronous here: cancellation ownership was just
      // installed (running.set + the gate re-check above), and the stretch
      // from there to downloader registration must not yield to the event
      // loop — a stopAndDrain racing this submit would otherwise cancel an
      // empty downloader list and the segment run would start uncancellable.
      const toDownloading = (t: DownloadTask): void => {
        t.status = TaskStatus.Downloading
        setInstanceStatus(
          t.instances,
          TaskInstancePhase.HlsSegment,
          TaskStatus.Downloading
        )
      }
      if (this.deps.recordTransition) {
        await this.commitTaskTransition(taskId, toDownloading)
      } else {
        this.updateTask(taskId, toDownloading)
      }

      // Total segment count across video + audio — the fallback for aggregate
      // progress when byte counts are not yet known (e.g. before the first
      // poll, or if aria2 reports no lengths).
      const videoTotal = (job.video.init ? 1 : 0) + job.video.segments.length
      const audioTotal = job.audio
        ? (job.audio.init ? 1 : 0) + job.audio.segments.length
        : 0
      const grandTotal = videoTotal + audioTotal

      // Live per-stream state, updated by each downloader's progress callback.
      // The two streams download CONCURRENTLY (see below), so both totals are
      // known once each stream has been polled once — the task's totalBytes is
      // correct up front and the bar climbs smoothly end-to-end, instead of the
      // total growing (and progress jumping back) when audio starts under a
      // sequential model. `completed` is the per-stream segment count feeding
      // the fraction fallback; `downloaded`/`total` are bytes.
      const videoBytes = { downloaded: 0, total: 0, completed: 0 }
      const audioBytes = { downloaded: 0, total: 0, completed: 0 }

      // Download-speed sampler: bytes/s from the downloaded delta over a ≥0.5s
      // window (the two stream callbacks interleave, so a coarse window avoids
      // noise). Uses the constructor-resolved clock so tests are deterministic.
      const clock = this.now
      let speedSampleTime = clock()
      let speedSampleBytes = 0

      // Derive real byte progress; fall back to the segment-count fraction only
      // while totalBytes is still 0 (never NaN, never a shrinking total). Also
      // populate the aria2-task display fields the UI reads — sizeWhenDone (the
      // list "size" column + detail "Total size"), connections, downloadSpeed,
      // etaSeconds — which a coordinator task would otherwise leave at 0.
      const applyBytes = (t: DownloadTask) => {
        const downloadedBytes = videoBytes.downloaded + audioBytes.downloaded
        const totalBytes = videoBytes.total + audioBytes.total
        const overallFrac =
          grandTotal > 0
            ? (videoBytes.completed + audioBytes.completed) / grandTotal
            : 0
        const connections = state.downloaders.reduce(
          (n, d) => n + d.getActiveGidCount(),
          0
        )
        t.downloadedBytes = downloadedBytes
        t.totalBytes = totalBytes
        t.sizeWhenDone = totalBytes
        t.progress = totalBytes > 0 ? downloadedBytes / totalBytes : overallFrac
        t.connections = connections

        if (connections === 0) {
          // Nothing in flight (mux/finalize phase, or between phases): not
          // actively downloading, so speed/eta are 0 (a completed task too).
          t.downloadSpeed = 0
          t.etaSeconds = 0
          return
        }
        const nowMs = clock()
        const dt = (nowMs - speedSampleTime) / 1000
        if (dt >= 0.5) {
          const delta = downloadedBytes - speedSampleBytes
          t.downloadSpeed = delta > 0 ? Math.round(delta / dt) : 0
          speedSampleTime = nowMs
          speedSampleBytes = downloadedBytes
        }
        t.etaSeconds =
          t.downloadSpeed > 0
            ? Math.round((totalBytes - downloadedBytes) / t.downloadSpeed)
            : 0
      }

      // One progress callback per stream — identical except which stream's
      // state it writes and which instance phase it advances.
      const onStreamProgress =
        (
          streamBytes: { downloaded: number; total: number; completed: number },
          phase: TaskInstancePhase,
          segTotal: number
        ) =>
        (p: SegmentProgress) => {
          streamBytes.downloaded = p.downloadedBytes
          streamBytes.total = p.totalBytes
          streamBytes.completed = Math.round(p.fraction * segTotal)
          this.updateTask(taskId, (t) => {
            setInstanceProgress(t.instances, phase, p.fraction)
            applyBytes(t)
          })
        }

      // Create both downloaders up front so state.downloaders holds both (for
      // cancel + pause/resume gid lookup) and both can run concurrently.
      const videoDownloader = this.deps.makeDownloader(videoDir)
      state.downloaders.push(videoDownloader)

      const audioPlan = job.audio
      let audioDownloader: SegmentDownloader | null = null
      if (audioPlan) {
        await fs.promises.mkdir(audioDir, { recursive: true })
        audioDownloader = this.deps.makeDownloader(audioDir)
        state.downloaders.push(audioDownloader)
      }

      // Without an audio plan no HlsAudio instance was ever created, so
      // there is nothing to mark.
      if (audioPlan) {
        this.updateTask(taskId, (t) => {
          setInstanceStatus(
            t.instances,
            TaskInstancePhase.HlsAudio,
            TaskStatus.Downloading
          )
        })
      }

      const runVideo = videoDownloader.run(
        job.video,
        job.headers,
        onStreamProgress(videoBytes, TaskInstancePhase.HlsSegment, videoTotal)
      )

      const runAudio: Promise<{
        initPath?: string
        partPaths: string[]
      } | null> =
        audioDownloader && audioPlan
          ? audioDownloader.run(
              audioPlan,
              job.headers,
              onStreamProgress(
                audioBytes,
                TaskInstancePhase.HlsAudio,
                audioTotal
              )
            )
          : Promise.resolve(null)

      // Concurrent download; decrypt/assemble below already run only after both
      // streams finish, so awaiting both together is safe.
      const [videoResult, audioResult] = await Promise.all([runVideo, runAudio])

      // -----------------------------------------------------------------------
      // Phase: decrypt
      // -----------------------------------------------------------------------
      await decryptPlan(job.video, videoResult, this.deps.decryptor)
      if (job.audio && audioResult) {
        await decryptPlan(job.audio, audioResult, this.deps.decryptor)
      }

      // -----------------------------------------------------------------------
      // Phase: assemble
      // -----------------------------------------------------------------------
      // Only true MPEG-TS gets a .ts intermediate; 'fmp4' AND 'single'
      // (bilibili/DASH fragmented-MP4) are MP4-family — use .mp4 so the
      // extension matches the content (ffmpeg also probes, but the hint should
      // not lie).
      const ext = job.video.container === 'mpegts' ? 'ts' : 'mp4'
      const videoAssembled = path.join(tmpDir, `video.${ext}`)
      await this.deps.assemble({
        outPath: videoAssembled,
        initPath: videoResult.initPath,
        partPaths: videoResult.partPaths,
      })

      let audioAssembled: string | undefined
      if (job.audio && audioResult) {
        const audioExt = job.audio.container === 'mpegts' ? 'ts' : 'mp4'
        audioAssembled = path.join(tmpDir, `audio.${audioExt}`)
        await this.deps.assemble({
          outPath: audioAssembled,
          initPath: audioResult.initPath,
          partPaths: audioResult.partPaths,
        })
      }

      // -----------------------------------------------------------------------
      // Phase: muxing
      // -----------------------------------------------------------------------
      this.updateTask(taskId, (t) => {
        t.progress = 0
        t.status = TaskStatus.Downloading // keep as Downloading until mux done
        setInstanceStatus(
          t.instances,
          TaskInstancePhase.FfmpegMux,
          TaskStatus.Downloading
        )
      })

      // saveDir was already created at reservation time; re-ensure it here in
      // case the user deleted it during a long download — ffmpeg does NOT
      // create its output's parent dir and would ENOENT after a full download.
      await fs.promises.mkdir(job.saveDir, { recursive: true })

      // DIAGNOSTIC: inspect the assembled inputs right before mux. ffmpeg
      // exit 234 (EINVAL) means a mapped stream type is absent from an input;
      // a tiny "text/html?" sig is a 403/error body aria2 saved as complete.
      // Logging size + signature makes a failed mux self-diagnosing.
      const videoProbe = await probeInput(videoAssembled)
      const audioProbe = audioAssembled
        ? await probeInput(audioAssembled)
        : null
      log.info(
        { taskId, video: videoProbe, audio: audioProbe },
        'mux inputs before ffmpeg'
      )

      const ffmpeg = this.deps.makeFfmpeg()
      state.ffmpeg = ffmpeg

      const ffmpegBinaryPath = await this.deps.resolveFfmpegBinaryPath()
      if (!ffmpegBinaryPath) {
        throw new Error('mux-failed: ffmpeg executable is unavailable')
      }

      await ffmpeg.run(
        {
          binaryPath: ffmpegBinaryPath,
          videoPath: videoAssembled,
          audioPath: audioAssembled,
          // Mux INTO the placeholder — the final name only appears on disk
          // once the file is complete (rename below). ffmpeg cannot infer a
          // muxer from the `.motrix` extension, so pass it explicitly, derived
          // from the extension of the FINAL name.
          output: diskPath,
          format: muxerForOutputName(finalName),
          fromMpegts: job.video.container === 'mpegts',
          durationSec: job.durationSec,
        },
        (p) => {
          this.updateTask(taskId, (t) => {
            t.progress = p.progress
            setInstanceProgress(
              t.instances,
              TaskInstancePhase.FfmpegMux,
              p.progress
            )
          })
        }
      )

      state.ffmpeg = null

      // -----------------------------------------------------------------------
      // Phase: finalizing → Completed
      // -----------------------------------------------------------------------
      await this.transition(
        taskId,
        (t) => {
          t.progress = 1
          Object.assign(t, applyTerminalTransition(t, TaskStatus.Finalizing))
          setTaskTransitionPhase(t, TransitionPhase.Renaming)
        },
        {},
        () => this.persistFinalizationIntent(taskId)
      )

      // Same-dir rename `.motrix` → final (atomic; mirrors finalizeHttp). Must
      // land BEFORE the Completed flip: the bridge emits $/task/completed with
      // finalPath off that status change and the extension may open it at once.
      await fs.promises.rename(diskPath, finalPath)
      const completedAt = this.now()

      await this.transition(
        taskId,
        (t) => {
          t.progress = 1
          completeTaskAfterRename(
            t,
            finalPath,
            completedAt,
            this.deps.activityRecorder
          )
        },
        { bestEffort: true, context: 'completion', occurredAt: completedAt },
        () => this.persistBestEffort(taskId, 'completion')
      )
    } catch (err) {
      // If cancel() already set mux-aborted, don't overwrite
      if (
        this.running.has(taskId) &&
        !state.cancelled &&
        !(err instanceof MediaPersistenceBarrierError)
      ) {
        await this.transition(
          taskId,
          (t) => {
            applyTerminalStatusToTask(t, TaskStatus.Error, {
              errorMessage: mapError(err as Error),
              errorDetailKey: 'task.error.detail.muxFailed',
              errorDetailParams: null,
            })
          },
          { bestEffort: true, context: 'failure' },
          () => this.persistBestEffort(taskId, 'failure')
        )
      }
      // DIAGNOSTIC: on a genuine failure (not a user cancel) log the RAW error
      // — for a mux failure this carries the ffmpeg stderr tail (which input
      // was invalid) — and preserve tmpDir so the bad inputs can be inspected
      // (ffprobe video.* / audio.*). The next *successful* run still cleans up.
      if (!state.cancelled) {
        log.warn(
          { taskId, tmpDir, err: (err as Error).message },
          'media task failed; preserving tmpDir for inspection'
        )
        keepTmp = true
      }
      throw err
    } finally {
      if (!keepTmp) {
        await cleanDir(tmpDir).catch(() => {})
      }
      this.running.delete(taskId)
    }

    return { taskId }
  }

  /**
   * Close the submit gate synchronously, cancel every coordinator-owned media
   * process, and wait only for those background runs to settle. Idempotent.
   */
  stopAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    this.acceptingSubmissions = false
    this.drainPromise = this.cancelAndDrain()
    return this.drainPromise
  }

  private async cancelAndDrain(): Promise<void> {
    await Promise.allSettled(
      [...this.running.keys()].map((taskId) => this.cancel(taskId))
    )
    while (this.backgroundRuns.size > 0) {
      await Promise.allSettled([...this.backgroundRuns])
    }
  }

  async cancel(taskId: string): Promise<void> {
    const state = this.running.get(taskId)
    if (!state) return
    state.cancelled = true

    // Cancel all active downloaders
    await Promise.allSettled(state.downloaders.map((d) => d.cancel()))

    // Kill ffmpeg if running
    state.ffmpeg?.kill()
    state.ffmpeg = null

    this.running.delete(taskId)

    await this.transition(
      taskId,
      (t) => {
        applyTerminalStatusToTask(t, TaskStatus.Error, {
          errorMessage: 'mux-aborted',
        })
      },
      { bestEffort: true, context: 'cancellation' },
      () => this.persistBestEffort(taskId, 'cancellation')
    )

    await cleanDir(state.tmpDir).catch(() => {})
  }

  /**
   * The live aria2 segment gids for a coordinator-managed task, gathered from
   * its in-flight downloaders. These ARE real aria2 gids (unlike the task's
   * empty engineTaskId), so pause/resume can act on them. Returns [] for an
   * unknown task or one past the download phase (mux/finalize).
   */
  getActiveSegmentGids(taskId: string): string[] {
    const state = this.running.get(taskId)
    if (!state) return []
    return state.downloaders.flatMap((d) => d.getActiveGids())
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private updateTask(taskId: string, mut: (t: DownloadTask) => void): void {
    const task = this.deps.taskManager.getById(taskId)
    if (!task) return
    const prevStatus = task.status
    mut(task)
    task.updatedAt = Date.now()
    this.deps.taskManager.set(taskId, task)
    // Force an emit on ANY status change — phase transitions and especially the
    // terminal Completed/Error must never be dropped by the throttle (bridge
    // consumers derive terminal notifications from the status in the payload).
    // Pure byte-progress updates are throttled.
    this.emitUpdate(task.status !== prevStatus)
  }

  private async persistBestEffort(
    taskId: string,
    context: 'completion' | 'failure' | 'cancellation'
  ): Promise<void> {
    const task = this.deps.taskManager.getById(taskId)
    if (!task) return

    // try/catch (not .catch) also contains a convention-violating synchronous
    // throw from the hook.
    try {
      await this.deps.persist(task)
    } catch (err) {
      log.warn(
        {
          taskId,
          context,
          err: err instanceof Error ? err.message : String(err),
        },
        'persist after media terminal transition failed (state is in-memory only until the next save)'
      )
    }
  }

  private async persistFinalizationIntent(taskId: string): Promise<void> {
    const task = this.deps.taskManager.getById(taskId)
    if (!task) {
      throw new Error(
        `Cannot persist media finalization intent: task ${taskId} is missing`
      )
    }
    await this.deps.persist(task)
  }

  /**
   * The single transition entry point owning the recordTransition fork.
   * With the Activity hook wired (always true in production —
   * `bootstrapBridge` wires it), the mutation commits through the
   * occurrence-aware `commitTaskTransition`. Without it, this falls back to
   * the legacy publish-then-best-effort-persist path, which never builds a
   * terminal occurrence — a test or caller that omits `recordTransition`
   * silently loses occurrences for this task.
   */
  private async transition(
    taskId: string,
    mutate: (task: DownloadTask) => void,
    options: {
      bestEffort?: boolean
      context?: 'completion' | 'failure' | 'cancellation'
      occurredAt?: number
    } = {},
    fallbackPersist?: () => Promise<void>
  ): Promise<boolean> {
    if (this.deps.recordTransition) {
      return this.commitTaskTransition(taskId, mutate, options)
    }
    this.updateTask(taskId, mutate)
    await fallbackPersist?.()
    return true
  }

  private async commitTaskTransition(
    taskId: string,
    mutate: (task: DownloadTask) => void,
    options: {
      bestEffort?: boolean
      context?: 'completion' | 'failure' | 'cancellation'
      occurredAt?: number
    } = {}
  ): Promise<boolean> {
    const commit = () =>
      this.commitTaskTransitionSerialized(taskId, mutate, options)
    return this.deps.runTaskMutation
      ? this.deps.runTaskMutation([taskId], commit)
      : commit()
  }

  private async commitTaskTransitionSerialized(
    taskId: string,
    mutate: (task: DownloadTask) => void,
    options: {
      bestEffort?: boolean
      context?: 'completion' | 'failure' | 'cancellation'
      occurredAt?: number
    }
  ): Promise<boolean> {
    const previous = this.deps.taskManager.getById(taskId)
    if (!previous) return false
    const next = structuredClone(previous)
    mutate(next)
    next.updatedAt = Date.now()

    // 'cancellation' is the only context the user-initiated abort path
    // (cancel()) ever passes; every other terminal transition this
    // coordinator commits (completion, failure) is the media pipeline
    // itself reaching a terminal state.
    const cause = options.context === 'cancellation' ? 'user-cancel' : 'media'
    const occurrence = buildTerminalOccurrence(
      terminalSnapshotFromTask(next),
      previous.status,
      cause
    )

    try {
      await persistWithOccurrenceOrWarn(
        { persistTaskWithOccurrence: this.deps.persistTaskWithOccurrence, log },
        next,
        occurrence,
        'commitTaskTransitionSerialized',
        (t) => this.deps.persist(t)
      )
    } catch (err) {
      if (!options.bestEffort) {
        throw new MediaPersistenceBarrierError(err)
      }
      log.warn(
        {
          taskId,
          context: options.context,
          err: err instanceof Error ? err.message : String(err),
        },
        'persist after media terminal transition failed; unpublished state will be recovered'
      )
      return false
    }

    this.deps.taskManager.set(taskId, next)
    try {
      await this.deps.recordTransition?.({
        taskId,
        previousStatus: previous.status,
        nextStatus: next.status,
        occurredAt: options.occurredAt ?? this.now(),
        monotonicAt: this.deps.monotonicNow?.() ?? performance.now(),
        accuracy: 'exact',
        errorCode: next.errorCode,
        errorMessage: next.errorMessage,
        errorDetailKey: next.errorDetailKey,
        errorDetailParams: next.errorDetailParams,
        occurrenceId: occurrence?.occurrenceId ?? null,
      })
    } catch (err) {
      log.error({ err, taskId }, 'media Activity transition recording failed')
    }
    this.emitUpdate(true)
    if (occurrence) {
      await this.deps.occurrenceDispatcher?.dispatch(occurrence)
    }
    return true
  }

  private emitUpdate(force = false): void {
    const now = this.now()
    if (!force && now - this.lastEmitAt < EMIT_THROTTLE_MS) return
    this.lastEmitAt = now
    if (force) {
      this.deps.publishTaskUpdateNow()
    } else {
      this.deps.publishTaskUpdate()
    }
  }

  private makeTask(
    taskId: string,
    job: MediaJob,
    finalName: string,
    finalPath: string,
    diskPath: string,
    instances: TaskInstance[],
    now: number
  ): DownloadTask {
    return makeDownloadTask({
      id: taskId,
      name: finalName,
      kind: job.kind === 'mux' ? TaskKind.Mux : TaskKind.Hls,
      type: TaskType.Http,
      saveDir: job.saveDir,
      createdAt: now,
      updatedAt: now,
      uris: instances.flatMap((i) => i.uris),
      // A media task produces exactly one muxed output file.
      fileCount: 1,
      filename: finalName,
      diskPath,
      finalPath,
      finalName,
      source: 'bridge',
      sourceMeta: job.sourceMeta,
      instances,
    })
  }
}

class MediaPersistenceBarrierError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'MediaPersistenceBarrierError'
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function makeInstance(
  instanceId: string,
  motrixId: string,
  phase: TaskInstancePhase,
  diskPath: string,
  now: number
): TaskInstance {
  return {
    instanceId,
    motrixId,
    gid: null,
    phase,
    status: TaskStatus.Queued,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath,
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: now,
    updatedAt: now,
  }
}

function setInstanceStatus(
  instances: TaskInstance[],
  phase: TaskInstancePhase,
  status: TaskStatus
): void {
  const inst = instances.find((i) => i.phase === phase)
  if (inst) inst.status = status
}

function setInstanceProgress(
  instances: TaskInstance[],
  phase: TaskInstancePhase,
  progress: number
): void {
  const inst = instances.find((i) => i.phase === phase)
  if (inst) inst.progress = progress
}

function mapError(err: Error): string {
  if (err.message.startsWith('mux-aborted')) return 'mux-aborted'
  if (err.message.startsWith('mux-failed')) return 'mux-failed'
  return err.message
}

async function decryptPlan(
  plan: SegmentPlan,
  result: { initPath?: string; partPaths: string[] },
  decryptor: SegmentDecryptor
): Promise<void> {
  // Decrypt init segment if it has a key
  if (plan.init?.key && result.initPath) {
    const key = await decryptor.getKey(plan.init.key.uri)
    const ct = await fs.promises.readFile(result.initPath)
    const pt = decryptor.decrypt(new Uint8Array(ct), key, plan.init.key.iv)
    await fs.promises.writeFile(result.initPath, pt)
  }

  // Decrypt segments in bounded-concurrency chunks: each iteration touches
  // only its own file (getKey caches per URI), and every write lands inside
  // tmpDir, which the caller removes — or preserves — wholesale, so a
  // failure mid-chunk leaks nothing observable. Serial decryption of an
  // 800-segment stream would otherwise be 1,600 file operations at queue
  // depth 1.
  const DECRYPT_CONCURRENCY = 8
  for (let i = 0; i < plan.segments.length; i += DECRYPT_CONCURRENCY) {
    await Promise.all(
      plan.segments
        .slice(i, i + DECRYPT_CONCURRENCY)
        .map(async (seg, offset) => {
          const partPath = result.partPaths[i + offset]
          if (!seg.key || !partPath) return
          const key = await decryptor.getKey(seg.key.uri)
          const ct = await fs.promises.readFile(partPath)
          const pt = decryptor.decrypt(new Uint8Array(ct), key, seg.key.iv)
          await fs.promises.writeFile(partPath, pt)
        })
    )
  }
}

async function defaultMkdtemp(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'motrix-media-'))
}

async function cleanDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true })
}

/** Best-effort: size + first-bytes signature of an assembled media input,
 *  purely for diagnostics — never throws. A valid MP4/fMP4 begins with a box
 *  size word then 'ftyp'/'moov'/'styp' at offset 4; MPEG-TS begins with 0x47.
 *  A small size with a printable-ASCII head is the 403/HTML error-body
 *  fingerprint (the usual cause of a cryptic ffmpeg EINVAL/234). */
async function probeInput(
  filePath: string
): Promise<{ path: string; size: number; head: string; sig: string }> {
  try {
    const st = await fs.promises.stat(filePath)
    const fh = await fs.promises.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(16)
      const { bytesRead } = await fh.read(buf, 0, 16, 0)
      const slice = buf.subarray(0, bytesRead)
      const tag = slice.subarray(4, 8).toString('latin1')
      const sig =
        slice[0] === 0x47
          ? 'mpegts'
          : tag === 'ftyp' || tag === 'moov' || tag === 'styp'
            ? `mp4(${tag})`
            : /^[\t\n\r\x20-\x7e]+$/.test(slice.toString('latin1'))
              ? 'text/html?'
              : 'unknown'
      return { path: filePath, size: st.size, head: slice.toString('hex'), sig }
    } finally {
      await fh.close()
    }
  } catch (err) {
    return {
      path: filePath,
      size: -1,
      head: '',
      sig: `stat-failed:${(err as Error).message}`,
    }
  }
}
