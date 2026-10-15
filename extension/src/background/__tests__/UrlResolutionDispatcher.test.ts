import type { UrlResolveResult } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import type { SiteAdapter } from '@/adapters/SiteAdapter'
import { BgAdapterRegistry } from '@/background/AdapterRegistry'
import {
  type TabsApi,
  UrlResolutionDispatcher,
  UrlResolutionError,
} from '@/background/UrlResolutionDispatcher'

function fakeAdapter(): SiteAdapter {
  return {
    id: 'youtube',
    version: '0.1.0',
    urlPatterns: ['*://*.youtube.com/*'],
    capabilities: ['resolve'],
    matchesUrl: () => true,
    probe: () => ({ handled: true }),
    resolve: async () => {
      throw new Error('not implemented')
    },
  }
}

function makeResult(): UrlResolveResult {
  return {
    selections: [
      {
        kind: 'direct',
        primary: {
          url: 'https://example.com/video.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
        quality: '720p',
      },
    ],
    meta: { title: 'placeholder' },
    extractedBy: {
      adapterId: 'youtube',
      adapterVersion: '0.1.0',
      extractedAt: Date.now(),
    },
  }
}

describe('UrlResolutionDispatcher', () => {
  it('returns the content script reply on happy path', async () => {
    const registry = new BgAdapterRegistry([fakeAdapter()])
    const expected = makeResult()
    const tabs: TabsApi = {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage: vi.fn(async () => expected),
    }
    const dispatcher = new UrlResolutionDispatcher({
      registry,
      tabs,
      timeoutMs: 1000,
    })

    const out = await dispatcher.resolve('https://www.youtube.com/watch?v=abc')
    expect(out).toBe(expected)
    expect(tabs.query).toHaveBeenCalledWith({
      url: ['*://*.youtube.com/*'],
    })
    expect(tabs.sendMessage).toHaveBeenCalledWith(42, {
      kind: 'content.resolve',
      payload: { url: 'https://www.youtube.com/watch?v=abc' },
    })
  })

  it('throws no-tab when no adapter matches the URL', async () => {
    const registry = new BgAdapterRegistry([])
    const tabs: TabsApi = {
      query: vi.fn(),
      sendMessage: vi.fn(),
    }
    const dispatcher = new UrlResolutionDispatcher({ registry, tabs })

    await expect(
      dispatcher.resolve('https://www.youtube.com/watch?v=abc')
    ).rejects.toMatchObject({ code: 'no-tab' })
    expect(tabs.query).not.toHaveBeenCalled()
  })

  it('throws no-tab when the matching adapter has no open tab', async () => {
    const registry = new BgAdapterRegistry([fakeAdapter()])
    const tabs: TabsApi = {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(),
    }
    const dispatcher = new UrlResolutionDispatcher({ registry, tabs })

    await expect(
      dispatcher.resolve('https://www.youtube.com/watch?v=abc')
    ).rejects.toMatchObject({ code: 'no-tab' })
    expect(tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('throws timeout when content script hangs past timeoutMs', async () => {
    const registry = new BgAdapterRegistry([fakeAdapter()])
    const tabs: TabsApi = {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage: vi.fn(() => new Promise(() => {})),
    }
    const dispatcher = new UrlResolutionDispatcher({
      registry,
      tabs,
      timeoutMs: 20,
    })

    await expect(
      dispatcher.resolve('https://www.youtube.com/watch?v=abc')
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('surfaces tab-error when content script responds with { error }', async () => {
    const registry = new BgAdapterRegistry([fakeAdapter()])
    const tabs: TabsApi = {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage: vi.fn(async () => ({ error: 'extraction failed' })),
    }
    const dispatcher = new UrlResolutionDispatcher({
      registry,
      tabs,
      timeoutMs: 1000,
    })

    await expect(
      dispatcher.resolve('https://www.youtube.com/watch?v=abc')
    ).rejects.toMatchObject({ code: 'tab-error' })
  })

  it('passes preferences through unchanged', async () => {
    const registry = new BgAdapterRegistry([fakeAdapter()])
    const tabs: TabsApi = {
      query: vi.fn(async () => [{ id: 42 }]),
      sendMessage: vi.fn(async () => makeResult()),
    }
    const dispatcher = new UrlResolutionDispatcher({
      registry,
      tabs,
      timeoutMs: 1000,
    })

    await dispatcher.resolve('https://www.youtube.com/watch?v=abc', {
      maxQuality: '1080p',
      includeAudio: true,
    })

    expect(tabs.sendMessage).toHaveBeenCalledWith(42, {
      kind: 'content.resolve',
      payload: {
        url: 'https://www.youtube.com/watch?v=abc',
        preferences: { maxQuality: '1080p', includeAudio: true },
      },
    })
  })
})

describe('UrlResolutionError', () => {
  it('carries a code property', () => {
    const e = new UrlResolutionError('x', 'timeout')
    expect(e.code).toBe('timeout')
    expect(e).toBeInstanceOf(UrlResolutionError)
  })
})
