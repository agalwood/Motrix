/**
 * Fork-local MDXP request method — `media/formats`.
 *
 * The protocol package (0.8.1) has no format-listing method, so the method
 * is merged into the request map here to type ConnectionManager.request()
 * over the extension WebSocket. Keep in sync with the desktop copy in
 * `src/core/bridge/mdxp-local-methods.d.ts` and the shapes in
 * `extension/src/shared/mediaFormats.ts`.
 */
import type {
  MediaFormatsParams,
  MediaFormatsResult,
} from '@/shared/mediaFormats'

declare module '@motrix/mdxp' {
  interface MdxpRequestMap {
    'media/formats': [MediaFormatsParams, MediaFormatsResult]
  }
}
