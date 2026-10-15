import type { UrlResolveParams, UrlResolveResult } from '@motrix/mdxp'

/**
 * v0.1 placeholder. Returns a spec-compliant UrlResolveResult shape
 * with a single placeholder selection. The actual extraction logic
 * (InnerTube API call, signature deciphering, format selection) is
 * NOT implemented — that lands in Plan 04.
 *
 * For Plan 03b validation this is enough:
 *   - Motrix sees a spec-compliant url/resolve response
 *   - Motrix surfaces a "downloadable" item (the download itself fails
 *     because the placeholder URL is obviously not a real CDN URL —
 *     Plan 03b explicitly accepts this behaviour).
 */
export async function resolveYouTube(
  _url: string,
  preferences?: UrlResolveParams['preferences']
): Promise<UrlResolveResult> {
  return {
    selections: [
      {
        kind: 'direct',
        primary: {
          url: 'https://placeholder.example.com/youtube-v01-not-yet-implemented.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
        quality: preferences?.maxQuality ?? '720p',
      },
    ],
    meta: {
      title: '[YouTube adapter v0.1 placeholder]',
      description:
        'YouTube extraction not yet implemented. See Plan 04 for the real InnerTube path.',
    },
    extractedBy: {
      adapterId: 'youtube',
      adapterVersion: '0.1.0',
      extractedAt: Date.now(),
    },
  }
}
