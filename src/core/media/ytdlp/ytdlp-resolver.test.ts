import { describe, expect, it, vi } from 'vitest'
import type { MediaResolution } from './media-resolver'
import type { SpawnLike } from './ytdlp-locator'
import {
  containerForFormats,
  createYtdlpMediaResolver,
  looksUnsupported,
  mapYtdlpInfo,
  resolveWithYtdlp,
} from './ytdlp-resolver'

function fakeChild(
  chunks: { stdout?: string; stderr?: string },
  code: number | null = 0
) {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const stderrListeners: Array<(chunk: string) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  const kill = vi.fn()
  return {
    kill,
    stdout: {
      on: (_event: string, listener: (chunk: string) => void) =>
        void stdoutListeners.push(listener),
    },
    stderr: {
      on: (_event: string, listener: (chunk: string) => void) =>
        void stderrListeners.push(listener),
    },
    on: (event: string, listener: (arg: never) => void) => {
      if (event === 'close') closeListeners.push(listener as never)
      if (event === 'error') errorListeners.push(listener as never)
    },
    emitStdout() {
      for (const listener of stdoutListeners) listener(chunks.stdout ?? '')
    },
    emitStderr() {
      for (const listener of stderrListeners) listener(chunks.stderr ?? '')
    },
    emitClose() {
      for (const listener of closeListeners) listener(code)
    },
    emitError(error: Error) {
      for (const listener of errorListeners) listener(error)
    },
  }
}

function spawnWith(child: ReturnType<typeof fakeChild>): SpawnLike {
  return (() => {
    // Defer emissions to the caller so the resolver has attached listeners.
    setTimeout(() => {
      child.emitStdout()
      child.emitStderr()
      child.emitClose()
    }, 0)
    return child as never
  }) as SpawnLike
}

describe('containerForFormats', () => {
  it('picks mp4 for an mp4/m4a pair', () => {
    expect(containerForFormats('mp4', 'm4a')).toBe('mp4')
  })

  it('picks mkv when either stream is webm', () => {
    expect(containerForFormats('webm', 'webm')).toBe('mkv')
    expect(containerForFormats('mp4', 'webm')).toBe('mkv')
  })

  it('picks mkv when a stream reports no extension', () => {
    expect(containerForFormats(undefined, 'webm')).toBe('mkv')
  })
})

describe('mapYtdlpInfo', () => {
  it('maps separate video and audio streams to a mux resolution', () => {
    const resolution = mapYtdlpInfo({
      title: 'Big Buck Bunny',
      duration: 596,
      http_headers: { 'User-Agent': 'Motrix' },
      requested_formats: [
        {
          url: 'https://video.example/137.mp4',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'none',
          http_headers: { Referer: 'https://example/watch' },
        },
        {
          url: 'https://audio.example/140.m4a',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a',
        },
      ],
    })
    expect(resolution).toMatchObject({
      kind: 'mux',
      videoUrl: 'https://video.example/137.mp4',
      audioUrl: 'https://audio.example/140.m4a',
      container: 'mp4',
      title: 'Big Buck Bunny',
      durationSec: 596,
      headers: {
        Referer: 'https://example/watch',
        'User-Agent': 'Motrix',
      },
    })
  })

  it('maps a progressive single stream to a direct resolution', () => {
    const resolution = mapYtdlpInfo({
      title: 'Clip',
      ext: 'mp4',
      url: 'https://cdn.example/clip.mp4',
      vcodec: 'avc1',
      acodec: 'mp4a',
    })
    expect(resolution).toEqual({
      kind: 'direct',
      url: 'https://cdn.example/clip.mp4',
      filename: 'Clip.mp4',
      title: 'Clip',
      headers: undefined,
      durationSec: undefined,
    })
  })

  it('returns null for a manifest protocol that no direct pipeline can fetch', () => {
    expect(
      mapYtdlpInfo({
        title: 'Stream',
        url: 'https://cdn.example/live.m3u8',
        requested_formats: [
          {
            url: 'https://cdn.example/live.m3u8',
            protocol: 'm3u8_native',
            vcodec: 'avc1',
            acodec: 'mp4a',
          },
        ],
      })
    ).toBeNull()
  })

  it('returns null for top-level m3u8_native protocol without requested_formats', () => {
    expect(
      mapYtdlpInfo({
        title: 'HLS clip',
        ext: 'mp4',
        url: 'https://cdn.example/video.m3u8',
        protocol: 'm3u8_native',
      })
    ).toBeNull()
  })

  it('declines multi-stream result when one stream has an unsupported protocol (does not drop audio)', () => {
    expect(
      mapYtdlpInfo({
        title: 'Multi clip',
        requested_formats: [
          {
            url: 'https://video.example/137.mp4',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'none',
            protocol: 'https',
          },
          {
            url: 'https://audio.example/140.m3u8',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a',
            protocol: 'm3u8_native',
          },
        ],
      })
    ).toBeNull()
  })
})

