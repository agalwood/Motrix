import path from 'node:path'
import type {
  InitSegment,
  MediaPart,
  SegmentPlan,
} from '@core/media/segment-plan'

// ---------------------------------------------------------------------------
// Public interface — narrow aria2 client (injected by T15 adapter)
// ---------------------------------------------------------------------------

export interface SegmentAria2 {
  /** Returns the aria2 gid for the queued download. One URL per call; multiple URLs = mirrors. */
  addUri(
    uris: string[],
    opts: {
      dir: string
      out: string
      header?: string[]
      'max-tries'?: number
      'retry-wait'?: number
    }
  ): Promise<string>
  forceRemove(gid: string): Promise<void>
  /**
   * Register a single callback to receive completion notifications.
   * Important: onComplete and onError register a SINGLE callback each.
   * A fresh SegmentAria2 instance (or a fan-out adapter) MUST be used per
   * SegmentDownloader instance — sharing one across concurrent runs will
   * overwrite the callbacks. The adapter wiring (bootstrap) is responsible
   * for fan-out and filtering by gid.
   */
  /**
   * In-progress byte counts for a single segment gid, or null when the gid is
   * unknown / the query failed. Used by the poll loop to derive real byte
   * progress from aria2's own view of each segment.
   */
  tellStatus(
    gid: string
  ): Promise<{ completedLength: number; totalLength: number } | null>
  onComplete(cb: (gid: string) => void): void
  /**
   * Register a single callback to receive error notifications.
   * Important: onComplete and onError register a SINGLE callback each.
   * A fresh SegmentAria2 instance (or a fan-out adapter) MUST be used per
   * SegmentDownloader instance — sharing one across concurrent runs will
   * overwrite the callbacks. The adapter wiring (bootstrap) is responsible
   * for fan-out and filtering by gid.
   */
  onError(cb: (gid: string) => void): void
}

/** Byte-accurate progress emitted by {@link SegmentDownloader.run}. */
export interface SegmentProgress {
  /** Segment-count fraction (completed jobs / total jobs), 0..1. */
  fraction: number
  /**
   * Summed `completedLength` of finished + in-flight segments, in bytes.
   * Finished segments count their full size; in-flight ones count aria2's
   * live `completedLength` from the most recent poll.
   */
  downloadedBytes: number
  /** Summed `totalLength` of finished + in-flight segments, in bytes. */
  totalBytes: number
}

/**
 * Injectable timer seam for the byte-polling loop. Returns a stop function.
 * Production uses `setInterval`; tests inject a manual scheduler to drive
 * polls deterministically without real (or fake) timers.
 */
