import { extensionBrowser as browser } from '@/shared/browser'
// ISOLATED-world bridge for the document_start MAIN-world sniffer. The bridge
// installs once per frame, announces readiness in both load orders, and
// bounds/coalesces page-controlled data before runtime IPC. Firefox also keeps
// a delayed isolated-world collector as a best-effort fallback if MAIN never
// completes the hello/ready/ack handshake.

import { imageThumbnailSampler } from '@/content/imageThumbnail'
import {
  installSniffer,
  type SnifferHandle,
  type SnifferPageContext,
} from '@/content/mediaSniffer'
import { isWebStoreBuild } from '@/shared/buildFlags'
import { shouldExcludeHost } from '@/shared/media'

const ENTRY_SOURCE = 'motrix-sniffer'
const RELAY_SOURCE = 'motrix-sniffer-relay'
const MAX_ITEMS_PER_PACKET = 100
const MAX_PACKET_BYTES = 256 * 1024
const PACKET_OVERHEAD_BYTES = 8 * 1024
const MAX_URL_LENGTH = 32_768
const MAX_TITLE_LENGTH = 512
const MAX_TEXT_LENGTH = 512
const MAX_EVIDENCE = 8
const MAX_QUEUE_ITEMS = 400
const MAX_QUEUE_BYTES = 768 * 1024
const WINDOW_MS = 1_000
const MAX_WINDOW_ITEMS = 300
const MAX_WINDOW_BYTES = 512 * 1024
const FIREFOX_MAIN_FALLBACK_MS = 500

type RelayWindow = Window & {
  __motrixSnifferRelayInstalled?: boolean
  __motrixSnifferRelayAnnounce?: () => void
  __motrixSnifferIsolatedFallback?: SnifferHandle
}

interface QueuedItem {
  value: Record<string, unknown>
  bytes: number
}

const encoder = new TextEncoder()

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : undefined
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function stringBytes(value: string): number {
  return encoder.encode(value).byteLength
}

function boundedItems(value: unknown): QueuedItem[] | null {
  if (!Array.isArray(value)) return null
  const items: QueuedItem[] = []
  let packetBytes = PACKET_OVERHEAD_BYTES
  for (const raw of value.slice(0, MAX_ITEMS_PER_PACKET)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const kind = boundedString(item.kind, 16)
    const url = boundedString(item.url, MAX_URL_LENGTH)
    const pageUrl = boundedString(item.pageUrl, MAX_URL_LENGTH)
    const pageTitle = boundedString(item.pageTitle, MAX_TITLE_LENGTH)
    if (!kind || !url || !pageUrl || !pageTitle) continue

    const normalized: Record<string, unknown> = {
      kind,
      url,
      pageUrl,
      pageTitle,
      detectedAt: boundedNumber(item.detectedAt) ?? Date.now(),
    }
    let itemBytes =
      256 +
      stringBytes(kind) +
      stringBytes(url) +
      stringBytes(pageUrl) +
      stringBytes(pageTitle)

    const addOptionalString = (
      key: string,
      rawValue: unknown,
      maxLength: number
    ): boolean => {
      const text = boundedString(rawValue, maxLength)
      if (!text) return false
      const bytes = stringBytes(text) + key.length + 8
      if (packetBytes + itemBytes + bytes > MAX_PACKET_BYTES) return false
      normalized[key] = text
      itemBytes += bytes
      return true
    }

    const audioUrlAdded = addOptionalString(
      'audioUrl',
      item.audioUrl,
      MAX_URL_LENGTH
    )
    if (kind === 'mux' && !audioUrlAdded) continue
    addOptionalString('mimeType', item.mimeType, 256)
    addOptionalString('category', item.category, 16)
    addOptionalString('alt', item.alt, MAX_TEXT_LENGTH)
    addOptionalString(
      'suggestedFilename',
      item.suggestedFilename,
      MAX_TEXT_LENGTH
    )

    for (const [key, rawValue] of [
      ['width', item.width],
      ['height', item.height],
      ['sizeBytes', item.sizeBytes],
    ] as const) {
      const number = boundedNumber(rawValue)
      if (number !== undefined) normalized[key] = number
    }
    if (typeof item.previewable === 'boolean') {
      normalized.previewable = item.previewable
    }

    if (Array.isArray(item.evidence)) {
      const evidence: string[] = []
      for (const rawEvidence of item.evidence.slice(0, MAX_EVIDENCE)) {
        const entry = boundedString(rawEvidence, 32)
        if (!entry) continue
        const bytes = stringBytes(entry) + 4
        if (packetBytes + itemBytes + bytes > MAX_PACKET_BYTES) break
        itemBytes += bytes
        evidence.push(entry)
      }
      if (evidence.length > 0) normalized.evidence = evidence
    }

    // Estimates above avoid spending work on strings that cannot fit. The
    // serialized size is authoritative so numeric fields and JSON escaping
    // are also included in both packet and rate-limit accounting.
    const serializedBytes = stringBytes(JSON.stringify(normalized)) + 1
    if (packetBytes + serializedBytes > MAX_PACKET_BYTES) break
    packetBytes += serializedBytes
    items.push({ value: normalized, bytes: serializedBytes })
  }
  return items
}

