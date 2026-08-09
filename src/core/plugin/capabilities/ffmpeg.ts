// ffmpeg capability — spawn + AsyncIterable progress + abort.
//
// Operation handle pattern (I38):
//   run() returns an FfmpegOpHandle<T> immediately. The caller can await
//   handle.result or iterate handle.progress independently. The handle's
//   abort() method sends SIGTERM to the spawned process; if the process
//   has not exited within 5 seconds, SIGKILL is sent.
//
// Progress events:
//   Parsed from stderr via /time=(\d+):(\d+):([\d.]+).*?speed=([\d.]+)x/.
//   Debounced: at most one event per 1 000 ms wall-clock time. If no new
//   progress arrives within 1 s after the most recent event, the prior
//   progress is re-emitted as a keep-alive sentinel so consumers do not
//   starve.  Iterator ends when the process closes.
//
// Abort / timeout:
//   abort() -> SIGTERM -> 5 s grace -> SIGKILL.
//   An external AbortSignal chains into the same abort() path.
//   timeoutMs defaults to 60 min; hard cap is 60 min.
//
// Staging redirect hook:
//   FfmpegCapabilityHostOptions.stagingPathFor(outputPath) -> stagedPath.
//   When provided, the resolved staged path is substituted for the caller's
//   outputPath in argv *and* returned in the result payload. The
//   CapabilityBridge.gateFfmpegOutput path is the primary caller and
//   redirects upstream before invoking run/transcode/etc., so this hook is
//   typically a no-op in production wiring; it remains as an explicit
//   injection point for unit tests of the capability host in isolation.
//
// Boundary: MUST NOT import electron, @main/, or @server/.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { FfmpegDetection } from './ffmpeg-detect'

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class FfmpegError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FfmpegProgress {
  /** 0..100, best-effort; requires expectedDurationMs to be non-zero */
  percent: number
  /** e.g. "1.2x" */
  speed: string
  /** current time position in ms */
  timeMs: number
}

export interface FfmpegOpHandle<T> {
  id: string
  result: Promise<T>
  progress: AsyncIterable<FfmpegProgress>
  abort(): void
}

export interface FfmpegRunOptions {
  /** Raw ffmpeg args (excluding the binary path). */
  argv: string[]
  /** Output path; CapabilityBridge.gateFfmpegOutput pre-redirects it for beforeFinalize. */
  outputPath: string
  /** Default 60 * 60_000; hard cap 60 min. */
  timeoutMs?: number
  signal?: AbortSignal
  /** When provided, drives percent calculation. */
  expectedDurationMs?: number
}

export interface MediaInfo {
  durationMs: number
  format?: string
  streams: ReadonlyArray<{ type: string; codec?: string; bitrate?: number }>
}

