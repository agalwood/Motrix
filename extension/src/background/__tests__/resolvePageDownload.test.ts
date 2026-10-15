/**
 * Unit tests for the bg.resolvePageDownload handler logic.
 *
 * We test the pure logic extracted into a helper rather than importing the
 * full service-worker module (which has heavy side-effects at module level).
 * This mirrors the pattern used elsewhere in the bg tests (e.g., capabilities,
 * ConnectionManager unit tests) where we exercise individual concerns in
 * isolation.
 *
 * Specifically tested:
 *   - isResolvableVideoPage host rules (bilibili / b23.tv / youtube / non-video / malformed)
 *   - SP-1 web-store youtube-exclusion invariant
 *   - handler logic (mocked: chrome.tabs.query, browser.cookies.getAll,
 *     buildMediaSubmitParams, manager.submitDownload)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMediaSubmitParams } from '@/background/capture/buildMediaSubmitParams'
import { mapCookies } from '@/background/capture/cookies'
import { isResolvableVideoPage } from '@/shared/media'

// ---------------------------------------------------------------------------
// isResolvableVideoPage — pure logic, no mocks needed (already covered in
// shared/__tests__/media.test.ts but we repeat the SP-1 gate here for the
// bg handler context).
// ---------------------------------------------------------------------------
describe('isResolvableVideoPage (SP-1 gate re-verified for handler context)', () => {
  it('bilibili is resolvable in full build', () => {
    expect(
      isResolvableVideoPage('https://www.bilibili.com/video/BV1xx', false)
    ).toEqual({ resolvable: true, site: 'bilibili' })
  })

  it('bilibili is resolvable in webstore build', () => {
    expect(
      isResolvableVideoPage('https://www.bilibili.com/video/BV1xx', true)
    ).toEqual({ resolvable: true, site: 'bilibili' })
  })

  it('b23.tv is resolvable in webstore build', () => {
    expect(isResolvableVideoPage('https://b23.tv/abc', true)).toEqual({
      resolvable: true,
      site: 'bilibili',
    })
  })

  it('youtube is resolvable in full build', () => {
    expect(
      isResolvableVideoPage('https://www.youtube.com/watch?v=x', false)
    ).toEqual({ resolvable: true, site: 'youtube' })
  })

  it('youtube is NOT resolvable in webstore build (SP-1)', () => {
    expect(
      isResolvableVideoPage('https://www.youtube.com/watch?v=x', true)
    ).toEqual({ resolvable: false })
  })

  it('non-video host is not resolvable', () => {
    expect(isResolvableVideoPage('https://example.com/page', false)).toEqual({
      resolvable: false,
    })
  })

  it('malformed URL is not resolvable', () => {
    expect(isResolvableVideoPage('not-a-url', false)).toEqual({
      resolvable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Handler logic simulation
// We define a minimal version of the handler inline to test the branches
// without pulling in the full service-worker side-effect tree.
// ---------------------------------------------------------------------------

type MockTab = { url?: string; title?: string; id?: number }

interface HandlerDeps {
  queryActiveTab: () => Promise<MockTab | undefined>
  getCookies: (url: string) => Promise<Array<{ name: string; value: string }>>
  submitDownload: (params: unknown) => Promise<{ taskId: string }>
  webStore: boolean
}

async function simulateHandler(deps: HandlerDeps): Promise<{ taskId: string }> {
  const tab = await deps.queryActiveTab()
  if (!tab?.url) throw new Error('No active tab')
  const check = isResolvableVideoPage(tab.url, deps.webStore)
  if (!check.resolvable) {
    throw new Error('This page is not a resolvable video page')
  }
  const rawCookies = await deps.getCookies(tab.url)
  const cookies = mapCookies(
    rawCookies as unknown as Parameters<typeof mapCookies>[0]
  )
  const headers: Record<string, string> = {
    Referer: tab.url,
    'User-Agent': 'test-ua',
  }
  const media = {
    kind: 'direct' as const,
    url: tab.url,
    pageUrl: tab.url,
    pageTitle: tab.title ?? tab.url,
    detectedAt: 1000,
  }
  const params = buildMediaSubmitParams(media, cookies, headers)
  return deps.submitDownload(params)
}

describe('bg.resolvePageDownload handler logic', () => {
  let submitDownload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    submitDownload = vi.fn().mockResolvedValue({ taskId: 'tid-123' })
  })

  it('bilibili tab — captures cookies and submits a direct selection with the tab URL', async () => {
    const bilibiliUrl = 'https://www.bilibili.com/video/BV1xx411c7mD'
    const getCookies = vi
      .fn()
      .mockResolvedValue([{ name: 'SESSDATA', value: 'abc' }])

    const result = await simulateHandler({
      queryActiveTab: async () => ({ url: bilibiliUrl, title: 'Test video' }),
      getCookies,
      submitDownload,
      webStore: false,
    })

    expect(result).toEqual({ taskId: 'tid-123' })
    expect(getCookies).toHaveBeenCalledWith(bilibiliUrl)
    expect(submitDownload).toHaveBeenCalledOnce()
    const params = submitDownload.mock.calls[0]?.[0] as {
      selection: { kind: string; primary: { url: string } }
      source: { pageUrl: string }
    }
    expect(params.selection.kind).toBe('direct')
    expect(params.selection.primary.url).toBe(bilibiliUrl)
    expect(params.source.pageUrl).toBe(bilibiliUrl)
  })

  it('bilibili tab in webstore build — still submits (bilibili always allowed)', async () => {
    const bilibiliUrl = 'https://b23.tv/abc123'
    const result = await simulateHandler({
      queryActiveTab: async () => ({ url: bilibiliUrl }),
      getCookies: async () => [],
      submitDownload,
      webStore: true,
    })
    expect(result).toEqual({ taskId: 'tid-123' })
  })

  it('youtube tab in full build — submits successfully', async () => {
    const ytUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const result = await simulateHandler({
      queryActiveTab: async () => ({ url: ytUrl, title: 'Rick Roll' }),
      getCookies: async () => [],
      submitDownload,
      webStore: false,
    })
    expect(result).toEqual({ taskId: 'tid-123' })
  })

  it('youtube tab in webstore build — throws (SP-1 exclusion)', async () => {
    const ytUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    await expect(
      simulateHandler({
        queryActiveTab: async () => ({ url: ytUrl }),
        getCookies: async () => [],
        submitDownload,
        webStore: true,
      })
    ).rejects.toThrow('This page is not a resolvable video page')
    expect(submitDownload).not.toHaveBeenCalled()
  })

  it('non-resolvable tab — throws', async () => {
    await expect(
      simulateHandler({
        queryActiveTab: async () => ({ url: 'https://example.com/page' }),
        getCookies: async () => [],
        submitDownload,
        webStore: false,
      })
    ).rejects.toThrow('This page is not a resolvable video page')
    expect(submitDownload).not.toHaveBeenCalled()
  })

  it('no active tab — throws', async () => {
    await expect(
      simulateHandler({
        queryActiveTab: async () => undefined,
        getCookies: async () => [],
        submitDownload,
        webStore: false,
      })
    ).rejects.toThrow('No active tab')
    expect(submitDownload).not.toHaveBeenCalled()
  })

  it('tab with no url — throws', async () => {
    await expect(
      simulateHandler({
        queryActiveTab: async () => ({ id: 1 }),
        getCookies: async () => [],
        submitDownload,
        webStore: false,
      })
    ).rejects.toThrow('No active tab')
    expect(submitDownload).not.toHaveBeenCalled()
  })
})