const relayWindow = window as RelayWindow
const runningFirefox =
  typeof __BROWSER__ !== 'undefined' && __BROWSER__ === 'firefox'
const currentPage = (): SnifferPageContext => ({
  pageUrl: location.href,
  pageTitle: document.title,
})
const firefoxFallbackAllowed = (): boolean =>
  runningFirefox &&
  !(isWebStoreBuild() && shouldExcludeHost(location.hostname, true))
const announce = (): void => {
  window.postMessage({ source: RELAY_SOURCE, type: 'ready' }, '*')
}

if (!relayWindow.__motrixSnifferRelayInstalled) {
  relayWindow.__motrixSnifferRelayInstalled = true
  relayWindow.__motrixSnifferRelayAnnounce = announce

  const queue: QueuedItem[] = []
  let queuedBytes = 0
  let flushScheduled = false
  let windowStartedAt = Date.now()
  let windowItems = 0
  let windowBytes = 0
  let mainHandshakeSeen = false
  let firefoxFallbackTimer: number | undefined

  const resetWindowIfNeeded = (): void => {
    if (Date.now() - windowStartedAt < WINDOW_MS) return
    windowStartedAt = Date.now()
    windowItems = 0
    windowBytes = 0
  }

  const safelySend = (items: Record<string, unknown>[]): void => {
    try {
      const message = {
        kind: 'bg.mediaDetected',
        payload: { tabUrl: location.href, items },
      }
      if (stringBytes(JSON.stringify(message)) > MAX_PACKET_BYTES) return
      const result = browser.runtime.sendMessage(message)
      if (result && typeof result.catch === 'function') {
        void result.catch(() => undefined)
      }
    } catch {
      // A sleeping/invalidated extension must not affect the page.
    }
  }

  const scheduleFlush = (delay = 0): void => {
    if (flushScheduled) return
    flushScheduled = true
    if (delay > 0) {
      window.setTimeout(() => {
        flushScheduled = false
        flush()
      }, delay)
    } else {
      queueMicrotask(() => {
        flushScheduled = false
        flush()
      })
    }
  }

  const flush = (): void => {
    resetWindowIfNeeded()
    if (queue.length === 0) return
    if (windowItems >= MAX_WINDOW_ITEMS || windowBytes >= MAX_WINDOW_BYTES) {
      scheduleFlush(Math.max(1, WINDOW_MS - (Date.now() - windowStartedAt)))
      return
    }

    const batch: Record<string, unknown>[] = []
    let batchBytes = PACKET_OVERHEAD_BYTES
    while (queue.length > 0 && batch.length < MAX_ITEMS_PER_PACKET) {
      const next = queue[0]
      if (!next) break
      if (
        batchBytes + next.bytes > MAX_PACKET_BYTES ||
        windowItems + batch.length + 1 > MAX_WINDOW_ITEMS ||
        windowBytes + batchBytes + next.bytes > MAX_WINDOW_BYTES
      ) {
        break
      }
      queue.shift()
      queuedBytes -= next.bytes
      batch.push(next.value)
      batchBytes += next.bytes
    }

    if (batch.length > 0) {
      windowItems += batch.length
      windowBytes += batchBytes
      safelySend(batch)
    }
    if (queue.length > 0) {
      const next = queue[0]
      const windowExhausted =
        windowItems >= MAX_WINDOW_ITEMS ||
        windowBytes >= MAX_WINDOW_BYTES ||
        (batch.length === 0 &&
          next !== undefined &&
          windowBytes + PACKET_OVERHEAD_BYTES + next.bytes > MAX_WINDOW_BYTES)
      scheduleFlush(
        windowExhausted
          ? Math.max(1, WINDOW_MS - (Date.now() - windowStartedAt))
          : 0
      )
    }
  }

  const enqueue = (items: QueuedItem[]): void => {
    for (const item of items) {
      if (
        queue.length >= MAX_QUEUE_ITEMS ||
        queuedBytes + item.bytes > MAX_QUEUE_BYTES
      ) {
        break
      }
      queue.push(item)
      queuedBytes += item.bytes
    }
    if (queue.length > 0) scheduleFlush()
  }

  const stopFirefoxFallback = (): void => {
    mainHandshakeSeen = true
    if (firefoxFallbackTimer !== undefined) {
      window.clearTimeout(firefoxFallbackTimer)
      firefoxFallbackTimer = undefined
    }
    relayWindow.__motrixSnifferIsolatedFallback?.uninstall()
    delete relayWindow.__motrixSnifferIsolatedFallback
  }

  const startFirefoxFallback = (): void => {
    if (
      mainHandshakeSeen ||
      !firefoxFallbackAllowed() ||
      relayWindow.__motrixSnifferIsolatedFallback
    ) {
      return
    }
    relayWindow.__motrixSnifferIsolatedFallback = installSniffer(
      (items) => {
        const bounded = boundedItems(items)
        if (bounded && bounded.length > 0) enqueue(bounded)
      },
      currentPage(),
      currentPage
    )
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as {
      source?: string
      type?: string
      items?: unknown
    }
    if (data?.source !== ENTRY_SOURCE) return
    if (data.type === 'hello' || data.type === 'ack') {
      stopFirefoxFallback()
    }
    if (data.type === 'hello') {
      announce()
      return
    }
    if (data.type === 'ack') return
    // Keep accepting the legacy no-type envelope used by the specialized
    // YouTube sniffer while the generic entry sends an explicit media type.
    if (data.type !== undefined && data.type !== 'media') return
    const items = boundedItems(data.items)
    if (!items || items.length === 0) return
    enqueue(items)
  })

  const thumbnailListener = (
    rawMessage: unknown,
    _sender: unknown,
    sendResponse: (response: unknown) => void
  ): boolean => {
    let kind: unknown
    let payload: unknown
    try {
      const envelope = rawMessage as
        | { kind?: unknown; payload?: unknown }
        | undefined
      kind = envelope?.kind
      payload = envelope?.payload
    } catch {
      return false
    }
    if (kind !== 'content.imageThumbnail') return false

    // Keep the response on the extension-runtime channel. In particular, do
    // not bridge it through window.postMessage, where page script could forge
    // a result. The microtask + `true` return works in Chromium and Firefox.
    void Promise.resolve()
      .then(() => imageThumbnailSampler.capture(payload))
      .then(
        (response) => {
          try {
            sendResponse(response)
          } catch {
            // The popup/background may have gone away while encoding.
          }
        },
        () => {
          try {
            sendResponse({ dataUrl: null })
          } catch {
            // The popup/background may have gone away while encoding.
          }
        }
      )
    return true
  }

  browser.runtime.onMessage.addListener(thumbnailListener)

  if (firefoxFallbackAllowed()) {
    firefoxFallbackTimer = window.setTimeout(
      startFirefoxFallback,
      FIREFOX_MAIN_FALLBACK_MS
    )
  }
}

// Proactive ready handles relay-first loading; the hello response handles
// MAIN-first loading and reinjection.
relayWindow.__motrixSnifferRelayAnnounce?.()
