// A takeover replays a download the browser already negotiated: Motrix gets
// the URL and re-requests it with GET. The browser's downloads API exposes
// neither the request method nor its body, so a download the page started
// with a form POST cannot be replayed faithfully — the same URL under GET
// commonly serves the HTML page that hosts the form.
//
// We cannot see the method, but we can see the consequence: probe the URL the
// way Motrix would and compare what comes back against what the browser said
// it was downloading. An HTML body where the browser expected a file is the
// signature of that mismatch (uupdump.net being the reported case). Declining
// leaves the native download intact, so the user still gets the right file.

const HTML_TYPES = ['text/html', 'application/xhtml+xml']
const HTML_EXTENSIONS = ['.html', '.htm', '.xhtml']

function isHtmlType(value: string): boolean {
  const essence = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return HTML_TYPES.includes(essence)
}

function looksLikeHtmlDownload(
  itemMime: string,
  suggestedFilename: string
): boolean {
  if (itemMime && isHtmlType(itemMime)) return true
  const name = suggestedFilename.toLowerCase()
  return HTML_EXTENSIONS.some((ext) => name.endsWith(ext))
}

export interface ReplayFidelityInput {
  /** `DownloadItem.mime` as Chromium reported it; may be empty. */
  itemMime: string
  /** `DownloadItem.filename`, basename only; may be empty. */
  suggestedFilename: string
  /** Content-Type the probe saw, or null when the probe could not run. */
  probedContentType: string | null
}

/**
 * True when replaying this URL as a plain GET is expected to yield the same
 * resource the browser was downloading. Absent evidence it returns true: a
 * failed probe must not silently disable the takeover feature.
 */
export function isFaithfulReplay(input: ReplayFidelityInput): boolean {
  const { probedContentType } = input
  if (probedContentType === null) return true
  if (!isHtmlType(probedContentType)) return true
  return looksLikeHtmlDownload(input.itemMime, input.suggestedFilename)
}
