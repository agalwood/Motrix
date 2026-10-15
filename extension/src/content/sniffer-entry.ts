// Generic media discovery starts at document_start in every frame. This entry
// runs in MAIN world so fetch/XHR patches observe page requests; an ISOLATED
// relay carries bounded reports to runtime messaging in both browsers.

import {
  installSniffer,
  type SnifferHandle,
  type SnifferPageContext,
} from '@/content/mediaSniffer'
import { isWebStoreBuild } from '@/shared/buildFlags'
import type { DetectedMedia } from '@/shared/media'
import { shouldExcludeHost } from '@/shared/media'

const ENTRY_SOURCE = 'motrix-sniffer'
const RELAY_SOURCE = 'motrix-sniffer-relay'
const MAX_PENDING_REPORTS = 10

type SnifferWindow = Window & {
  __motrixSniffer?: SnifferHandle
}

type RelayMessage = {
  source?: string
  type?: string
}

const snifferWindow = window as SnifferWindow
const currentPage = (): SnifferPageContext => ({
  pageUrl: location.href,
  pageTitle: document.title,
})

function webStorePageExcluded(): boolean {
  return isWebStoreBuild() && shouldExcludeHost(location.hostname, true)
}

if (!webStorePageExcluded()) {
  if (snifferWindow.__motrixSniffer) {
    // Dynamic reinjection remains as an explicit SPA rescan fallback.
    snifferWindow.__motrixSniffer.scan(currentPage())
  } else {
    let relayReady = false
    const pending: DetectedMedia[][] = []

    const postItems = (items: DetectedMedia[]): void => {
      window.postMessage({ source: ENTRY_SOURCE, type: 'media', items }, '*')
    }
    const flush = (): void => {
      relayReady = true
      for (const items of pending.splice(0)) postItems(items)
      // Confirms the proactive ready announcement when MAIN loaded first, so
      // Firefox's isolated fallback does not activate unnecessarily.
      window.postMessage({ source: ENTRY_SOURCE, type: 'ack' }, '*')
    }
    const onRelayMessage = (event: MessageEvent): void => {
      if (event.source !== window) return
      const message = event.data as RelayMessage
      if (message?.source === RELAY_SOURCE && message.type === 'ready') flush()
    }
    window.addEventListener('message', onRelayMessage)

    const installed = installSniffer(
      (items: DetectedMedia[]) => {
        if (relayReady) postItems(items)
        else {
          if (pending.length >= MAX_PENDING_REPORTS) pending.shift()
          pending.push(items)
        }
      },
      currentPage(),
      currentPage
    )
    snifferWindow.__motrixSniffer = {
      scan: installed.scan,
      uninstall: () => {
        window.removeEventListener('message', onRelayMessage)
        pending.length = 0
        installed.uninstall()
      },
    }

    // The relay may have loaded before or after MAIN world. A hello/ready pair
    // makes either order lossless; the relay also announces proactively.
    window.postMessage({ source: ENTRY_SOURCE, type: 'hello' }, '*')
  }
}
