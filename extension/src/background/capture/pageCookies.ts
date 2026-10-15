import type { Cookie } from '@motrix/mdxp'
import {
  type BrowserCookieLike,
  mapCookies,
} from '@/background/capture/cookies'
import type { BrowserKind } from '@/shared/browserKind'

interface PageCookieQuery {
  url: string
  storeId?: string
  firstPartyDomain?: string | null
  partitionKey?: {
    topLevelSite?: string
    hasCrossSiteAncestor?: boolean
  }
}

export interface PageCookieApi {
  getAll(query: PageCookieQuery): Promise<BrowserCookieLike[]>
}

function cookieIdentity(cookie: BrowserCookieLike): string {
  return [
    cookie.name,
    cookie.value,
    cookie.domain,
    cookie.path,
    cookie.secure,
    cookie.httpOnly,
    cookie.sameSite,
    cookie.expirationDate ?? '',
  ].join('\u0000')
}

/**
 * Capture cookies for the explicit page-level resolver. Firefox queries both
 * unpartitioned/FPI and the active top-level partition; any unsupported query
 * degrades to the other result (or no cookies) instead of disabling resolve.
 */
export async function capturePageCookies(options: {
  url: string
  storeId?: string
  browser: BrowserKind
  api: PageCookieApi
}): Promise<Cookie[]> {
  let pageUrl: URL
  try {
    pageUrl = new URL(options.url)
  } catch {
    return []
  }
  if (pageUrl.protocol !== 'http:' && pageUrl.protocol !== 'https:') return []

  const base: PageCookieQuery = {
    url: pageUrl.toString(),
    ...(options.storeId ? { storeId: options.storeId } : {}),
  }
  const queries: PageCookieQuery[] =
    options.browser === 'firefox'
      ? [
          { ...base, firstPartyDomain: null },
          {
            ...base,
            firstPartyDomain: null,
            partitionKey: {
              topLevelSite: pageUrl.origin,
              hasCrossSiteAncestor: false,
            },
          },
        ]
      : [base]
  const settled = await Promise.allSettled(
    queries.map((query) => options.api.getAll(query))
  )
  const unique = new Map<string, BrowserCookieLike>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const cookie of result.value) {
      unique.set(cookieIdentity(cookie), cookie)
    }
  }
  return mapCookies([...unique.values()])
}
