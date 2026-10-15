import { describe, expect, it, vi } from 'vitest'
import type { SpawnLike } from './ytdlp-locator'
import { buildQualityFormat, createYtdlpMediaResolver } from './ytdlp-resolver'

function fakeChild(stdoutJson: string, code: number | null = 0) {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  return {
    kill: vi.fn(),
    stdout: {
      on: (_event: string, listener: (chunk: string) => void) =>
        void stdoutListeners.push(listener),
    },
    stderr: { on: vi.fn() },
    on: (event: string, listener: (arg: never) => void) => {
      if (event === 'close') closeListeners.push(listener as never)
    },
    emit() {
      for (const listener of stdoutListeners) listener(stdoutJson)
      for (const listener of closeListeners) listener(code)
    },
  }
}

function spawnCapture(seen: string[][]) {
  return ((_binaryPath: string, args: string[]) => {
    seen.push(args)
    const child = fakeChild(
      JSON.stringify({
        url: 'https://cdn.example/stream.mp4',
        ext: 'mp4',
        vcodec: 'avc1',
        acodec: 'aac',
      })
    )
    setTimeout(() => child.emit(), 0)
    return child as never
  }) as unknown as SpawnLike
}

const RESOLVER_DEPS = {
  resolveBinaryPath: async () => '/usr/bin/yt-dlp',
  readOptions: () => ({ enabled: true }),
  isMuxAvailable: () => true,
}

describe('buildQualityFormat', () => {
  it('uses bestaudio for an audio-only hint', () => {
    expect(buildQualityFormat({ audioOnly: true }, true)).toBe('bestaudio/best')
  })

  it('caps the height and prefers mp4/m4a when a mux is possible', () => {
    expect(buildQualityFormat({ height: 1080 }, true)).toBe(
      'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080][ext=mp4]/b[height<=1080]/b'
    )
  })

  it('drops the video+audio pairs without a mux pipeline', () => {
    expect(buildQualityFormat({ height: 720 }, false)).toBe(
      'b[height<=720][ext=mp4]/b[height<=720]/b'
    )
  })

  it('falls back to the defaults when the hint carries no constraint', () => {
    expect(buildQualityFormat({}, true)).toBe('bv*+ba/b')
    expect(buildQualityFormat({}, false)).toBe('b[ext=mp4]/b')
  })
})

describe('createYtdlpMediaResolver quality hint', () => {
  it('passes the hint-derived selector to yt-dlp', async () => {
    const seen: string[][] = []
    const resolve = createYtdlpMediaResolver(
      { ...RESOLVER_DEPS, spawnImpl: spawnCapture(seen) },
      () => true
    )
    const resolution = await resolve('https://x.example/watch?v=1', undefined, {
      qualityHint: { height: 480 },
    })
    expect(resolution).not.toBeNull()
    expect(seen[0]?.join(' ')).toContain(
      '--format bv*[height<=480][ext=mp4]+ba[ext=m4a]'
    )
  })

  it('uses bestaudio for audioOnly and single-format resolutions stay direct', async () => {
    const seen: string[][] = []
    const resolve = createYtdlpMediaResolver(
      { ...RESOLVER_DEPS, spawnImpl: spawnCapture(seen) },
      () => true
    )
    const resolution = await resolve('https://x.example/watch?v=1', undefined, {
      qualityHint: { audioOnly: true },
    })
    expect(seen[0]?.join(' ')).toContain('--format bestaudio/best')
    expect(resolution?.kind).toBe('direct')
  })

  it('ignores the hint when disabled or off the allowlist', async () => {
    const seen: string[][] = []
    const disabled = createYtdlpMediaResolver(
      {
        ...RESOLVER_DEPS,
        spawnImpl: spawnCapture(seen),
        readOptions: () => ({ enabled: false }),
      },
      () => true
    )
    expect(
      await disabled('https://x.example/v', undefined, {
        qualityHint: { height: 720 },
      })
    ).toBeNull()
    const offAllowlist = createYtdlpMediaResolver(
      { ...RESOLVER_DEPS, spawnImpl: spawnCapture(seen) },
      () => false
    )
    expect(
      await offAllowlist('https://x.example/v', undefined, {
        qualityHint: { height: 720 },
      })
    ).toBeNull()
    expect(seen).toHaveLength(0)
  })
})
