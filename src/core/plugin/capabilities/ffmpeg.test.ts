// ffmpeg capability tests — spawn-injection based (no real binary required).
//
// Strategy: pass a spawnFn factory to FfmpegCapabilityHost that returns
// synthetic EventEmitter instances simulating ffmpeg stderr output and exit.
// This avoids module mocking entirely, giving deterministic test behaviour.
//
// Test plan:
//  1. unavailable host: all methods throw plugin.capability.unavailable
//  2. run returns an FfmpegOpHandle with id / result / progress / abort
//  3. result resolves with outputPath when close(0)
//  4. result rejects with exit_nonzero when close(non-0)
//  5. Progress: stderr line yields FfmpegProgress event
//  6. Debounce: rapid stderr lines within 1s emit only one progress event
//  7. Idle keep-alive: 1s after last event, prior event is re-emitted
//  8. abort() sends SIGTERM
//  9. AbortSignal triggers abort
// 10. Timeout fires abort after timeoutMs
// 11. transcode builds expected argv
// 12. generateThumbnail builds expected argv with -ss and -frames:v 1
// 13. extractAudio maps codec names to ffmpeg codec args
// 14. mergeStreams builds expected argv with two -i flags

import { EventEmitter } from 'node:events'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import { FfmpegCapabilityHost, FfmpegError } from './ffmpeg'
import type { FfmpegDetection } from './ffmpeg-detect'

// ---------------------------------------------------------------------------
// Synthetic ChildProcess
// ---------------------------------------------------------------------------

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: Mock
  _emitStderr(line: string): void
  _close(code: number | null): void
  _error(err: Error): void
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc._emitStderr = (line: string) => {
    proc.stderr.emit('data', Buffer.from(`${line}\n`))
  }
  proc._close = (code: number | null) => {
    proc.emit('close', code)
  }
  proc._error = (err: Error) => {
    proc.emit('error', err)
  }
  return proc
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AVAILABLE_DETECT: FfmpegDetection = {
  available: true,
  binaryPath: '/usr/bin/ffmpeg',
  version: 'test-1.0.0',
}

const UNAVAILABLE_DETECT: FfmpegDetection = {
  available: false,
}

// A valid ffmpeg progress stderr line.
const PROGRESS_LINE =
  'frame=   42 fps=30.0 q=-0.0 size=N/A time=00:00:05.000 bitrate=N/A speed=1.50x'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain an AsyncIterable to completion. */
async function drainAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) {
    results.push(item)
  }
  return results
}

/** Collect exactly `max` items then return; does not drain the full iterator. */
async function collectN<T>(iter: AsyncIterable<T>, max: number): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) {
    results.push(item)
    if (results.length >= max) break
  }
  return results
}

// ---------------------------------------------------------------------------
// Tests: unavailable host
// ---------------------------------------------------------------------------

describe('FfmpegCapabilityHost — unavailable', () => {
  const host = new FfmpegCapabilityHost({ detect: UNAVAILABLE_DETECT })

  it('available returns false', () => {
    expect(host.available).toBe(false)
  })

  it('version is undefined', () => {
    expect(host.version).toBeUndefined()
  })

  it('run result rejects with plugin.capability.unavailable', async () => {
    const handle = host.run({ argv: ['-version'], outputPath: '/out.mp4' })
    await expect(handle.result).rejects.toMatchObject({
      code: 'plugin.capability.unavailable',
    })
  })

  it('run progress iterator completes immediately (no events)', async () => {
    const handle = host.run({ argv: ['-version'], outputPath: '/out.mp4' })
    const events = await drainAll(handle.progress)
    expect(events).toHaveLength(0)
  })

  it('transcode result rejects with plugin.capability.unavailable', async () => {
    const handle = host.transcode({ input: '/in.mp4', output: '/out.mp4' })
    await expect(handle.result).rejects.toMatchObject({
      code: 'plugin.capability.unavailable',
    })
  })

  it('probe rejects with plugin.capability.unavailable', async () => {
    await expect(host.probe({ path: '/in.mp4' })).rejects.toMatchObject({
      code: 'plugin.capability.unavailable',
    })
  })
})

