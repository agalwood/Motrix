import { describe, expect, it, vi } from 'vitest'
import {
  buildYtdlpFormatsArgs,
  createYtdlpFormatLister,
  parseFormatEntries,
} from './ytdlp-formats'
import type { SpawnLike } from './ytdlp-locator'

function fakeChild(
  chunks: { stdout?: string; stderr?: string },
  code: number | null = 0
) {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const stderrListeners: Array<(chunk: string) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  return {
    kill: vi.fn(),
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
    },
    emit() {
      for (const listener of stdoutListeners) listener(chunks.stdout ?? '')
      for (const listener of stderrListeners) listener(chunks.stderr ?? '')
      for (const listener of closeListeners) listener(code)
    },
  }
}

function spawnWith(child: ReturnType<typeof fakeChild>): SpawnLike {
  return (() => {
    setTimeout(() => child.emit(), 0)
    return child as never
  }) as SpawnLike
}

/** A spawning stub that counts how many real spawns actually happen. */
function countingSpawn(
  infoJson: string,
  counter: { count: number }
): SpawnLike {
  const impl = spawnWith(fakeChild({ stdout: infoJson }))
  return ((...args: Parameters<SpawnLike>) => {
    counter.count += 1
    return impl(...args)
  }) as SpawnLike
}

const INFO_JSON = JSON.stringify({
  title: 'Some Video',
  duration: 123.4,
  formats: [
    // 1080: mp4 direct + webm direct (mp4 wins) + storyboards + audio-only
    {
      height: 1080,
      ext: 'mp4',
      vcodec: 'avc1',
      protocol: 'https',
      tbr: 4500,
      filesize: 1000,
    },
    { height: 1080, ext: 'webm', vcodec: 'vp9', protocol: 'https', tbr: 5000 },
    { ext: 'mhtml', vcodec: 'none', protocol: 'https' },
    { ext: 'm4a', vcodec: 'none', protocol: 'https' },
    // 720: only an m3u8 (non-direct) pair
    {
      height: 720,
      ext: 'mp4',
      vcodec: 'avc1',
      protocol: 'm3u8_native',
      tbr: 2500,
    },
    // 480: two entries, same container → higher tbr wins
    { height: 480, ext: 'mp4', vcodec: 'avc1', protocol: 'https', tbr: 1200 },
    {
      height: 480,
      ext: 'mp4',
      vcodec: 'avc1',
      protocol: 'https',
      tbr: 1400,
      filesize_approx: 512,
    },
    // 240 without tbr
    { height: 240, ext: 'mp4', vcodec: 'avc1', protocol: 'https' },
    // Absurd height from a hostile extractor is dropped
    { height: 99999, ext: 'mp4', vcodec: 'avc1', protocol: 'https' },
  ],
})

describe('buildYtdlpFormatsArgs', () => {
  it('requests the info blob without a format selector and stops option parsing', () => {
    const args = buildYtdlpFormatsArgs('https://-evil.example/v')
    expect(args).toContain('--dump-single-json')
    expect(args).not.toContain('--format')
    expect(args[args.length - 1]).toBe('https://-evil.example/v')
    expect(args[args.length - 2]).toBe('--')
  })

  it('passes proxy and cookies through', () => {
    const args = buildYtdlpFormatsArgs('https://x.example/v', {
      proxy: 'http://127.0.0.1:7890',
      cookieHeader: 'a=b',
    })
    expect(args.join(' ')).toContain('--proxy http://127.0.0.1:7890')
    expect(args.join(' ')).toContain('--add-header Cookie:a=b')
  })
})

describe('parseFormatEntries', () => {
  it('collapses to one row per height, preferring direct mp4, sorted desc', () => {
    const entries = parseFormatEntries(JSON.parse(INFO_JSON))
    expect(entries.map((e) => e.key)).toEqual(['1080p', '720p', '480p', '240p'])
    const top = entries[0]
    expect(top.kind).toBe('video')
    expect(top.ext).toBe('mp4')
    expect(top.fps).toBeUndefined()
    expect(top.sizeBytes).toBe(1000)
    // 480: the higher-tbr duplicate won and brought its approx size along
    expect(entries[2]?.sizeBytes).toBe(512)
  })

  it('returns an empty list when nothing usable is present', () => {
    expect(parseFormatEntries({})).toEqual([])
    expect(parseFormatEntries({ formats: [] })).toEqual([])
    expect(
      parseFormatEntries({ formats: [{ ext: 'm4a', vcodec: 'none' }] })
    ).toEqual([])
  })
})

