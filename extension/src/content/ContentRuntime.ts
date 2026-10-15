import type { UrlResolveParams } from '@motrix/mdxp'
import { adapterRegistry } from '@/adapters/index'
import type { SiteAdapter } from '@/adapters/SiteAdapter'
import { extensionBrowser as browser } from '@/shared/browser'

/**
 * Owns the SiteAdapter that matches the current tab. Announces itself
 * to the background SW on bootstrap, then listens for `content.resolve`
 * requests dispatched by UrlResolutionDispatcher.
 */
export class ContentRuntime {
  public readonly adapterId: string | null
  private readonly adapter: SiteAdapter | null
  private readonly pageUrl: string

  constructor(pageUrl: string) {
    const found = adapterRegistry.find((a) => a.matchesUrl(pageUrl))
    this.adapter = found ?? null
    this.adapterId = found?.id ?? null
    this.pageUrl = pageUrl
  }

  async bootstrap(): Promise<void> {
    if (this.adapter === null || this.adapterId === null) return
    await browser.runtime.sendMessage({
      kind: 'bg.adapterAnnounce',
      payload: { adapterId: this.adapterId, tabUrl: this.pageUrl },
    })
  }

  attach(): void {
    if (this.adapter === null) return
    const adapter = this.adapter
    browser.runtime.onMessage.addListener((rawMsg, _sender, sendResponse) => {
      const env = rawMsg as { kind?: string; payload?: unknown } | undefined
      if (env?.kind !== 'content.resolve') return false
      const payload = env.payload as {
        url: string
        preferences?: UrlResolveParams['preferences']
      }
      void adapter
        .resolve(payload.url, payload.preferences)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ error: (e as Error).message ?? 'resolve failed' })
        )
      return true
    })
  }
}
