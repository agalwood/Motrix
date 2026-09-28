import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  FfmpegService,
  muxerForOutputName,
  type RemuxJob,
} from './ffmpeg-service'

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: (sig?: string) => void
    killed: boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
  })
  return child
}

const VIDEO_ONLY_TS_JOB: RemuxJob = {
  binaryPath: 'ffmpeg',
  videoPath: '/tmp/all.ts',
  output: '/tmp/out.mp4',
  fromMpegts: true,
  durationSec: 10,
}

const VIDEO_AUDIO_JOB: RemuxJob = {
  binaryPath: 'ffmpeg',
  videoPath: '/tmp/video.mp4',
  audioPath: '/tmp/audio.mp4',
  output: '/tmp/out.mp4',
  fromMpegts: false,
  durationSec: 20,
}

const NON_MPEGTS_JOB: RemuxJob = {
  binaryPath: 'ffmpeg',
  videoPath: '/tmp/combined.mp4',
  output: '/tmp/out.mp4',
  fromMpegts: false,
  durationSec: 10,
}

describe('FfmpegService', () => {
  it('(a) video-only TS source argv: -i video, -c copy, -bsf:a aac_adtstoasc, -movflags +faststart, -progress pipe:1, output last; no -map', async () => {
    const child = fakeChild()
    const spawnImpl = vi.fn(() => child) as never
    const svc = new FfmpegService()
    const p = svc.run(VIDEO_ONLY_TS_JOB, () => {}, spawnImpl)
    const [bin, args] = (
      spawnImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0] as [string, string[]]

    expect(bin).toBe('ffmpeg')
    expect(args).toContain('-i')
    expect(args).toContain('/tmp/all.ts')
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args.join(' ')).toContain('-bsf:a aac_adtstoasc')
    expect(args.join(' ')).toContain('-movflags +faststart')
    expect(args.join(' ')).toContain('-progress pipe:1')
    expect(args[args.length - 1]).toBe('/tmp/out.mp4')
    expect(args).not.toContain('-map')

    child.emit('close', 0)
    await p
  })

  it('(b) video+audio argv has two -i and -map 0:v:0 -map 1:a:0', async () => {
    const child = fakeChild()
    const svc = new FfmpegService()
    const args = svc.buildArgs(VIDEO_AUDIO_JOB)

    const iIndices = args.reduce<number[]>((acc, a, i) => {
      if (a === '-i') acc.push(i)
      return acc
    }, [])
    expect(iIndices).toHaveLength(2)
    expect(args[iIndices[0] + 1]).toBe('/tmp/video.mp4')
    expect(args[iIndices[1] + 1]).toBe('/tmp/audio.mp4')

    const joined = args.join(' ')
    expect(joined).toContain('-map 0:v:0')
    expect(joined).toContain('-map 1:a:0')

    const p = svc.run(VIDEO_AUDIO_JOB, () => {}, (() => child) as never)
    child.emit('close', 0)
    await p
  })

  it('(c) fromMpegts:false omits the aac bsf', () => {
    const svc = new FfmpegService()
    const args = svc.buildArgs(NON_MPEGTS_JOB)
    expect(args.join(' ')).not.toContain('aac_adtstoasc')
  })

  it('(d) progress fraction from out_time_ms / duration', async () => {
    const child = fakeChild()
    const svc = new FfmpegService()
    const seen: (number | null)[] = []
    const p = svc.run(
      VIDEO_ONLY_TS_JOB,
      (pr) => seen.push(pr.progress),
      (() => child) as never
    )
    // durationSec=10 → durMs=10000; out_time_ms=5000000 µs → 5000ms → 0.5
    child.stdout.emit(
      'data',
      Buffer.from('out_time_ms=5000000\nprogress=continue\n')
    )
    child.emit('close', 0)
    await p
    expect(seen).toEqual([0.5, 1])
  })

  it('parses fragmented lines and multiple records, but progress=end is not success', async () => {
    const child = fakeChild()
    const seen: (number | null)[] = []
    const run = new FfmpegService().run(
      VIDEO_ONLY_TS_JOB,
      (p) => seen.push(p.progress),
      (() => child) as never
    )
    child.stdout.emit('data', Buffer.from('out_time_'))
    child.stdout.emit('data', Buffer.from('ms=2500000\nprogress=cont'))
    child.stdout.emit(
      'data',
      Buffer.from('inue\nout_time_ms=10000000\nprogress=end\n')
    )
    expect(seen).toEqual([0.25, 0.9999])
    child.emit('close', 1)
    await expect(run).rejects.toThrow('mux-failed')
    child.stdout.emit(
      'data',
      Buffer.from('out_time_ms=10000000\nprogress=end\n')
    )
    expect(seen).toEqual([0.25, 0.9999])
  })

  it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'shows indeterminate mux progress for duration %s until successful exit',
    async (durationSec) => {
      const child = fakeChild()
      const seen: (number | null)[] = []
      const run = new FfmpegService().run(
        { ...VIDEO_ONLY_TS_JOB, durationSec },
        (p) => seen.push(p.progress),
        (() => child) as never
      )
      child.stdout.emit(
        'data',
        Buffer.from('out_time_ms=5000000\nprogress=end\n')
      )
      expect(seen).toEqual([null])
      child.emit('close', 0)
      await run
      expect(seen).toEqual([null, 1])
    }
  )

  it('drops overlong lines and ignores output after cancellation', async () => {
    const child = fakeChild()
    const seen: (number | null)[] = []
    const svc = new FfmpegService()
    const run = svc.run(
      VIDEO_ONLY_TS_JOB,
      (p) => seen.push(p.progress),
      (() => child) as never
    )
    child.stdout.emit('data', Buffer.from(`out_time_ms=${'9'.repeat(10000)}`))
    child.stdout.emit(
      'data',
      Buffer.from('\nout_time_ms=2500000\nprogress=continue\n')
    )
    expect(seen).toEqual([0.25])
    svc.kill()
    child.stdout.emit(
      'data',
      Buffer.from('out_time_ms=10000000\nprogress=end\n')
    )
    child.emit('close', 0)
    await expect(run).rejects.toThrow('mux-aborted')
    expect(seen).toEqual([0.25])
  })

  it('(e) non-zero exit rejects with mux-failed', async () => {
    const child = fakeChild()
    const svc = new FfmpegService()
    const p = svc.run(VIDEO_ONLY_TS_JOB, () => {}, (() => child) as never)
    child.emit('close', 1)
    await expect(p).rejects.toThrow(/mux-failed/)
  })

  it('(f) kill() rejects with mux-aborted', async () => {
    const child = fakeChild()
    const svc = new FfmpegService()
    const p = svc.run(VIDEO_ONLY_TS_JOB, () => {}, (() => child) as never)
    svc.kill()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', 137)
    await expect(p).rejects.toThrow(/mux-aborted/)
  })

  it('(g) non-zero exit appends the ffmpeg stderr tail after the code (still starts with mux-failed)', async () => {
    const child = fakeChild()
    const svc = new FfmpegService()
    const p = svc.run(VIDEO_AUDIO_JOB, () => {}, (() => child) as never)
    // ffmpeg's stderr names the offending input on an EINVAL/234 mux failure.
    child.stderr.emit(
      'data',
      Buffer.from(
        "Stream map '0:v:0' matches no streams.\nError opening output files: Invalid argument\n"
      )
    )
    child.emit('close', 234)
    // mapError matches the leading "mux-failed" token; the detail follows.
    await expect(p).rejects.toThrow(/^mux-failed: ffmpeg exited 234:/)
    await expect(p).rejects.toThrow(/matches no streams/)
  })

  it('(h) empty stderr → message is unchanged (no trailing colon)', async () => {
    const child = fakeChild()
    const svc = new FfmpegService()
    const p = svc.run(VIDEO_ONLY_TS_JOB, () => {}, (() => child) as never)
    child.emit('close', 183)
    await expect(p).rejects.toThrow(/^mux-failed: ffmpeg exited 183$/)
  })

  // The .motrix placeholder contract writes the mux output to a temp path
  // whose extension ffmpeg cannot infer a muxer from — the job must carry the
  // muxer explicitly.
  it('(i) format adds -f <muxer> and the output stays last', () => {
    const svc = new FfmpegService()
    const args = svc.buildArgs({
      ...VIDEO_AUDIO_JOB,
      output: '/save/v.mp4.motrix',
      format: 'mp4',
    })
    expect(args.join(' ')).toContain('-f mp4')
    expect(args[args.length - 1]).toBe('/save/v.mp4.motrix')
  })

  it('(j) omits -f when format is not set', () => {
    const svc = new FfmpegService()
    const args = svc.buildArgs(VIDEO_AUDIO_JOB)
    expect(args).not.toContain('-f')
  })
})

describe('muxerForOutputName', () => {
  // Invariant: the muxer chosen via -f must be the same one ffmpeg would have
  // picked from the extension of the FINAL name, or the container format of
  // the produced file silently drifts.
  it.each([
    ['video.mp4', 'mp4'],
    ['video.m4v', 'ipod'],
    ['video.mov', 'mov'],
    ['video.mkv', 'matroska'],
    ['video.webm', 'webm'],
    ['video.ts', 'mpegts'],
    ['video.flv', 'flv'],
    ['audio.m4a', 'ipod'],
    ['audio.aac', 'adts'],
    ['audio.mp3', 'mp3'],
    ['audio.opus', 'opus'],
  ])('maps %s → %s', (name, muxer) => {
    expect(muxerForOutputName(name)).toBe(muxer)
  })

  it('falls back to mp4 for unknown or missing extensions', () => {
    expect(muxerForOutputName('BV14vJg6ZEd4')).toBe('mp4')
    expect(muxerForOutputName('archive.xyz')).toBe('mp4')
  })

  it('is case-insensitive', () => {
    expect(muxerForOutputName('VIDEO.MKV')).toBe('matroska')
  })
})