function makeLister(
  overrides: Partial<Parameters<typeof createYtdlpFormatLister>[0]> = {}
) {
  return createYtdlpFormatLister({
    resolveBinaryPath: async () => '/usr/bin/yt-dlp',
    isMediaSite: () => true,
    ...overrides,
  })
}

describe('createYtdlpFormatLister', () => {
  it('lists entries and synthesizes the MP3 row when FFmpeg is available', async () => {
    const lister = makeLister({
      spawnImpl: spawnWith(fakeChild({ stdout: INFO_JSON })),
    })
    const result = await lister({
      url: 'https://x.example/v',
      audioExtractAvailable: true,
    })
    expect(result.available).toBe(true)
    expect(result.title).toBe('Some Video')
    expect(result.durationSec).toBe(123.4)
    expect(result.entries).toHaveLength(5)
    const mp3 = result.entries.at(-1)
    expect(mp3).toEqual({ key: 'mp3', kind: 'audio', label: 'MP3' })
  })

  it('omits the MP3 row without FFmpeg', async () => {
    const lister = makeLister({
      spawnImpl: spawnWith(fakeChild({ stdout: INFO_JSON })),
    })
    const result = await lister({
      url: 'https://x.example/v',
      audioExtractAvailable: false,
    })
    expect(result.entries.every((e) => e.key !== 'mp3')).toBe(true)
  })

  it('reports policy gates without spawning anything', async () => {
    const spawnImpl = vi.fn() as unknown as SpawnLike
    const disabled = makeLister({
      spawnImpl,
      readOptions: () => ({ enabled: false }),
    })
    expect(
      await disabled({
        url: 'https://x.example/v',
        audioExtractAvailable: false,
      })
    ).toEqual({
      available: false,
      reason: 'disabled',
      entries: [],
    })
    const offAllowlist = makeLister({
      spawnImpl,
      readOptions: () => ({ enabled: true, allUrls: false }),
      isMediaSite: () => false,
    })
    expect(
      await offAllowlist({
        url: 'https://x.example/v',
        audioExtractAvailable: false,
      })
    ).toMatchObject({ available: false, reason: 'not-allowed' })
    const noBinary = makeLister({
      spawnImpl,
      resolveBinaryPath: async () => null,
    })
    expect(
      await noBinary({
        url: 'https://x.example/v',
        audioExtractAvailable: false,
      })
    ).toMatchObject({ available: false, reason: 'binary-missing' })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('maps an unsupported site error to a graceful unavailable result', async () => {
    const lister = makeLister({
      spawnImpl: spawnWith(
        fakeChild({ stderr: 'ERROR: Unsupported URL: https://x.example/v' }, 1)
      ),
    })
    expect(
      await lister({ url: 'https://x.example/v', audioExtractAvailable: false })
    ).toEqual({ available: false, reason: 'unsupported', entries: [] })
  })

  it('caches per url+cookies and dedupes concurrent asks', async () => {
    const counter = { count: 0 }
    const spawnImpl = countingSpawn(INFO_JSON, counter)
    let now = 1_000
    const lister = makeLister({ spawnImpl, now: () => now })
    const req = { url: 'https://x.example/v', audioExtractAvailable: true }
    const [a, b] = await Promise.all([lister(req), lister(req)])
    expect(counter.count).toBe(1)
    expect(a).toBe(b)
    await lister(req)
    expect(counter.count).toBe(1)
    // A different cookie header is a different resource.
    await lister({ ...req, cookieHeader: 'sid=1' })
    expect(counter.count).toBe(2)
    // TTL expiry refetches.
    now += 61_000
    await lister({ ...req, cookieHeader: 'sid=1' })
    expect(counter.count).toBe(3)
  })

  it('clearCache drops the cached listing', async () => {
    const counter = { count: 0 }
    const lister = makeLister({ spawnImpl: countingSpawn(INFO_JSON, counter) })
    const req = { url: 'https://x.example/v', audioExtractAvailable: false }
    await lister(req)
    lister.clearCache()
    await lister(req)
    expect(counter.count).toBe(2)
  })
})
