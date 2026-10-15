import { beforeDeadline } from '@/background/download-errors'
import { log } from '@/background/log'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'

export const FIREFOX_METADATA_WAIT_MS = 3000
const POLL_INTERVAL_MS = 100

export function firefoxDownloadSize(
  item: Browser.downloads.DownloadItem
): number | null {
  return Number.isFinite(item.totalBytes) && item.totalBytes > 0
    ? item.totalBytes
    : null
}

export async function readActiveFirefoxDownload(
  id: number,
  deadlineAt = Date.now() + FIREFOX_METADATA_WAIT_MS
): Promise<Browser.downloads.DownloadItem | null> {
  try {
    const [item] = await beforeDeadline(
      browser.downloads.search({ id }),
      deadlineAt
    )
    if (item?.state !== 'in_progress' || item.paused) {
      log.debug('[takeover] Firefox native download unavailable; id=', id)
      return null
    }
    return item
  } catch {
    // API errors can contain the original URL or local download path.
    log.debug('[takeover] Firefox metadata unavailable; id=', id)
    return null
  }
}

/** Firefox does not emit onChanged for totalBytes or mime, despite exposing
 * those fields in the event schema. Read the live download instead of relying
 * on the immutable onCreated snapshot. No extra HTTP request is needed. */
export async function waitForFirefoxMetadata(
  id: number,
  probeSize: () => number | null = () => null
): Promise<Browser.downloads.DownloadItem | null> {
  const deadlineAt = Date.now() + FIREFOX_METADATA_WAIT_MS
  while (true) {
    const item = await readActiveFirefoxDownload(id, deadlineAt)
    if (!item) return null
    if (firefoxDownloadSize(item) !== null || probeSize() !== null) return item
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return item
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining))
    )
    if (Date.now() >= deadlineAt) return item
  }
}
