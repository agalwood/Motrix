import { useEffect, useState } from 'react'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { siteDomain } from '@/shared/siteExclusion'

export function useCurrentSite(): string | null {
  const [domain, setDomain] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let generation = 0
    const refresh = async () => {
      const current = ++generation
      try {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        })
        if (!disposed && current === generation) setDomain(siteDomain(tab?.url))
      } catch {
        if (!disposed && current === generation) setDomain(null)
      }
    }
    const onActivated = () => {
      void refresh()
    }
    const onUpdated = (_id: number, change: Browser.tabs.OnUpdatedInfo) => {
      if (change.url !== undefined) void refresh()
    }
    void refresh()
    browser.tabs.onActivated?.addListener(onActivated)
    browser.tabs.onUpdated?.addListener(onUpdated)
    return () => {
      disposed = true
      browser.tabs.onActivated?.removeListener(onActivated)
      browser.tabs.onUpdated?.removeListener(onUpdated)
    }
  }, [])
  return domain
}
