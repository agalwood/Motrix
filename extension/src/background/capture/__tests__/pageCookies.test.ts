import { describe, expect, it, vi } from 'vitest'
import type { BrowserCookieLike } from '@/background/capture/cookies'
import { capturePageCookies } from '@/background/capture/pageCookies'

const cookie: BrowserCookieLike = {
  name: 'sid',
  value: 'private',
  domain: '.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
}

describe('capturePageCookies', () => {
  it('uses a single URL/store-scoped query on Chromium', async () => {
    const getAll = vi.fn(async () => [cookie])
    const result = await capturePageCookies({
      url: 'https://www.example.com/watch',
      storeId: 'container-1',
      browser: 'chromium',
      api: { getAll },
    })

    expect(getAll).toHaveBeenCalledWith({
      url: 'https://www.example.com/watch',
      storeId: 'container-1',
    })
    expect(result).toEqual([expect.objectContaining({ name: 'sid' })])
  })

  it('combines Firefox FPI and top-level partition queries without duplicates', async () => {
    const getAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('unpartitioned query unavailable'))
      .mockResolvedValueOnce([cookie, cookie])
    const result = await capturePageCookies({
      url: 'https://www.example.com/watch',
      browser: 'firefox',
      api: { getAll },
    })

    expect(getAll).toHaveBeenNthCalledWith(1, {
      url: 'https://www.example.com/watch',
      firstPartyDomain: null,
    })
    expect(getAll).toHaveBeenNthCalledWith(2, {
      url: 'https://www.example.com/watch',
      firstPartyDomain: null,
      partitionKey: {
        topLevelSite: 'https://www.example.com',
        hasCrossSiteAncestor: false,
      },
    })
    expect(result).toHaveLength(1)
  })

  it('degrades to no cookies when the browser rejects every query', async () => {
    const getAll = vi.fn(async () => {
      throw new Error('FPI query rejected')
    })
    await expect(
      capturePageCookies({
        url: 'https://www.example.com/watch',
        browser: 'firefox',
        api: { getAll },
      })
    ).resolves.toEqual([])
  })
})