export type PollScheduler = (cb: () => void | Promise<void>) => () => void

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Job {
  /** Flat sequential index in the job list (0 = init if present, then segments). */
  jobIndex: number
  /** Part type: 'init' | 'segment' */
  kind: 'init' | 'segment'
  /** Original MediaPart or InitSegment. */
  part: InitSegment | MediaPart
  /** Absolute output path inside tmpDir. */
  outPath: string
  /** How many re-add attempts remain after the first failure. */
  retriesLeft: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TRIES = 5
const RETRY_WAIT = 3
/** How many times we re-submit a failed segment ourselves (on top of aria2's MAX_TRIES). */
const MAX_SELF_RETRIES = 3
const PAD = 6 // e.g. "000042.seg"
/** Byte-progress poll cadence — one tellStatus RPC per active gid per tick. */
const DEFAULT_POLL_INTERVAL_MS = 700

/** Default scheduler: a real setInterval, cleared via the returned stop fn. */
const realPollScheduler: PollScheduler = (cb) => {
  const handle = setInterval(() => {
    void cb()
  }, DEFAULT_POLL_INTERVAL_MS)
  return () => clearInterval(handle)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padIndex(n: number): string {
  return `${String(n).padStart(PAD, '0')}.seg`
}

function buildHeaders(
  part: InitSegment | MediaPart,
  requestHeaders: Record<string, string>
): string[] {
  const headers: string[] = []
  // Replay caller-provided headers (Referer, Cookie, etc.)
  for (const [name, value] of Object.entries(requestHeaders)) {
    headers.push(`${name}: ${value}`)
  }
  // Range header for byte-range parts
  if (part.byteRange) {
    const { offset, length } = part.byteRange
    headers.push(`Range: bytes=${offset}-${offset + length - 1}`)
  }
  return headers
}

// ---------------------------------------------------------------------------
// SegmentDownloader
// ---------------------------------------------------------------------------

export class SegmentDownloader {
  private readonly aria2: SegmentAria2
  private readonly tmpDir: string
  private readonly concurrency: number

  /** Maps a live gid → its Job record. */
  private readonly activeJobs = new Map<string, Job>()
  /** Set of all gids currently in-flight (submitted but not yet complete/error). */
  private readonly activeGids = new Set<string>()

  private rejectRun: ((err: Error) => void) | null = null
  /** Flag to guard against cancel-during-retry race: set when cancel() is called. */
  private cancelled = false

  private readonly pollScheduler: PollScheduler
  /** Stops the active byte-poll loop; null when no run is in flight. */
  private stopPoll: (() => void) | null = null

  constructor(deps: {
    aria2: SegmentAria2
    tmpDir: string
    concurrency?: number
    pollScheduler?: PollScheduler
  }) {
    this.aria2 = deps.aria2
    this.tmpDir = deps.tmpDir
    this.concurrency = deps.concurrency ?? 16
    this.pollScheduler = deps.pollScheduler ?? realPollScheduler
  }

  /** The live aria2 gids of segments currently in flight for this stream. */
  getActiveGids(): string[] {
    return [...this.activeGids]
  }

  /** Count of in-flight segment gids (allocation-free — for progress polling). */
  getActiveGidCount(): number {
    return this.activeGids.size
  }

  /** Stop the byte-poll loop; idempotent, safe on every exit path. */
  private stopPolling(): void {
    if (this.stopPoll) {
      this.stopPoll()
      this.stopPoll = null
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  run(
    plan: SegmentPlan,
    headers: Record<string, string>,
    onProgress: (p: SegmentProgress) => void
  ): Promise<{ initPath?: string; partPaths: string[] }> {
    this.activeJobs.clear()
    this.activeGids.clear()

    // Build a flat ordered job list: [init?, seg0, seg1, ...]
    const jobs: Job[] = []
    let jobIndex = 0

    if (plan.init) {
      jobs.push({
        jobIndex,
        kind: 'init',
        part: plan.init,
        outPath: path.join(this.tmpDir, padIndex(jobIndex)),
        retriesLeft: MAX_SELF_RETRIES,
      })
      jobIndex++
    }

    for (const seg of plan.segments) {
      jobs.push({
        jobIndex,
        kind: 'segment',
        part: seg,
        outPath: path.join(this.tmpDir, padIndex(jobIndex)),
        retriesLeft: MAX_SELF_RETRIES,
      })
      jobIndex++
    }

    const total = jobs.length
    let completed = 0

    // ── Byte accounting ──────────────────────────────────────────────────
    // `finished*` accumulates the final size of completed segments (a completed
    // segment is 100% downloaded). Live in-flight bytes are recomputed on every
    // report from `lastSeen` (the most recent tellStatus per active gid) summed
    // over the CURRENT active gids — so a segment leaving the set never causes a
    // double-count, and a poll that transiently returns null keeps the prior
    // value instead of dropping bytes.
    const lastSeen = new Map<string, { completed: number; total: number }>()
    // A completed segment counts its full size toward BOTH downloaded and total
    // (completed === total once done), so ONE accumulator serves both. Live
    // in-flight bytes are recomputed on every report from `lastSeen` over the
    // CURRENT active gids — so a segment leaving the set never double-counts,
    // and a poll that transiently returns null keeps the prior value instead of
    // dropping bytes.
    let finishedBytes = 0
    // Size lookups for segments that completed before any poll recorded them —
    // awaited before the run resolves so the FINAL total is accurate even when
    // the poll's first tick never landed (e.g. a fast single-segment stream).
    const pendingSizes: Promise<void>[] = []

    return new Promise<{ initPath?: string; partPaths: string[] }>(
      (resolve, reject) => {
        if (total === 0) {
          resolve({ initPath: undefined, partPaths: [] })
          return
        }

        this.rejectRun = reject

        const report = () => {
          let activeCompleted = 0
          let activeTotal = 0
          for (const gid of this.activeGids) {
            const ls = lastSeen.get(gid)
            if (ls) {
              activeCompleted += ls.completed
              activeTotal += ls.total
            }
          }
          onProgress({
            fraction: total > 0 ? completed / total : 0,
            downloadedBytes: finishedBytes + activeCompleted,
            totalBytes: finishedBytes + activeTotal,
          })
        }

        // Retain a finished segment's full size (so the total never shrinks when
        // its gid leaves the active set), then re-report.
        const addFinished = (bytes: number) => {
          finishedBytes += bytes
          report()
        }

        const buildResult = () => {
          const sorted = jobs.slice().sort((a, b) => a.jobIndex - b.jobIndex)
          let initPath: string | undefined
          const partPaths: string[] = []
          for (const j of sorted) {
            if (j.kind === 'init') initPath = j.outPath
            else partPaths.push(j.outPath)
          }
          return { initPath, partPaths }
        }

        const resolveWhenDone = () => {
          if (completed !== total) return
          // Await any in-flight size lookups so the final report is accurate
          // before the run resolves (the coordinator reads the final bytes).
          void Promise.all(pendingSizes).then(() => {
            this.stopPolling()
            report()
            resolve(buildResult())
          })
        }

        // Register callbacks once
        this.aria2.onComplete((gid) => {
          const job = this.activeJobs.get(gid)
          if (!job) return
          this.activeJobs.delete(gid)
          this.activeGids.delete(gid)
          completed++

          const ls = lastSeen.get(gid)
          if (ls) {
            // Size known from a prior poll: move it to finished synchronously so
            // the running total stays continuous (no dip as the gid leaves).
            lastSeen.delete(gid)
            addFinished(ls.total)
          } else {
            // Completed before any poll recorded its size — it contributed 0 to
            // every prior report, so learning its size now only ADDS (never
            // shrinks). aria2 keeps a completed download queryable until
            // removeDownloadResult, so a final tellStatus still returns it.
            report()
            pendingSizes.push(
              this.aria2
                .tellStatus(gid)
                .catch(() => null)
                .then((s) => {
                  if (s) addFinished(s.totalLength)
                })
            )
          }

          releaseSlot()
          resolveWhenDone()
        })

        this.aria2.onError((gid) => {
          const job = this.activeJobs.get(gid)
          if (!job) return
          this.activeJobs.delete(gid)
          this.activeGids.delete(gid)
          // A retry restarts this segment from zero; drop its cached bytes so
          // the active sum reflects only live in-flight segments.
          lastSeen.delete(gid)

          if (job.retriesLeft > 0) {
            // Re-submit with one fewer retry remaining
            job.retriesLeft--
            submitJob(job)
          } else {
            this.stopPolling()
            reject(
              new Error(`Segment download failed permanently: ${job.outPath}`)
            )
          }
        })

        // ── Byte poll ────────────────────────────────────────────────────
        // Refresh the live-byte cache for every in-flight gid, then report.
        // Never throws: tellStatus null-guards and the tick is fire-and-forget.
        const pollOnce = async () => {
          const gids = [...this.activeGids]
          if (gids.length > 0) {
            const results = await Promise.all(
              gids.map((g) =>
                this.aria2.tellStatus(g).then(
                  (s) => ({ gid: g, s }),
                  () => ({ gid: g, s: null })
                )
              )
            )
            for (const { gid, s } of results) {
              // A gid that completed/errored during the await is no longer
              // active — skip it so we don't resurrect a stale cache entry.
              if (!this.activeGids.has(gid)) continue
              if (s) {
                lastSeen.set(gid, {
                  completed: s.completedLength,
                  total: s.totalLength,
                })
              }
            }
          }
          report()
        }

        // Semaphore implementation
        let running = 0
        const jobQueue = jobs.slice()

        const submitJob = (job: Job) => {
          if (this.cancelled) {
            return
          }
          running++
          const partHeaders = buildHeaders(job.part, headers)
          this.aria2
            .addUri([job.part.url], {
              dir: this.tmpDir,
              out: path.basename(job.outPath),
              header: partHeaders.length > 0 ? partHeaders : undefined,
              'max-tries': MAX_TRIES,
              'retry-wait': RETRY_WAIT,
            })
            .then((gid) => {
              if (this.cancelled) {
                void this.aria2.forceRemove(gid)
                return
              }
              this.activeJobs.set(gid, job)
              this.activeGids.add(gid)
            })
            .catch((err: Error) => {
              running--
              this.stopPolling()
              reject(err)
            })
        }

        const releaseSlot = () => {
          running--
          drain()
        }

        const drain = () => {
          while (running < this.concurrency && jobQueue.length > 0) {
            const next = jobQueue.shift()
            if (next !== undefined) submitJob(next)
          }
        }

        // Start the byte poll and kick off the initial batch.
        this.stopPoll = this.pollScheduler(pollOnce)
        drain()
      }
    )
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    this.stopPolling()
    const gids = [...this.activeGids]
    this.activeGids.clear()
    this.activeJobs.clear()
    await Promise.allSettled(gids.map((g) => this.aria2.forceRemove(g)))
    if (this.rejectRun) {
      this.rejectRun(new Error('SegmentDownloader: cancelled'))
      this.rejectRun = null
    }
  }
}
