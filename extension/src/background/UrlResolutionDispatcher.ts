import type { UrlResolveParams, UrlResolveResult } from '@motrix/mdxp'
import { BgAdapterRegistry } from '@/background/AdapterRegistry'
import { log } from '@/background/log'
import { extensionBrowser as browser } from '@/shared/browser'

export interface UrlResolutionDispatcherOptions {
  registry?: BgAdapterRegistry
  /** Injectable for tests; defaults to browser.tabs. */
  tabs?: TabsApi
  /** Max ms to wait for the content script reply. */
  timeoutMs?: number
}

/** Subset of browser.tabs we depend on. */
export interface TabsApi {
  query(info: { url?: string | string[] }): Promise<Array<{ id?: number }>>
  sendMessage(tabId: number, message: unknown): Promise<unknown>
}

export class UrlResolutionError extends Error {
  public readonly code: 'no-tab' | 'timeout' | 'tab-error'
  constructor(message: string, code: 'no-tab' | 'timeout' | 'tab-error') {
    super(message)
    this.name = 'UrlResolutionError'
    this.code = code
  }
}

/**
 * On url/resolve, find a tab whose URL matches an adapter pattern and
 * forward the request via tabs.sendMessage. The cross-process round-trip
 * is the race-y bit (Plan 03b risk #2): we cap with a timeout and surface
 * specific error codes so the upstream MDXP caller can react.
 */
export class UrlResolutionDispatcher {
  private readonly registry: BgAdapterRegistry
  private readonly tabs: TabsApi
  private readonly timeoutMs: number

  constructor(opts: UrlResolutionDispatcherOptions = {}) {
    this.registry = opts.registry ?? new BgAdapterRegistry()
    this.tabs = opts.tabs ?? (browser.tabs as unknown as TabsApi)
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  async resolve(
    url: string,
    preferences?: UrlResolveParams['preferences']
  ): Promise<UrlResolveResult> {
    const adapter = this.registry.findFor(url)
    if (!adapter) {
      throw new UrlResolutionError(`no adapter for ${url}`, 'no-tab')
    }

    const candidateTabs = await this.tabs.query({
      url: adapter.urlPatterns,
    })
    const targetTab = candidateTabs.find((t) => typeof t.id === 'number')
    if (!targetTab || targetTab.id === undefined) {
      throw new UrlResolutionError(
        `no open ${adapter.id} tab to resolve ${url}`,
        'no-tab'
      )
    }

    const envelope = {
      kind: 'content.resolve' as const,
      payload: preferences === undefined ? { url } : { url, preferences },
    }

    return await this.sendWithTimeout(targetTab.id, envelope)
  }

  private async sendWithTimeout(
    tabId: number,
    envelope: unknown
  ): Promise<UrlResolveResult> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const sendPromise = this.tabs.sendMessage(tabId, envelope)
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new UrlResolutionError(
              `content script did not respond within ${this.timeoutMs}ms`,
              'timeout'
            )
          )
        }, this.timeoutMs)
      })

      const raw = await Promise.race([sendPromise, timeoutPromise])
      if (raw && typeof raw === 'object' && 'error' in raw) {
        throw new UrlResolutionError(
          String((raw as { error: unknown }).error),
          'tab-error'
        )
      }
      return raw as UrlResolveResult
    } catch (e) {
      if (e instanceof UrlResolutionError) throw e
      log.warn('tabs.sendMessage failed', e)
      throw new UrlResolutionError(
        (e as Error).message ?? 'tab dispatch failed',
        'tab-error'
      )
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}
