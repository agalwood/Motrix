import type { Cookie, DownloadSubmitParams, Resource } from '@motrix/mdxp'
import {
  isMagnetUrl,
  QUALITY_SENTINEL,
  type TakeoverTarget,
} from '@/shared/takeover'

export function buildSubmitParams(
  t: TakeoverTarget,
  cookies: Cookie[],
  headers: Record<string, string>
): DownloadSubmitParams {
  // An empty hint is valid MDXP and lets Motrix discover Content-Disposition.
  // A URL basename is useful for display, but is not a user-chosen filename.
  const suggestedFilename =
    t.filenameFromUrl && !isMagnetUrl(t.url) ? '' : t.suggestedFilename
  const meta: DownloadSubmitParams['meta'] =
    t.sizeBytes !== null
      ? {
          suggestedFilename,
          qualityLabel: QUALITY_SENTINEL,
          estimatedBytes: t.sizeBytes,
        }
      : {
          suggestedFilename,
          qualityLabel: QUALITY_SENTINEL,
        }

  const source: DownloadSubmitParams['source'] =
    t.siteHint.length > 0
      ? {
          pageUrl: t.pageUrl,
          pageTitle: t.pageTitle,
          detectedAt: Date.now(),
          siteHint: t.siteHint,
        }
      : { pageUrl: t.pageUrl, pageTitle: t.pageTitle, detectedAt: Date.now() }

  if (isMagnetUrl(t.url)) {
    return { source, selection: { kind: 'magnet', uri: t.url }, meta }
  }

  const primary: Resource = {
    url: t.url,
    headers,
    cookies,
    refererPolicy: 'strict-origin-when-cross-origin',
  }
  return { source, selection: { kind: 'direct', primary }, meta }
}