export interface FfmpegCapabilityHostOptions {
  detect: FfmpegDetection
  /**
   * Optional staging redirect. Primary callers (CapabilityBridge.gateFfmpegOutput)
   * pre-redirect the output before invoking run/transcode/etc., so this hook is
   * usually undefined in production. Tests and direct callers of FfmpegCapabilityHost
   * can set it to observe path rewrites.
   */
  stagingPathFor?: (outputPath: string) => string
  /**
   * Override the spawn function. Defaults to node:child_process.spawn.
   * Provided for testing without requiring a real ffmpeg binary.
   */
  spawnFn?: typeof spawn
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGKILL_GRACE_MS = 5_000
const MAX_TIMEOUT_MS = 60 * 60_000
const PROGRESS_DEBOUNCE_MS = 1_000
const KEEP_ALIVE_IDLE_MS = 1_000

// ---------------------------------------------------------------------------
// Progress parsing helpers
// ---------------------------------------------------------------------------

// Matches stderr lines like:
//   frame=42 fps=30.0 q=-0.0 size=N/A time=00:00:05.000 bitrate=N/A speed=1.5x
const PROGRESS_RE = /time=(\d+):(\d+):([\d.]+).*?speed=([\d.]+)x/

// Matches Duration in probe output:
//   Duration: 00:01:23.45, ...
const DURATION_RE = /Duration:\s+(\d+):(\d+):([\d.]+)/

function parseHmsToMs(h: string, m: string, s: string): number {
  return (
    Number.parseInt(h, 10) * 3_600_000 +
    Number.parseInt(m, 10) * 60_000 +
    Math.round(Number.parseFloat(s) * 1_000)
  )
}

function parseProgress(
  line: string,
  expectedDurationMs: number
): FfmpegProgress | null {
  const match = PROGRESS_RE.exec(line)
  if (!match) return null
  const timeMs = parseHmsToMs(match[1], match[2], match[3])
  const speed = `${match[4]}x`
  const percent =
    expectedDurationMs > 0
      ? Math.min(100, (timeMs / expectedDurationMs) * 100)
      : 0
  return { percent, speed, timeMs }
}

// ---------------------------------------------------------------------------
// Internal AsyncIterable queue
// ---------------------------------------------------------------------------

interface Queue<T> {
  push(v: T): void
  close(): void
  iter: AsyncIterable<T>
}

function makeQueue<T>(): Queue<T> {
  const buf: T[] = []
  const waiters: Array<(v: IteratorResult<T, undefined>) => void> = []
  let closed = false

  function push(v: T): void {
    if (closed) return
    if (waiters.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
      waiters.shift()!({ value: v, done: false })
    } else {
      buf.push(v)
    }
  }

  function close(): void {
    if (closed) return
    closed = true
    for (const w of waiters) {
      w({ value: undefined, done: true })
    }
    waiters.length = 0
  }

  const iter: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          return new Promise((resolve) => {
            if (buf.length > 0) {
              // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
              resolve({ value: buf.shift()!, done: false })
            } else if (closed) {
              resolve({ value: undefined, done: true })
            } else {
              waiters.push(resolve)
            }
          })
        },
      }
    },
  }

  return { push, close, iter }
}

// ---------------------------------------------------------------------------
// FfmpegCapabilityHost
// ---------------------------------------------------------------------------