describe('FfmpegCapabilityHost — probe', () => {
  let proc: FakeProc
  let spawnMock: Mock

  beforeEach(() => {
    proc = makeFakeProc()
    spawnMock = vi.fn().mockReturnValue(proc)
  })

  it('header-only probe (no -f null full decode) parses metadata', async () => {
    const host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
    const p = host.probe({ path: '/in.mp4' })
    // Probe must read metadata from the header only: `ffmpeg -i <path>` prints
    // stream info then exits. The old `-f null -` forced a full decode that
    // burned minutes and tripped the 30s timeout on exactly the large files
    // plugins need duration for.
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-i', '/in.mp4'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
    proc._emitStderr("Input #0, mov,mp4,m4a, from '/in.mp4':")
    proc._emitStderr(
      '  Duration: 00:00:10.00, start: 0.000000, bitrate: 1149 kb/s'
    )
    proc._emitStderr('    Stream #0:0: Video: h264 (High), yuv420p, 1920x1080')
    proc._close(1) // `ffmpeg -i` with no output exits non-zero; code ignored
    const info = await p
    expect(info.durationMs).toBe(10_000)
    expect(info.format).toBe('mov')
    expect(info.streams[0]).toEqual({ type: 'video', codec: 'h264' })
  })
})

// ---------------------------------------------------------------------------
// Tests: run — basic lifecycle
// ---------------------------------------------------------------------------

