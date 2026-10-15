import { sanitizeFilename } from '@/shared/manualTask'
import { hostOf, type RawTarget, type TakeoverTarget } from '@/shared/takeover'

function filenameFromPath(value: string): string {
  // DownloadItem.filename is an absolute local path on both browser families.
  // Unlike a URL, its leaf may contain literal # and ? characters.
  const leaf = value.split(/[/\\]/).pop()?.trim() ?? ''
  return leaf === '.' || leaf === '..' ? '' : leaf
}

function filenameFromUrl(value: string): string {
  try {
    const leaf = new URL(value).pathname.split('/').filter(Boolean).pop() ?? ''
    try {
      return decodeURIComponent(leaf)
    } catch {
      return leaf
    }
  } catch {
    return ''
  }
}

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.length > 0
}

export function normalizeTarget(raw: RawTarget): TakeoverTarget {
  const url = nonEmpty(raw.finalUrl) ? raw.finalUrl : raw.url
  const pageUrl = nonEmpty(raw.referrer) ? raw.referrer : url
  const browserName = filenameFromPath(raw.suggestedFilename ?? '')
  const suggestedFilename = sanitizeFilename(
    browserName || filenameFromUrl(url),
    'download'
  )
  const pageTitle = (
    nonEmpty(raw.tabTitle) ? raw.tabTitle : suggestedFilename
  ).slice(0, 500)
  const sizeBytes =
    typeof raw.sizeBytes === 'number' && raw.sizeBytes > 0
      ? raw.sizeBytes
      : null
  return {
    url,
    pageUrl,
    pageTitle,
    suggestedFilename,
    filenameFromUrl: browserName.length === 0,
    mime: raw.mime ?? '',
    sizeBytes,
    siteHint: hostOf(pageUrl),
    origin: raw.origin,
  }
}
