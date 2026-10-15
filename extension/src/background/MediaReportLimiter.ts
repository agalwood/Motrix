export const MEDIA_REPORT_WINDOW_MS = 1_000
export const MAX_MEDIA_REPORT_MESSAGES_PER_WINDOW = 30
export const MAX_MEDIA_REPORT_ITEMS_PER_WINDOW = 300
export const MAX_MEDIA_REPORT_BYTES_PER_WINDOW = 512 * 1024
export const MAX_MEDIA_REPORT_ITEMS_PER_MESSAGE = 100
export const MAX_MEDIA_REPORT_BYTES_PER_MESSAGE = 256 * 1024

interface ReportWindow {
  startedAt: number
  messages: number
  items: number
  bytes: number
  blockedUntil: number
}

const TEXT_FIELDS = [
  'kind',
  'url',
  'audioUrl',
  'pageUrl',
  'pageTitle',
  'mimeType',
  'category',
  'suggestedFilename',
  'alt',
] as const

const encoder = new TextEncoder()

function reportCost(payload: unknown): { items: number; bytes: number } {
  if (typeof payload !== 'object' || payload === null) {
    return { items: 0, bytes: 0 }
  }
  const report = payload as { tabUrl?: unknown; items?: unknown }
  if (!Array.isArray(report.items)) return { items: 0, bytes: 0 }
  const items = report.items.length
  let bytes =
    128 +
    (typeof report.tabUrl === 'string'
      ? encoder.encode(report.tabUrl).byteLength
      : 0)
  for (const raw of report.items.slice(
    0,
    MAX_MEDIA_REPORT_ITEMS_PER_MESSAGE + 1
  )) {
    bytes += 128
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    for (const field of TEXT_FIELDS) {
      const value = item[field]
      if (typeof value === 'string') bytes += encoder.encode(value).byteLength
    }
    if (Array.isArray(item.evidence)) {
      for (const evidence of item.evidence.slice(0, 9)) {
        if (typeof evidence === 'string') {
          bytes += encoder.encode(evidence).byteLength
        }
      }
    }
    if (bytes > MAX_MEDIA_REPORT_BYTES_PER_MESSAGE) break
  }
  return { items, bytes }
}

/** Aggregate all-frame reports by tab before normalization/storage work. */
export class MediaReportLimiter {
  private readonly windows = new Map<number, ReportWindow>()

  constructor(private readonly now: () => number = Date.now) {}

  allow(tabId: number, payload: unknown): boolean {
    if (tabId < 0) return false
    const now = this.now()
    const cost = reportCost(payload)
    if (
      cost.items > MAX_MEDIA_REPORT_ITEMS_PER_MESSAGE ||
      cost.bytes > MAX_MEDIA_REPORT_BYTES_PER_MESSAGE
    ) {
      return false
    }
    let window = this.windows.get(tabId)
    if (!window || now - window.startedAt >= MEDIA_REPORT_WINDOW_MS) {
      window = {
        startedAt: now,
        messages: 0,
        items: 0,
        bytes: 0,
        blockedUntil: 0,
      }
      this.windows.delete(tabId)
      this.windows.set(tabId, window)
      this.prune(now)
    }
    if (now < window.blockedUntil) return false

    if (
      window.messages + 1 > MAX_MEDIA_REPORT_MESSAGES_PER_WINDOW ||
      window.items + cost.items > MAX_MEDIA_REPORT_ITEMS_PER_WINDOW ||
      window.bytes + cost.bytes > MAX_MEDIA_REPORT_BYTES_PER_WINDOW
    ) {
      window.blockedUntil = window.startedAt + MEDIA_REPORT_WINDOW_MS
      return false
    }
    window.messages += 1
    window.items += cost.items
    window.bytes += cost.bytes
    return true
  }

  clear(tabId: number): void {
    this.windows.delete(tabId)
  }

  private prune(now: number): void {
    for (const [tabId, window] of this.windows) {
      if (now - window.startedAt >= MEDIA_REPORT_WINDOW_MS * 2) {
        this.windows.delete(tabId)
      }
    }
  }
}
