/**
 * Fork-local MDXP request method — `media/formats`.
 *
 * The protocol package (0.8.1) has no format-listing method, and publishing
 * a new one upstream is out of scope for this fork, so the method is
 * registered locally on the dispatcher and mirrored into the request map by
 * interface merging. Keep this in sync with
 * `src/shared/schemas/media-formats.ts` and the extension's copy in
 * `extension/src/shared/mediaFormats.ts`. Promote all three when the method
 * lands in @motrix/mdxp.
 */
import type {
  MediaFormatsParams,
  MediaFormatsResult,
} from '@shared/schemas/media-formats'

declare module '@motrix/mdxp' {
  interface MdxpRequestMap {
    'media/formats': [MediaFormatsParams, MediaFormatsResult]
  }
}
