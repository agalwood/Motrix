import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'

export interface RemuxJob {
  binaryPath: string
  videoPath: string
  audioPath?: string
  output: string
  fromMpegts: boolean
  durationSec?: number
  /**
   * Explicit output muxer (`-f`). Required when `output` does not end in a
   * media extension ffmpeg can infer a muxer from — e.g. the `.motrix`
   * placeholder path a media task muxes into before the finalize rename.
   */
  format?: string
}

/**
 * The muxer ffmpeg would pick from the extension of the FINAL output name.
 * Must stay in sync with mediaFinalName's KNOWN_MEDIA_EXT: every extension
 * ensureMediaExtension can emit or pass through needs an entry here, so that
 * muxing to the extension-less `.motrix` path via `-f` produces the same
 * container the final name advertises.
 */
const EXT_TO_MUXER: Record<string, string> = {
  mp4: 'mp4',
  m4v: 'ipod',
  mov: 'mov',
  mkv: 'matroska',
  webm: 'webm',
  ts: 'mpegts',
  flv: 'flv',
  m4a: 'ipod',
  aac: 'adts',
  mp3: 'mp3',
  opus: 'opus',
}

export function muxerForOutputName(name: string): string {
  const ext = /\.([a-z0-9]{2,8})$/i.exec(name)?.[1]?.toLowerCase()
  return (ext && EXT_TO_MUXER[ext]) || 'mp4'
}

type SpawnImpl = (cmd: string, args: string[]) => ChildProcess

export class FfmpegService {
  private child: ChildProcess | null = null
  private aborted = false

  buildArgs(job: RemuxJob): string[] {
    const args: string[] = []

    args.push('-i', job.videoPath)
    if (job.audioPath) {
      args.push('-i', job.audioPath)
    }

    args.push('-c', 'copy')

    if (job.audioPath) {
      args.push('-map', '0:v:0', '-map', '1:a:0')
    }

    if (job.fromMpegts) {
      args.push('-bsf:a', 'aac_adtstoasc')
    }

    args.push('-movflags', '+faststart')
    if (job.format) {
      args.push('-f', job.format)
    }
    args.push('-progress', 'pipe:1', '-nostats', '-y', job.output)

    return args
  }

  run(
    job: RemuxJob,
    onProgress: (p: { progress: number }) => void,
    spawnImpl: SpawnImpl = nodeSpawn as SpawnImpl
  ): Promise<void> {
    this.aborted = false
    const args = this.buildArgs(job)
    const child = spawnImpl(job.binaryPath, args)
    this.child = child
    const durMs = (job.durationSec ?? 0) * 1000

    // Buffer a bounded tail of stderr so a non-zero exit can report WHY ffmpeg
    // failed. ffmpeg names the offending input here — e.g. for exit 234
    // (EINVAL) it prints "Stream map '0:v:0' matches no streams" (a leg is the
    // wrong stream type) or "...Invalid data found... in 'audio.mp4'". Cap to
    // the last ~8 KiB so this never grows unbounded.
    const STDERR_TAIL_LIMIT = 8192
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString()
      if (stderrTail.length > STDERR_TAIL_LIMIT) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT)
      }
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      const fields = parseProgressBlock(chunk.toString())
      const outTimeUs = fields.out_time_ms ?? 0
      const done = fields.progress === 'end'
      const progress = done
        ? 1
        : durMs > 0
          ? Math.min(0.999, outTimeUs / 1000 / durMs)
          : 0
      onProgress({ progress })
    })

    return new Promise<void>((resolve, reject) => {
      child.on('error', (err) =>
        reject(new Error(`mux-failed: ${err.message}`))
      )
      child.on('close', (code) => {
        this.child = null
        if (this.aborted) return reject(new Error('mux-aborted'))
        if (code === 0) return resolve()
        // Append the last few non-empty stderr lines — ffmpeg names the
        // offending input/stream here. The message MUST still start with
        // "mux-failed" (MediaTaskCoordinator.mapError matches that prefix to
        // normalize task.errorMessage), so the detail goes after the code.
        const tail = stderrTail
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6)
          .join(' | ')
        const detail = tail ? `: ${tail}` : ''
        reject(new Error(`mux-failed: ffmpeg exited ${code}${detail}`))
      })
    })
  }

  kill(): void {
    this.aborted = true
    this.child?.kill('SIGKILL')
  }
}

function parseProgressBlock(text: string): {
  out_time_ms?: number
  total_size?: number
  progress?: string
} {
  const out: { out_time_ms?: number; total_size?: number; progress?: string } =
    {}
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const val = line.slice(eq + 1)
    if (key === 'out_time_ms') out.out_time_ms = Number(val)
    else if (key === 'total_size') out.total_size = Number(val)
    else if (key === 'progress') out.progress = val
  }
  return out
}
