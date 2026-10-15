// MAIN-world YouTube sniffer entry point — injected on-demand by bg.scanActiveTab
// when the active tab's host is a YouTube domain (full/Firefox build only).
//
// Uses the SAME postMessage envelope as the generic sniffer-entry so that the
// EXISTING ISOLATED-world sniffer-relay forwards detected media to bg.mediaDetected
// without any relay changes.
//
// MAIN-world scripts have NO extension runtime access. Results travel via
// postMessage to the static ISOLATED relay in Chromium and Firefox 128+.

import {
  installYoutubeSniffer,
  type YoutubeSnifferHandle,
  type YoutubeSnifferPageContext,
} from '@/content/youtube/youtubeSniffer'
import type { DetectedMedia } from '@/shared/media'

type YoutubeSnifferWindow = Window & {
  __motrixYoutubeSniffer?: YoutubeSnifferHandle
}

const snifferWindow = window as YoutubeSnifferWindow
const currentPage = (): YoutubeSnifferPageContext => ({
  pageUrl: location.href,
  pageTitle: document.title,
})

const install = (): void => {
  const installed = installYoutubeSniffer(
    (item: DetectedMedia) => {
      // Wrap in an array to match the sniffer-relay's `items` envelope.
      window.postMessage(
        { source: 'motrix-sniffer', type: 'media', items: [item] },
        '*'
      )
    },
    currentPage(),
    currentPage
  )
  const handle: YoutubeSnifferHandle = {
    scan: installed.scan,
    cacheSizes: installed.cacheSizes,
    uninstall: () => {
      try {
        installed.uninstall()
      } finally {
        if (snifferWindow.__motrixYoutubeSniffer === handle) {
          delete snifferWindow.__motrixYoutubeSniffer
        }
      }
    },
  }
  snifferWindow.__motrixYoutubeSniffer = handle
}

const existing = snifferWindow.__motrixYoutubeSniffer
if (existing && typeof existing.scan === 'function') {
  try {
    existing.scan(currentPage())
  } catch {
    delete snifferWindow.__motrixYoutubeSniffer
    install()
  }
} else {
  delete snifferWindow.__motrixYoutubeSniffer
  install()
}
