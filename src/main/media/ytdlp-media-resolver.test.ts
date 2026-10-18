import { EventEmitter } from 'node:events'
import { mediaSettingsSchema } from '@shared/schemas/media-settings'
import { proxySettingsSchema } from '@shared/schemas/proxy-settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createShellYtdlpResolver,
  proxyUrlForDownload,
} from './ytdlp-media-resolver'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}))

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      stdin: { on: vi.fn(), end: vi.fn() },
    })
    child.stdin.end.mockImplementation(() =>
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          JSON.stringify({
            formats: [
              {
                url: 'https://cdn.test/v720.mp4',
                height: 720,
                vcodec: 'h264',
                acodec: 'aac',
              },
              {
                url: 'https://cdn.test/v1080.mp4',
                height: 1080,
                vcodec: 'h264',
                acodec: 'none',
              },
              { url: 'https://cdn.test/a.m4a', vcodec: 'none', acodec: 'aac' },
            ],
          })
        )
        child.emit('close', 0)
      })
    )
    return child
  })
})

const req = {
  url: 'https://www.youtube.com/watch?v=fixture',
  audioExtractAvailable: true,
  muxAvailable: true,
}

function fixture() {
  const media = mediaSettingsSchema.parse({
    ytdlpEnabled: true,
    ytdlpBinaryPath: '/fixture/old',
  })
  const proxy = proxySettingsSchema.parse({})
  const isMuxAvailable = vi.fn(async () => false)
  const locate = vi.fn(async () => ({
    available: true,
    binaryPath: '/fixture/yt-dlp',
    version: '2026.10.17',
  }))
  const resolver = createShellYtdlpResolver({
    getMediaSettings: () => media,
    getProxySettings: () => proxy,
    isMuxAvailable,
    locate,
  })
  return { resolver, media, proxy, isMuxAvailable, locate }
}

describe('shell public extraction boundary', () => {
  it('uses the shared IPv6 proxy encoding without dropping password-only authentication', () => {
    const proxy = proxySettingsSchema.parse({
      enabled: true,
      host: '::1',
      protocol: 'socks5',
      port: 1080,
      scopes: { download: true },
    })
    expect(proxyUrlForDownload(proxy)).toBe('socks5://[::1]:1080')
    proxy.password = 'secret'
    expect(new URL(proxyUrlForDownload(proxy) ?? '').password).toBe('secret')
  })

  it('declines Cookie input before capability probing or executable lookup', async () => {
    const f = fixture()
    const result = await f.resolver.listFormats({
      ...req,
      cookies: [
        {
          name: 'SID',
          value: 'secret',
          domain: '.youtube.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
        },
      ],
    })
    expect(result).toMatchObject({ reason: 'credentials-unsupported' })
    expect(f.isMuxAvailable).not.toHaveBeenCalled()
    expect(f.locate).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not offer mux/MP3 when the actual pipeline is absent despite an FFmpeg hint', async () => {
    const f = fixture()
    const result = await f.resolver.listFormats(req)
    expect(result.entries.map((entry) => entry.key)).toEqual(['720p'])
    expect(f.isMuxAvailable).toHaveBeenCalledOnce()
  })

  it('honors settings changes during capability lookup', async () => {
    const f = fixture()
    f.isMuxAvailable.mockImplementation(async () => {
      f.media.ytdlpEnabled = false
      return true
    })
    expect(await f.resolver.listFormats(req)).toMatchObject({
      reason: 'disabled',
    })
    expect(f.locate).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not execute a location found for a replaced configuration', async () => {
    const f = fixture()
    f.locate.mockImplementation(async () => {
      f.media.ytdlpBinaryPath = '/fixture/new'
      return {
        available: true,
        binaryPath: '/fixture/old',
        version: '2026.10.17',
      }
    })
    expect(await f.resolver.listFormats(req)).toMatchObject({
      reason: 'binary-missing',
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not execute an old binary after configuration changes during mux probing', async () => {
    const f = fixture()
    f.isMuxAvailable.mockImplementation(async () => {
      f.media.ytdlpBinaryPath = '/fixture/replaced'
      return true
    })
    expect(await f.resolver.resolve(req.url)).toBeNull()
    expect(f.locate).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('declines an active proxy bypass list without changing global routing or probing', async () => {
    const f = fixture()
    Object.assign(f.proxy, {
      enabled: true,
      host: 'proxy.test',
      bypass: ['*.private.test'],
    })
    f.proxy.scopes.download = true
    expect(await f.resolver.listFormats(req)).toMatchObject({
      reason: 'proxy-bypass-unsupported',
    })
    expect(await f.resolver.resolve(req.url)).toBeNull()
    expect(f.isMuxAvailable).not.toHaveBeenCalled()
    expect(f.locate).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(f.proxy.bypass).toEqual(['*.private.test'])
  })

  it('does not silently bypass an authenticated download proxy', async () => {
    const f = fixture()
    Object.assign(f.proxy, {
      enabled: true,
      host: 'proxy.test',
      user: 'operator',
      password: 'SECRET',
    })
    f.proxy.scopes.download = true
    expect(await f.resolver.listFormats(req)).toMatchObject({
      reason: 'proxy-credentials-unsupported',
    })
    expect(await f.resolver.resolve(req.url)).toBeNull()
    expect(f.locate).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