describe('looksUnsupported', () => {
  it('recognises extractor and DRM refusals', () => {
    expect(looksUnsupported('ERROR: Unsupported URL: https://x')).toBe(true)
    expect(looksUnsupported('ERROR: This video is DRM protected')).toBe(true)
  })

  it('treats transient network errors as retryable failures', () => {
    expect(looksUnsupported('ERROR: timed out')).toBe(false)
  })
})

describe('resolveWithYtdlp', () => {
  it('passes the URL after `--` so it cannot inject extra flags', async () => {
    const child = fakeChild({ stdout: '{}', stderr: '' })
    const spawn = vi.fn((() => {
      setTimeout(() => {
        child.emitStdout()
        child.emitClose()
      }, 0)
      return child as never
    }) as SpawnLike)
    await resolveWithYtdlp('https://youtube.com/watch?v=--proxy', {
      binaryPath: 'yt-dlp',
      cookieHeader: 'CONSENT=yes',
      spawnImpl: spawn,
    })
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]]
    expect(args).toContain('--')
    expect(args.at(-1)).toBe('https://youtube.com/watch?v=--proxy')
    expect(args).toContain('--add-header')
    expect(args).toContain('Cookie:CONSENT=yes')
    expect(args).toContain('--no-playlist')
  })

  it('resolves a mux pair and reports the container', async () => {
    const payload = JSON.stringify({
      title: 'Video',
      duration: 12,
      requested_formats: [
        {
          url: 'https://v.example/v.mp4',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'none',
        },
        {
          url: 'https://a.example/a.m4a',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a',
        },
      ],
    })
    const child = fakeChild({ stdout: payload, stderr: '' })
    const outcome = await resolveWithYtdlp('https://youtube.com/watch?v=x', {
      binaryPath: 'yt-dlp',
      spawnImpl: spawnWith(child),
    })
    expect(outcome).toMatchObject({
      status: 'resolved',
      resolution: {
        kind: 'mux',
        container: 'mp4',
        videoUrl: 'https://v.example/v.mp4',
        audioUrl: 'https://a.example/a.m4a',
        durationSec: 12,
      },
    })
  })

  it('reports unsupported when the extractor refuses the URL', async () => {
    const child = fakeChild(
      {
        stdout: '',
        stderr: 'ERROR: Unsupported URL: https://example.com/x',
      },
      1
    )
    const outcome = await resolveWithYtdlp('https://example.com/x', {
      binaryPath: 'yt-dlp',
      spawnImpl: spawnWith(child),
    })
    expect(outcome).toEqual({
      status: 'unsupported',
      reason: 'ERROR: Unsupported URL: https://example.com/x',
    })
  })

  it('reports failed on a non-zero exit that is not a refusal', async () => {
    const child = fakeChild(
      { stdout: '', stderr: 'ERROR: could not solve DNS' },
      1
    )
    const outcome = await resolveWithYtdlp('https://youtube.com/watch?v=x', {
      binaryPath: 'yt-dlp',
      spawnImpl: spawnWith(child),
    })
    expect(outcome.status).toBe('failed')
  })
})

describe('createYtdlpMediaResolver', () => {
  const isMediaSite = (url: string) => url.includes('youtube.com')

  it('skips non-media URLs under the default policy', async () => {
    const resolveBinaryPath = vi.fn(async () => '/usr/bin/yt-dlp')
    const resolver = createYtdlpMediaResolver(
      { resolveBinaryPath },
      isMediaSite
    )
    expect(await resolver('https://example.com/file.zip')).toBeNull()
    expect(resolveBinaryPath).not.toHaveBeenCalled()
  })

  it('resolves media URLs when enabled and configured', async () => {
    const child = fakeChild({
      stdout: JSON.stringify({
        title: 'T',
        url: 'https://cdn.example/t.mp4',
        ext: 'mp4',
      }),
      stderr: '',
    })
    const resolver = createYtdlpMediaResolver(
      {
        resolveBinaryPath: async () => '/usr/bin/yt-dlp',
        readOptions: () => ({ enabled: true }),
        spawnImpl: spawnWith(child),
      },
      isMediaSite
    )
    const resolution: MediaResolution | null = await resolver(
      'https://youtube.com/watch?v=x'
    )
    expect(resolution?.kind).toBe('direct')
  })

  it('stays silent when yt-dlp is not installed', async () => {
    const resolver = createYtdlpMediaResolver(
      { resolveBinaryPath: async () => null },
      isMediaSite
    )
    expect(await resolver('https://youtube.com/watch?v=x')).toBeNull()
  })

  it('stays silent when disabled in Settings', async () => {
    const resolver = createYtdlpMediaResolver(
      {
        resolveBinaryPath: async () => '/usr/bin/yt-dlp',
        readOptions: () => ({ enabled: false }),
      },
      isMediaSite
    )
    expect(await resolver('https://youtube.com/watch?v=x')).toBeNull()
  })
})