/** Unavailable no-op handle — returned immediately when ffmpeg is not available. */
function unavailableHandle(id: string): FfmpegOpHandle<{ outputPath: string }> {
  const err = new FfmpegError(
    'plugin.capability.unavailable',
    'ffmpeg not available'
  )
  const promise: Promise<{ outputPath: string }> = Promise.reject(err)
  // Suppress unhandled rejection warnings when caller only uses .progress.
  promise.catch(() => undefined)
  const emptyIter: AsyncIterable<FfmpegProgress> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<FfmpegProgress, undefined>> {
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
  return { id, result: promise, progress: emptyIter, abort: () => undefined }
}

export class FfmpegCapabilityHost {
  private readonly detect: FfmpegDetection
  private readonly stagingPathFor: ((p: string) => string) | undefined
  private readonly spawnFn: typeof spawn

  constructor(opts: FfmpegCapabilityHostOptions) {
    this.detect = opts.detect
    this.stagingPathFor = opts.stagingPathFor
    this.spawnFn = opts.spawnFn ?? spawn
  }

  get available(): boolean {
    return this.detect.available
  }

  get version(): string | undefined {
    return this.detect.version
  }

  // -------------------------------------------------------------------------
  // run
  // -------------------------------------------------------------------------

  run(opts: FfmpegRunOptions): FfmpegOpHandle<{ outputPath: string }> {
    if (!this.detect.available || !this.detect.binaryPath) {
      return unavailableHandle(randomUUID())
    }

    const id = randomUUID()
    const clampedTimeoutMs = Math.min(
      opts.timeoutMs !== undefined && opts.timeoutMs >= 0
        ? opts.timeoutMs
        : MAX_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    )
    const expectedDurationMs = opts.expectedDurationMs ?? 0

    // Substitute staged path when the test-isolation hook is set.
    const resolvedOutputPath = this.stagingPathFor
      ? this.stagingPathFor(opts.outputPath)
      : opts.outputPath

    // biome-ignore lint/style/noNonNullAssertion: binaryPath guarded above
    const binaryPath = this.detect.binaryPath!

    const queue = makeQueue<FfmpegProgress>()

    // -----------------------------------------------------------------------
    // Spawn process
    // -----------------------------------------------------------------------

    const proc = this.spawnFn(binaryPath, opts.argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // -----------------------------------------------------------------------
    // Abort machinery
    // -----------------------------------------------------------------------

    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout>

    const abort = (): void => {
      if (aborted) return
      aborted = true
      clearTimeout(timeoutTimer)
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore errors from kill (process may already be gone)
      }
      killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, SIGKILL_GRACE_MS)
    }

    // Chain external AbortSignal
    if (opts.signal) {
      if (opts.signal.aborted) {
        abort()
      } else {
        opts.signal.addEventListener('abort', abort, { once: true })
      }
    }

    // Internal operation timeout
    timeoutTimer = setTimeout(abort, clampedTimeoutMs)

    // -----------------------------------------------------------------------
    // Progress debounce + keep-alive
    // -----------------------------------------------------------------------

    let lastEmitTs = 0
    let lastProgress: FfmpegProgress | null = null
    let keepAliveTimer: ReturnType<typeof setTimeout> | undefined

    const scheduleKeepAlive = (): void => {
      clearTimeout(keepAliveTimer)
      if (lastProgress === null) return
      const captured = lastProgress
      keepAliveTimer = setTimeout(() => {
        queue.push(captured)
        // Reschedule for continuous keep-alive while process is running.
        scheduleKeepAlive()
      }, KEEP_ALIVE_IDLE_MS)
    }

    const emitProgress = (p: FfmpegProgress): void => {
      const now = Date.now()
      const elapsed = now - lastEmitTs
      lastProgress = p
      if (elapsed >= PROGRESS_DEBOUNCE_MS) {
        lastEmitTs = now
        queue.push(p)
        scheduleKeepAlive()
      }
      // else: debounce — lastProgress updated but no emit this tick
    }

    // -----------------------------------------------------------------------
    // stderr -> progress
    // -----------------------------------------------------------------------

    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        const p = parseProgress(line, expectedDurationMs)
        if (p !== null) emitProgress(p)
      }
    })

    // -----------------------------------------------------------------------
    // Result promise
    // -----------------------------------------------------------------------

    const result = new Promise<{ outputPath: string }>((resolve, reject) => {
      proc.on('error', (err: Error) => {
        clearTimeout(timeoutTimer)
        clearTimeout(killTimer)
        clearTimeout(keepAliveTimer)
        queue.close()
        reject(
          new FfmpegError(
            'plugin.ffmpeg.spawn_error',
            `ffmpeg spawn error: ${err.message}`
          )
        )
      })

      proc.on('close', (code: number | null) => {
        clearTimeout(timeoutTimer)
        clearTimeout(killTimer)
        clearTimeout(keepAliveTimer)
        queue.close()

        if (code === 0) {
          resolve({ outputPath: resolvedOutputPath })
        } else {
          reject(
            new FfmpegError(
              'plugin.ffmpeg.exit_nonzero',
              `ffmpeg exited with code ${code}`
            )
          )
        }
      })
    })

    return { id, result, progress: queue.iter, abort }
  }

  // -------------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------------

  probe(input: { path: string }): Promise<MediaInfo> {
    if (!this.detect.available || !this.detect.binaryPath) {
      return Promise.reject(
        new FfmpegError('plugin.capability.unavailable', 'ffmpeg not available')
      )
    }

    // biome-ignore lint/style/noNonNullAssertion: binaryPath guarded above
    const binaryPath = this.detect.binaryPath!

    return new Promise<MediaInfo>((resolve, reject) => {
      // `ffmpeg -i <input>` prints the container/stream metadata to stderr
      // during input analysis, then exits non-zero ("output file must be
      // specified") — we ignore the exit code. We deliberately do NOT append
      // `-f null -`: that forces a full decode of the entire file (minutes for
      // a multi-GB video, tripping the 30s timeout) yet produces nothing this
      // parser reads — duration/format/streams all come from the header block.
      const proc = this.spawnFn(binaryPath, ['-i', input.path], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM')
        } catch {
          // ignore
        }
        reject(
          new FfmpegError(
            'plugin.ffmpeg.probe_timeout',
            'ffmpeg probe timed out'
          )
        )
      }, 30_000)

      // Cap the captured stderr: probe only needs the small header block
      // (Input/Duration/Stream lines). Without a cap, an input pointed at a
      // pipe/large stream (or a misbehaving ffmpeg) could flood stderr and
      // exhaust heap inside the 30s window.
      const STDERR_CAP_BYTES = 1 << 20 // 1 MB
      let stderrCapture = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderrCapture.length < STDERR_CAP_BYTES) {
          stderrCapture += chunk.toString()
        }
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(
          new FfmpegError(
            'plugin.ffmpeg.spawn_error',
            `ffmpeg spawn error: ${err.message}`
          )
        )
      })

      proc.on('close', () => {
        clearTimeout(timer)
        // ffmpeg -i ... -f null - exits 1 for probe; we ignore the code.
        const durationMatch = DURATION_RE.exec(stderrCapture)
        const durationMs = durationMatch
          ? parseHmsToMs(durationMatch[1], durationMatch[2], durationMatch[3])
          : 0

        const formatMatch = /Input #0,\s+([^,]+),/.exec(stderrCapture)
        const format = formatMatch ? formatMatch[1].trim() : undefined

        // Parse stream lines: e.g. "Stream #0:0: Video: h264 ..."
        const streams: Array<{
          type: string
          codec?: string
          bitrate?: number
        }> = []
        const streamRe =
          /Stream #\d+:\d+.*?:\s+(Video|Audio|Subtitle|Data):\s+(\S+)/g
        let sm: RegExpExecArray | null
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex while-loop
        while ((sm = streamRe.exec(stderrCapture)) !== null) {
          streams.push({
            type: sm[1].toLowerCase(),
            codec: sm[2].replace(',', ''),
          })
        }

        resolve({ durationMs, format, streams })
      })
    })
  }

  // -------------------------------------------------------------------------
  // transcode
  // -------------------------------------------------------------------------

  transcode(opts: {
    input: string
    output: string
    videoCodec?: string
    audioCodec?: string
    timeoutMs?: number
    signal?: AbortSignal
    expectedDurationMs?: number
  }): FfmpegOpHandle<{ outputPath: string }> {
    const argv = [
      '-i',
      opts.input,
      '-c:v',
      opts.videoCodec ?? 'libx264',
      '-c:a',
      opts.audioCodec ?? 'aac',
      '-y',
      opts.output,
    ]
    return this.run({
      argv,
      outputPath: opts.output,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      expectedDurationMs: opts.expectedDurationMs,
    })
  }

  // -------------------------------------------------------------------------
  // extractAudio
  // -------------------------------------------------------------------------

  extractAudio(opts: {
    input: string
    output: string
    codec?: 'mp3' | 'aac' | 'flac' | 'wav'
    timeoutMs?: number
    signal?: AbortSignal
    expectedDurationMs?: number
  }): FfmpegOpHandle<{ outputPath: string }> {
    const codecMap: Record<string, string> = {
      mp3: 'libmp3lame',
      aac: 'aac',
      flac: 'flac',
      wav: 'pcm_s16le',
    }
    const ffmpegCodec = codecMap[opts.codec ?? 'mp3'] ?? 'libmp3lame'
    const argv = [
      '-i',
      opts.input,
      '-vn',
      '-c:a',
      ffmpegCodec,
      '-y',
      opts.output,
    ]
    return this.run({
      argv,
      outputPath: opts.output,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      expectedDurationMs: opts.expectedDurationMs,
    })
  }

  // -------------------------------------------------------------------------
  // mergeStreams
  // -------------------------------------------------------------------------

  mergeStreams(opts: {
    videoInput: string
    audioInput: string
    output: string
    timeoutMs?: number
    signal?: AbortSignal
  }): FfmpegOpHandle<{ outputPath: string }> {
    const argv = [
      '-i',
      opts.videoInput,
      '-i',
      opts.audioInput,
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-y',
      opts.output,
    ]
    return this.run({
      argv,
      outputPath: opts.output,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    })
  }

  // -------------------------------------------------------------------------
  // generateThumbnail
  // -------------------------------------------------------------------------

  generateThumbnail(opts: {
    input: string
    output: string
    timestampSec?: number
    width?: number
    height?: number
    timeoutMs?: number
    signal?: AbortSignal
  }): FfmpegOpHandle<{ outputPath: string }> {
    const sizeArgs: string[] =
      opts.width !== undefined || opts.height !== undefined
        ? ['-vf', `scale=${opts.width ?? -1}:${opts.height ?? -1}`]
        : []
    const argv = [
      '-ss',
      String(opts.timestampSec ?? 1),
      '-i',
      opts.input,
      '-frames:v',
      '1',
      ...sizeArgs,
      '-y',
      opts.output,
    ]
    return this.run({
      argv,
      outputPath: opts.output,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    })
  }
}
