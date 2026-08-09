import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubmitDownloadAdapter } from './submit-download-adapter'

describe('SubmitDownloadAdapter.adapt', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bridge-adapter-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  const baseInput = (): DownloadSubmitParams => ({
    source: {
      pageUrl: 'http://example.com/page',
      pageTitle: 'demo',
      detectedAt: 1,
    },
    selection: {
      kind: 'direct',
      primary: {
        url: 'http://example.com/file.mp4',
        headers: { 'X-Custom': 'v' },
        cookies: [
          {
            name: 'a',
            value: '1',
            domain: 'example.com',
            path: '/',
            secure: false,
            httpOnly: false,
            sameSite: 'unspecified',
          },
        ],
        refererPolicy: 'strict-origin-when-cross-origin',
      },
    },
    meta: {
      suggestedFilename: 'demo.mp4',
      qualityLabel: '720p',
    },
  })

  const adapter = (overrides: Partial<{ defaultSaveDir: string }> = {}) =>
    new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: overrides.defaultSaveDir ?? '/tmp/save',
      pickName: async (_dir, n) => n,
      mintTaskId: () => 'task-1',
    })

  it('happy path: validates, sanitizes, writes jar, returns adapted', async () => {
    const result = await adapter().adapt(baseInput(), {
      extensionId: 'e',
      browser: 'chromium',
    })
    expect(result.kind).toBe('direct')
    if (result.kind !== 'direct') throw new Error('expected direct')
    expect(result.taskId).toBe('task-1')
    expect(result.saveDir).toBe('/tmp/save')
    expect(result.finalName).toBe('demo.mp4')
    expect(result.jarPath).toContain('task-1')
    expect(result.sanitizedHeaders).toEqual({ 'X-Custom': 'v' })
    expect(result.sourceMeta.sessionKey).toBe('chromium:e')
  })

  it('rejects non-http(s) URL with invalid-url-scheme', async () => {
    const bad: DownloadSubmitParams = {
      ...baseInput(),
      selection: {
        kind: 'direct',
        primary: {
          url: 'file:///etc/passwd',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
      },
    }
    await expect(
      adapter().adapt(bad, { extensionId: 'e', browser: 'chromium' })
    ).rejects.toMatchObject({ code: 'invalid-url-scheme' })
  })

  it('sanitizes filename: control chars stripped, max 200', async () => {
    const input: DownloadSubmitParams = {
      ...baseInput(),
      meta: {
        ...baseInput().meta,
        suggestedFilename: 'a/b\\c<d>e:f"g|h?i*j\x00k.mp4',
      },
    }
    const result = await adapter().adapt(input, {
      extensionId: 'e',
      browser: 'chromium',
    })
    if (result.kind !== 'direct') throw new Error('expected direct')
    expect(result.finalName).toBe('a_b_c_d_e_f_g_h_i_j_k.mp4')
  })

  it('strips Cookie / Host / Content-Length from headers', async () => {
    const input: DownloadSubmitParams = {
      ...baseInput(),
      selection: {
        kind: 'direct',
        primary: {
          url: 'http://example.com/f.mp4',
          headers: { Cookie: 'a=1', Host: 'x', 'X-Keep': 'y' },
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
      },
    }
    const result = await adapter().adapt(input, {
      extensionId: 'e',
      browser: 'chromium',
    })
    if (result.kind !== 'direct') throw new Error('expected direct')
    expect(result.sanitizedHeaders).toEqual({ 'X-Keep': 'y' })
  })

  it('adapts an hls selection (was unsupported-kind)', async () => {
    const a = new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: '/tmp/save',
      pickName: async (_d, n) => n,
      mintTaskId: () => 't1',
    })
    const out = await a.adapt(
      {
        source: { pageUrl: 'https://h/p', pageTitle: 'P', detectedAt: 1 },
        selection: {
          kind: 'hls',
          primary: {
            url: 'https://h/v.m3u8',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
          container: 'mp4',
        },
        meta: {
          suggestedFilename: 'v.mp4',
          qualityLabel: 'auto',
          durationSec: 12,
        },
      },
      { extensionId: 'e', browser: 'chromium' }
    )
    expect(out.kind).toBe('hls')
    if (out.kind === 'hls') {
      expect(out.manifestUrl).toBe('https://h/v.m3u8')
      expect(out.container).toBe('mp4')
      expect(out.durationSec).toBe(12)
    }
  })

  it('adapts a dash selection', async () => {
    const a = new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: '/tmp/save',
      pickName: async (_d, n) => n,
      mintTaskId: () => 't1',
    })
    const out = await a.adapt(
      {
        source: { pageUrl: 'https://h/p', pageTitle: 'P', detectedAt: 1 },
        selection: {
          kind: 'dash',
          primary: {
            url: 'https://h/manifest.mpd',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
          container: 'mp4',
        },
        meta: {
          suggestedFilename: 'v.mp4',
          qualityLabel: 'auto',
          durationSec: 60,
        },
      },
      { extensionId: 'e', browser: 'chromium' }
    )
    expect(out.kind).toBe('dash')
    if (out.kind === 'dash') {
      expect(out.manifestUrl).toBe('https://h/manifest.mpd')
      expect(out.container).toBe('mp4')
      expect(out.sourceMeta.kind).toBe('dash')
    }
  })

  it('adapts a mux selection into video/audio urls', async () => {
    const a = new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: '/tmp/save',
      pickName: async (_d, n) => n,
      mintTaskId: () => 't1',
    })
    const r = {
      headers: {},
      cookies: [],
      refererPolicy: 'strict-origin-when-cross-origin',
    }
    const out = await a.adapt(
      {
        source: { pageUrl: 'https://h/p', pageTitle: 'P', detectedAt: 1 },
        selection: {
          kind: 'mux',
          video: { url: 'https://h/v.mp4', ...r },
          audio: { url: 'https://h/a.mp4', ...r },
          container: 'mp4',
        },
        meta: { suggestedFilename: 'v.mp4', qualityLabel: 'auto' },
      },
      { extensionId: 'e', browser: 'chromium' }
    )
    expect(out.kind).toBe('mux')
    if (out.kind === 'mux') {
      expect(out.videoUrl).toBe('https://h/v.mp4')
      expect(out.audioUrl).toBe('https://h/a.mp4')
    }
  })

  // The name handed to pickName must be the name that lands on disk —
  // extension included — or the dedup counter is computed against a string
  // that never exists ('Title' vs 'Title.mp4') and collisions slip through.
  it('hls: appends the container extension BEFORE the dedup pick', async () => {
    const picked: string[] = []
    const a = new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: '/tmp/save',
      pickName: async (_d, n) => {
        picked.push(n)
        return n
      },
      mintTaskId: () => 't1',
    })
    const out = await a.adapt(
      {
        source: { pageUrl: 'https://h/p', pageTitle: 'P', detectedAt: 1 },
        selection: {
          kind: 'hls',
          primary: {
            url: 'https://h/v.m3u8',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
          container: 'mp4',
        },
        meta: { suggestedFilename: 'My Show', qualityLabel: 'auto' },
      },
      { extensionId: 'e', browser: 'chromium' }
    )
    expect(picked).toEqual(['My Show.mp4'])
    if (out.kind === 'hls') expect(out.finalName).toBe('My Show.mp4')
  })

  it('mux: appends the container extension BEFORE the dedup pick (mkv)', async () => {
    const picked: string[] = []
    const a = new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: '/tmp/save',
      pickName: async (_d, n) => {
        picked.push(n)
        return n
      },
      mintTaskId: () => 't1',
    })
    const r = {
      headers: {},
      cookies: [],
      refererPolicy: 'strict-origin-when-cross-origin',
    }
    const out = await a.adapt(
      {
        source: { pageUrl: 'https://h/p', pageTitle: 'P', detectedAt: 1 },
        selection: {
          kind: 'mux',
          video: { url: 'https://h/v.mp4', ...r },
          audio: { url: 'https://h/a.mp4', ...r },
          container: 'mkv',
        },
        meta: { suggestedFilename: 'Some Title', qualityLabel: 'auto' },
      },
      { extensionId: 'e', browser: 'chromium' }
    )
    expect(picked).toEqual(['Some Title.mkv'])
    if (out.kind === 'mux') expect(out.finalName).toBe('Some Title.mkv')
  })

  it('mux: trusts an existing known media extension rather than double-appending', async () => {
    const picked: string[] = []
    const a = new SubmitDownloadAdapter({
      dataDir,
      defaultSaveDir: '/tmp/save',
      pickName: async (_d, n) => {
        picked.push(n)
        return n
      },
      mintTaskId: () => 't1',
    })
    const r = {
      headers: {},
      cookies: [],
      refererPolicy: 'strict-origin-when-cross-origin',
    }
    await a.adapt(
      {
        source: { pageUrl: 'https://h/p', pageTitle: 'P', detectedAt: 1 },
        selection: {
          kind: 'mux',
          video: { url: 'https://h/v.mp4', ...r },
          audio: { url: 'https://h/a.mp4', ...r },
          container: 'mp4',
        },
        meta: { suggestedFilename: 'movie.mkv', qualityLabel: 'auto' },
      },
      { extensionId: 'e', browser: 'chromium' }
    )
    expect(picked).toEqual(['movie.mkv'])
  })

  it('adapts a magnet selection without writing a cookie jar', async () => {
    const input: DownloadSubmitParams = {
      source: {
        pageUrl: 'https://example.com/p',
        pageTitle: 'demo',
        detectedAt: 1,
      },
      selection: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc&dn=Movie' },
      meta: { suggestedFilename: 'Movie', qualityLabel: 'file' },
    }
    const result = await adapter().adapt(input, {
      extensionId: 'e',
      browser: 'chromium',
    })
    expect(result.kind).toBe('magnet')
    if (result.kind === 'magnet') {
      expect(result.uri).toBe('magnet:?xt=urn:btih:abc&dn=Movie')
      expect(result.saveDir).toBe('/tmp/save')
      expect(result.sourceMeta.kind).toBe('magnet')
      expect(result.sourceMeta.sessionKey).toBe('chromium:e')
    }
  })

  it('persists sessionKey, pageUrl, qualityLabel, durationSec into sourceMeta', async () => {
    const input: DownloadSubmitParams = {
      ...baseInput(),
      meta: {
        ...baseInput().meta,
        durationSec: 360,
      },
    }
    const result = await adapter().adapt(input, {
      extensionId: 'e',
      browser: 'firefox',
    })
    expect(result.sourceMeta).toMatchObject({
      kind: 'direct',
      extensionId: 'e',
      browser: 'firefox',
      sessionKey: 'firefox:e',
      pageUrl: 'http://example.com/page',
      pageTitle: 'demo',
      qualityLabel: '720p',
      durationSec: 360,
    })
  })
})