describe('FfmpegCapabilityHost — run', () => {
  let proc: FakeProc
  let spawnMock: Mock
  let host: FfmpegCapabilityHost

  beforeEach(() => {
    proc = makeFakeProc()
    spawnMock = vi.fn().mockReturnValue(proc)
    host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('available returns true and version is set', () => {
    expect(host.available).toBe(true)
    expect(host.version).toBe('test-1.0.0')
  })

  it('returns a handle with a UUID id', () => {
    const handle = host.run({ argv: ['-version'], outputPath: '/out' })
    proc._close(0)
    expect(handle.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('result resolves with outputPath when close(0)', async () => {
    const handle = host.run({
      argv: ['-i', '/in.mp4', '-y', '/out.mp4'],
      outputPath: '/out.mp4',
    })
    proc._close(0)
    await expect(handle.result).resolves.toEqual({ outputPath: '/out.mp4' })
  })

  it('result rejects with plugin.ffmpeg.exit_nonzero when close(1)', async () => {
    const handle = host.run({ argv: [], outputPath: '/out.mp4' })
    proc._close(1)
    await expect(handle.result).rejects.toMatchObject({
      code: 'plugin.ffmpeg.exit_nonzero',
    })
  })

  it('result rejects with plugin.ffmpeg.spawn_error on proc error', async () => {
    const handle = host.run({ argv: ['-version'], outputPath: '/out' })
    proc._error(new Error('ENOENT'))
    await expect(handle.result).rejects.toMatchObject({
      code: 'plugin.ffmpeg.spawn_error',
    })
  })

  it('passes argv directly to spawnFn with the binary path', () => {
    host.run({
      argv: ['-i', '/in.mp4', '-y', '/out.mp4'],
      outputPath: '/out.mp4',
    })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-i', '/in.mp4', '-y', '/out.mp4'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
  })

  it('progress: stderr progress line yields FfmpegProgress event', async () => {
    const handle = host.run({
      argv: [],
      outputPath: '/out.mp4',
      expectedDurationMs: 10_000,
    })

    const eventPromise = collectN(handle.progress, 1)
    proc._emitStderr(PROGRESS_LINE)
    const events = await eventPromise
    proc._close(0)

    expect(events).toHaveLength(1)
    expect(events[0].timeMs).toBe(5_000)
    expect(events[0].speed).toBe('1.50x')
    expect(events[0].percent).toBeCloseTo(50, 1)
  })

  it('progress: unparseable stderr produces no events', async () => {
    const handle = host.run({ argv: [], outputPath: '/out' })
    const drainPromise = drainAll(handle.progress)
    proc._emitStderr('INFO some log line')
    proc._close(0)
    const events = await drainPromise
    expect(events).toHaveLength(0)
  })

  it('percent is 0 when expectedDurationMs not provided', async () => {
    const handle = host.run({ argv: [], outputPath: '/out' })
    const eventPromise = collectN(handle.progress, 1)
    proc._emitStderr(PROGRESS_LINE)
    const events = await eventPromise
    proc._close(0)
    expect(events[0].percent).toBe(0)
  })

  it('abort() calls proc.kill(SIGTERM)', async () => {
    const handle = host.run({ argv: ['-version'], outputPath: '/out' })
    // Suppress the rejection from close(null) so vitest doesn't see unhandled rejection.
    handle.result.catch(() => undefined)
    handle.abort()
    proc._close(null)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('aborting twice calls kill only once', async () => {
    const handle = host.run({ argv: ['-version'], outputPath: '/out' })
    handle.result.catch(() => undefined)
    handle.abort()
    handle.abort()
    proc._close(null)
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('AbortSignal triggers abort', async () => {
    const ac = new AbortController()
    const handle = host.run({
      argv: ['-version'],
      outputPath: '/out',
      signal: ac.signal,
    })
    handle.result.catch(() => undefined)
    ac.abort()
    proc._close(null)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('already-aborted AbortSignal triggers abort immediately on run()', async () => {
    const ac = new AbortController()
    ac.abort()
    const handle = host.run({
      argv: ['-version'],
      outputPath: '/out',
      signal: ac.signal,
    })
    handle.result.catch(() => undefined)
    proc._close(null)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stagingPathFor rewrites outputPath in result', async () => {
    const stagingHost = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      stagingPathFor: (p) => `/staging${p}`,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
    const handle = stagingHost.run({
      argv: ['-i', '/in.mp4', '-y', '/out.mp4'],
      outputPath: '/out.mp4',
    })
    proc._close(0)
    const result = await handle.result
    expect(result.outputPath).toBe('/staging/out.mp4')
  })
})

// ---------------------------------------------------------------------------
// Tests: timeout + SIGKILL (fake timers)
// ---------------------------------------------------------------------------

describe('FfmpegCapabilityHost — timeout (fake timers)', () => {
  let proc: FakeProc
  let spawnMock: Mock

  beforeEach(() => {
    vi.useFakeTimers()
    proc = makeFakeProc()
    spawnMock = vi.fn().mockReturnValue(proc)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('timeout fires abort after timeoutMs', async () => {
    const host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
    const handle = host.run({
      argv: ['-version'],
      outputPath: '/out',
      timeoutMs: 100,
    })
    handle.result.catch(() => undefined)
    expect(proc.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(101)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    proc._close(null)
  })

  it('SIGKILL sent 5s after abort if process does not exit', async () => {
    const host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
    const handle = host.run({ argv: ['-version'], outputPath: '/out' })
    handle.result.catch(() => undefined)
    handle.abort()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5_001)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    proc._close(null)
  })
})

// ---------------------------------------------------------------------------
// Tests: debounce + keep-alive (fake timers)
// ---------------------------------------------------------------------------

describe('FfmpegCapabilityHost — debounce + keep-alive (fake timers)', () => {
  let proc: FakeProc
  let spawnMock: Mock

  beforeEach(() => {
    vi.useFakeTimers()
    proc = makeFakeProc()
    spawnMock = vi.fn().mockReturnValue(proc)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('debounce: first line emits; second line within 1s is debounced', async () => {
    const host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
    const handle = host.run({
      argv: [],
      outputPath: '/out',
      expectedDurationMs: 10_000,
    })

    const collected: unknown[] = []
    const iterDone = (async () => {
      for await (const e of handle.progress) {
        collected.push(e)
      }
    })()

    // First line: lastEmitTs=0 so elapsed >= 1000 → emits.
    proc._emitStderr(PROGRESS_LINE)
    await vi.advanceTimersByTimeAsync(0)

    // Second line immediately (< 1s since first) → debounced.
    proc._emitStderr(PROGRESS_LINE)
    await vi.advanceTimersByTimeAsync(0)

    // Close before keep-alive fires.
    proc._close(0)
    await iterDone

    expect(collected.length).toBe(1)
  })

  it('keep-alive: 1s idle after progress → prior event re-emitted', async () => {
    const host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
    const handle = host.run({ argv: [], outputPath: '/out' })

    const collected: unknown[] = []
    const iterDone = (async () => {
      for await (const e of handle.progress) {
        collected.push(e)
      }
    })()

    // Emit one progress event.
    proc._emitStderr(PROGRESS_LINE)
    await vi.advanceTimersByTimeAsync(0)

    // Advance 1s+ to trigger keep-alive.
    await vi.advanceTimersByTimeAsync(1_100)

    // Close process.
    proc._close(0)
    await iterDone

    // Expect: initial emit + at least one keep-alive.
    expect(collected.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Tests: helper argv construction
// ---------------------------------------------------------------------------

describe('FfmpegCapabilityHost — helpers', () => {
  let proc: FakeProc
  let spawnMock: Mock
  let host: FfmpegCapabilityHost

  beforeEach(() => {
    proc = makeFakeProc()
    spawnMock = vi.fn().mockReturnValue(proc)
    host = new FfmpegCapabilityHost({
      detect: AVAILABLE_DETECT,
      spawnFn:
        spawnMock as unknown as typeof import('node:child_process').spawn,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('transcode: default codecs', () => {
    host.transcode({ input: '/in.mp4', output: '/out.mp4' })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-i', '/in.mp4', '-c:v', 'libx264', '-c:a', 'aac', '-y', '/out.mp4'],
      expect.any(Object)
    )
  })

  it('transcode: custom codecs', () => {
    host.transcode({
      input: '/in.mp4',
      output: '/out.webm',
      videoCodec: 'libvpx-vp9',
      audioCodec: 'libopus',
    })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      [
        '-i',
        '/in.mp4',
        '-c:v',
        'libvpx-vp9',
        '-c:a',
        'libopus',
        '-y',
        '/out.webm',
      ],
      expect.any(Object)
    )
  })

  it('extractAudio: mp3 → libmp3lame', () => {
    host.extractAudio({ input: '/in.mp4', output: '/out.mp3', codec: 'mp3' })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-i', '/in.mp4', '-vn', '-c:a', 'libmp3lame', '-y', '/out.mp3'],
      expect.any(Object)
    )
  })

  it('extractAudio: aac → aac', () => {
    host.extractAudio({ input: '/in.mp4', output: '/out.aac', codec: 'aac' })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-i', '/in.mp4', '-vn', '-c:a', 'aac', '-y', '/out.aac'],
      expect.any(Object)
    )
  })

  it('extractAudio: wav → pcm_s16le', () => {
    host.extractAudio({ input: '/in.mp4', output: '/out.wav', codec: 'wav' })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-i', '/in.mp4', '-vn', '-c:a', 'pcm_s16le', '-y', '/out.wav'],
      expect.any(Object)
    )
  })

  it('mergeStreams: correct argv with two -i', () => {
    host.mergeStreams({
      videoInput: '/v.mp4',
      audioInput: '/a.mp3',
      output: '/out.mp4',
    })
    proc._close(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      [
        '-i',
        '/v.mp4',
        '-i',
        '/a.mp3',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        '-y',
        '/out.mp4',
      ],
      expect.any(Object)
    )
  })

  it('generateThumbnail: has -ss and -frames:v 1', () => {
    host.generateThumbnail({ input: '/in.mp4', output: '/thumb.jpg' })
    proc._close(0)
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-ss')
    expect(args).toContain('-frames:v')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args).toContain('-y')
  })

  it('generateThumbnail: default timestampSec is 1', () => {
    host.generateThumbnail({ input: '/in.mp4', output: '/thumb.jpg' })
    proc._close(0)
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[args.indexOf('-ss') + 1]).toBe('1')
  })

  it('generateThumbnail: -vf scale with both dimensions', () => {
    host.generateThumbnail({
      input: '/in.mp4',
      output: '/thumb.jpg',
      width: 320,
      height: 240,
    })
    proc._close(0)
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-vf')
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=320:240')
  })

  it('generateThumbnail: -1 for missing dimension', () => {
    host.generateThumbnail({
      input: '/in.mp4',
      output: '/thumb.jpg',
      width: 320,
    })
    proc._close(0)
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=320:-1')
  })
})

// ---------------------------------------------------------------------------
// Tests: FfmpegError
// ---------------------------------------------------------------------------

describe('FfmpegError', () => {
  it('is an instance of Error', () => {
    const e = new FfmpegError('test.code', 'msg')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(FfmpegError)
  })

  it('carries the code and message', () => {
    const e = new FfmpegError('plugin.ffmpeg.exit_nonzero', 'exit 1')
    expect(e.code).toBe('plugin.ffmpeg.exit_nonzero')
    expect(e.message).toBe('exit 1')
    expect(e.name).toBe('FfmpegError')
  })
})
