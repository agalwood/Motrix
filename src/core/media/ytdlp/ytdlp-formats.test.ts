import { EventEmitter } from 'node:events'
import { MediaFormatsResultSchema } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import {
  buildYtdlpFormatsArgs,
  createYtdlpFormatLister,
  parseFormatEntries,
} from './ytdlp-formats'
import type { SpawnLike } from './ytdlp-locator'

const progressive = {
  url: 'https://cdn.example/video.mp4',
  height: 720,
  ext: 'mp4',
  vcodec: 'h264',
  acodec: 'aac',
  protocol: 'https',
  filesize: 1000,
}
const videoOnly = { ...progressive, height: 1080, acodec: 'none' }
const audio = {
  url: 'https://cdn.example/audio.m4a',
  vcodec: 'none',
  acodec: 'aac',
  protocol: 'https',
}
const info = {
  title: 'Fixture',
  duration: 12,
  formats: [progressive, videoOnly, audio],
}
const req = {
  url: 'https://media.example/watch?token=synthetic',
  audioExtractAvailable: true,
}

function spawnResult(value: unknown, code = 0, stderr = '') {
  const inputs: string[] = []
  const spawn = vi.fn(() => {
    const child = new EventEmitter()
    const stdout = new EventEmitter()
    const err = new EventEmitter()
    return Object.assign(child, {
      stdout,
      stderr: err,
      stdin: {
        on: vi.fn(),
        end: (input: string) => {
          inputs.push(input)
          queueMicrotask(() => {
            stdout.emit('data', JSON.stringify(value))
            err.emit('data', stderr)
            child.emit('close', code)
          })
        },
      },
      kill: vi.fn(() => child.emit('close', null)),
    })
  })
  return { spawn: spawn as unknown as SpawnLike, spy: spawn, inputs }
}

function makeLister(
  overrides: Partial<Parameters<typeof createYtdlpFormatLister>[0]> = {}
) {
  return createYtdlpFormatLister({
    resolveBinaryPath: async () => '/fixture/yt-dlp',
    readOptions: () => ({ enabled: true }),
    isMediaSite: () => true,
    ...overrides,
  })
}

