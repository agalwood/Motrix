import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnLike } from './ytdlp-locator'
import {
  buildQualityFormat,
  createYtdlpMediaResolver,
  DEFAULT_YTDLP_FORMAT,
} from './ytdlp-resolver'

function fakeChild(stdoutJson: string, code: number | null = 0) {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  return {
    stdin: { end: vi.fn(), on: vi.fn() },
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
    expect(buildQualityFormat({ audioOnly: true }, true)).toBe(
      "bestaudio[protocol~='^https?$']/best[acodec!=none][protocol~='^https?$']"
    )
  })

  it('caps the video height in both the mux and progressive selectors', () => {
    expect(buildQualityFormat({ height: 1080 }, true)).toBe(
      "bv*[height<=1080][protocol~='^https?$']+ba[protocol~='^https?$']/b[height<=1080][protocol~='^https?$']"
    )
  })

  it('drops the video+audio pairs without a mux pipeline', () => {
    expect(buildQualityFormat({ height: 720 }, false)).toBe(
      "b[height<=720][protocol~='^https?$']"
    )
  })

  it('falls back to the defaults when the hint carries no constraint', () => {
    expect(buildQualityFormat({}, true)).toBe(DEFAULT_YTDLP_FORMAT)
    expect(buildQualityFormat({}, false)).toBe(
      "b[ext=mp4][protocol~='^https?$']/b[protocol~='^https?$']"
    )
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
      "--format bv*[height<=480][protocol~='^https?$']+ba[protocol~='^https?$']"
    )
    expect(seen[0]?.join(' ')).toContain(
      '--format-sort-force --format-sort height,vext:mp4,aext:m4a'
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
    expect(seen[0]?.join(' ')).toContain(
      "--format bestaudio[protocol~='^https?$']/best[acodec!=none][protocol~='^https?$']"
    )
    expect(resolution?.kind).toBe('direct')
    expect(seen[0]).not.toContain('--format-sort')
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

  it('selects progressive format when async isMuxAvailable resolves to false', async () => {
    const seen: string[][] = []
    const resolve = createYtdlpMediaResolver(
      {
        ...RESOLVER_DEPS,
        isMuxAvailable: async () => false,
        spawnImpl: spawnCapture(seen),
      },
      () => true
    )
    await resolve('https://x.example/watch?v=1', undefined)
    expect(seen[0]?.join(' ')).toContain(
      "--format b[ext=mp4][protocol~='^https?$']/b[protocol~='^https?$']"
    )
    expect(seen[0]).not.toContain('--format-sort')
  })
})

const smokeBinary = process.env.MOTRIX_YTDLP_SMOKE_BINARY
describe.skipIf(!smokeBinary)('actual yt-dlp quality ranking', () => {
  // Full extractor metadata over stdin keeps format selection offline.
  function format(
    id: string,
    height: number | null,
    ext: string,
    vcodec: string,
    acodec: string
  ) {
    return {
      format_id: id,
      height,
      ext,
      vcodec,
      acodec,
      protocol: 'https',
      url: `https://example.invalid/${id}`,
    }
  }
  const formats = [
    format('4k', 2160, 'webm', 'vp9', 'none'),
    format('hd-webm', 1080, 'webm', 'vp9', 'none'),
    format('hd-mp4', 1080, 'mp4', 'avc1', 'none'),
    format('audio', null, 'm4a', 'none', 'mp4a'),
    format('720', 720, 'webm', 'vp9', 'opus'),
    format('480', 480, 'mp4', 'avc1', 'mp4a'),
  ]

  it.each([
    { height: 2160, mux: true, selected: '4k+audio' },
    { height: 4320, mux: true, selected: '4k+audio' },
    { height: 1080, mux: true, selected: 'hd-mp4+audio' },
    { height: 1080, mux: false, selected: '720' },
  ])(
    'selects $selected for a $height cap with mux=$mux',
    async ({ height, mux, selected }) => {
      const seen: string[][] = []
      const resolve = createYtdlpMediaResolver(
        {
          ...RESOLVER_DEPS,
          isMuxAvailable: () => mux,
          spawnImpl: spawnCapture(seen),
        },
        () => true
      )
      await resolve('https://example.invalid/watch', undefined, {
        qualityHint: { height },
      })
      const args = seen[0]!
      args.splice(args.indexOf('--batch-file'), 2, '--load-info-json', '-')
      const result = spawnSync(smokeBinary!, args, {
        encoding: 'utf8',
        input: JSON.stringify({
          id: 'clip',
          title: 'clip',
          extractor: 'fixture',
          formats,
        }),
        timeout: 10_000,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).format_id).toBe(selected)
    }
  )
})