describe('public format extraction', () => {
  it('checks and executes the same canonical URL authority', async () => {
    const child = spawnResult(info)
    const isMediaSite = vi.fn(
      (url: string) => new URL(url).hostname === 'youtube.com'
    )
    const lister = makeLister({ spawnImpl: child.spawn, isMediaSite })
    const url = 'http://youtube.com\\@127.0.0.1:1234/clip.mp4'
    await lister({ ...req, url })
    expect(isMediaSite).toHaveBeenCalledWith(
      'http://youtube.com/@127.0.0.1:1234/clip.mp4'
    )
    expect(child.inputs).toEqual([
      'http://youtube.com/@127.0.0.1:1234/clip.mp4\n',
    ])
  })

  it('disables ambient configuration and credentials and keeps URLs out of argv', async () => {
    const child = spawnResult(info)
    const result = await makeLister({ spawnImpl: child.spawn })(req)
    expect(MediaFormatsResultSchema.safeParse(result).success).toBe(true)
    expect(result.entries.map((entry) => entry.key)).toEqual([
      '1080p',
      '720p',
      'mp3',
    ])
    const args = buildYtdlpFormatsArgs(req.url)
    for (const option of [
      '--ignore-config',
      '--no-config-locations',
      '--no-cookies',
      '--no-cookies-from-browser',
      '--no-cache-dir',
      '--no-plugin-dirs',
      '--no-remote-components',
      '--skip-download',
      '--batch-file',
    ])
      expect(args).toContain(option)
    expect(args[args.indexOf('--proxy') + 1]).toBe('')
    expect(args.join(' ')).not.toContain('synthetic')
    expect(args).not.toContain('--format')
    expect(child.inputs).toEqual([`${req.url}\n`])
  })

  it('rejects credential cookies and authenticated proxies before binary lookup', async () => {
    const resolveBinaryPath = vi.fn(async () => '/fixture/yt-dlp')
    const child = spawnResult(info)
    const lister = makeLister({ resolveBinaryPath, spawnImpl: child.spawn })
    expect(
      await lister({
        ...req,
        cookies: [
          {
            name: 'SID',
            value: 'secret',
            domain: 'media.example',
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
          },
        ],
      })
    ).toEqual({
      available: false,
      reason: 'credentials-unsupported',
      entries: [],
    })
    const proxied = makeLister({
      resolveBinaryPath,
      spawnImpl: child.spawn,
      readOptions: () => ({
        enabled: true,
        proxy: 'http://user:secret@proxy.example:8080',
      }),
    })
    expect(await proxied(req)).toMatchObject({
      available: false,
      reason: 'proxy-credentials-unsupported',
    })
    expect(resolveBinaryPath).not.toHaveBeenCalled()
    expect(child.spy).not.toHaveBeenCalled()
  })

  it('does not cache or coalesce calls and rechecks disabled/site policy', async () => {
    const child = spawnResult(info)
    let enabled = true
    let allowed = true
    const lister = makeLister({
      spawnImpl: child.spawn,
      readOptions: () => ({ enabled }),
      isMediaSite: () => allowed,
    })
    await Promise.all([lister(req), lister(req)])
    expect(child.spy).toHaveBeenCalledTimes(2)
    enabled = false
    expect(await lister(req)).toMatchObject({ reason: 'disabled' })
    enabled = true
    allowed = false
    expect(await lister(req)).toMatchObject({ reason: 'not-allowed' })
    expect(child.spy).toHaveBeenCalledTimes(2)
  })

  it('rechecks policy and cancellation after asynchronous lookup', async () => {
    const child = spawnResult(info)
    let enabled = true
    const lister = makeLister({
      spawnImpl: child.spawn,
      readOptions: () => ({ enabled }),
      resolveBinaryPath: async () => {
        enabled = false
        return '/fixture/yt-dlp'
      },
    })
    expect(await lister(req)).toMatchObject({ reason: 'disabled' })
    const controller = new AbortController()
    const cancelled = makeLister({
      spawnImpl: child.spawn,
      resolveBinaryPath: async () => {
        controller.abort('SECRET')
        return '/fixture/yt-dlp'
      },
    })
    await expect(cancelled(req, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Media extraction cancelled',
    })
    expect(child.spy).not.toHaveBeenCalled()
  })

  it('requires a real audio source and pipeline; empty media stays unavailable', async () => {
    const child = spawnResult({ formats: [videoOnly] })
    const result = await makeLister({ spawnImpl: child.spawn })(req)
    expect(result).toEqual({
      available: false,
      reason: 'unsupported',
      entries: [],
    })
    const full = spawnResult(info)
    const noMux = await makeLister({ spawnImpl: full.spawn })({
      ...req,
      audioExtractAvailable: false,
      muxAvailable: false,
    })
    expect(noMux.entries.map((entry) => entry.key)).toEqual(['720p'])
    expect(
      parseFormatEntries({
        formats: [{ ...progressive, protocol: 'm3u8_native' }],
      })
    ).toEqual([])
  })

  it('normalizes hostile metadata and never reports video-only bytes as total size', async () => {
    const raw = {
      title: '界'.repeat(501),
      duration: -1,
      formats: [
        videoOnly,
        audio,
        { ...progressive, fps: 1001, ext: '../secret', filesize: 1e30 },
        { ...progressive, height: 99 },
        { ...progressive, height: 4321 },
        null,
      ],
    }
    const child = spawnResult(raw)
    const result = await makeLister({ spawnImpl: child.spawn })(req)
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.title).toHaveLength(500)
    expect(result.durationSec).toBeUndefined()
    expect(result.entries.map((entry) => entry.key)).toEqual([
      '1080p',
      '720p',
      'mp3',
    ])
    expect(result.entries[0]?.sizeBytes).toBeUndefined()
    expect(result.entries[1]).toEqual({
      key: '720p',
      kind: 'video',
      label: '720p',
      height: 720,
    })
    expect(MediaFormatsResultSchema.safeParse(result).success).toBe(true)
  })

  it('reports only bounded safe reasons from extractor failures', async () => {
    const child = spawnResult(
      {},
      1,
      'ERROR: Unsupported URL: https://secret.example/?token=SECRET'
    )
    expect(await makeLister({ spawnImpl: child.spawn })(req)).toEqual({
      available: false,
      reason: 'unsupported',
      entries: [],
    })
    expect(
      await makeLister({ resolveBinaryPath: async () => null })(req)
    ).toMatchObject({ reason: 'binary-missing' })
  })
})
