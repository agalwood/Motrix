import {
  ErrorCodes,
  type MediaFormatsParams,
  type MediaFormatsResult,
  MediaFormatsResultSchema,
  makeMdxpError,
} from '@motrix/mdxp'
import type { MdxpSessionContext } from '../mdxp-session-context'

export type MediaFormatsHandler = (
  params: MediaFormatsParams,
  ctx: MdxpSessionContext
) => Promise<MediaFormatsResult>

/** Keep admission slots until the underlying work has actually settled. */
export function createMediaFormatsHandler(
  list: MediaFormatsHandler
): MediaFormatsHandler {
  const activeSessions = new Set<AbortSignal>()
  return async (params, ctx) => {
    const checkSession = () => {
      if (
        ctx.identity.kind !== 'extension' ||
        !ctx.isAuthorized() ||
        !ctx.isReady() ||
        !ctx.sessionSignal ||
        !ctx.requestSignal
      ) {
        throw makeMdxpError(ErrorCodes.PermissionDenied, 'session is not ready')
      }
      if (ctx.requestSignal.aborted || ctx.sessionSignal.aborted) {
        throw makeMdxpError(
          ErrorCodes.RequestCancelled,
          'format query cancelled'
        )
      }
    }
    checkSession()
    // yt-dlp cannot enforce the contract's host-only Cookie isolation. Refuse
    // credentials before shell probes, binary resolution, or process creation.
    if (params.cookies?.length) {
      return {
        available: false,
        reason: 'credentials-unsupported',
        entries: [],
      }
    }
    const session = ctx.sessionSignal as AbortSignal
    if (activeSessions.has(session) || activeSessions.size >= 2) {
      throw makeMdxpError(ErrorCodes.RateLimited, 'format query limit reached')
    }
    activeSessions.add(session)
    try {
      const result = await list(params, ctx)
      checkSession()
      const parsed = MediaFormatsResultSchema.safeParse(result)
      return parsed.success
        ? parsed.data
        : { available: false, reason: 'invalid-result', entries: [] }
    } catch (error) {
      checkSession()
      if (error instanceof Error && error.name === 'AbortError') {
        throw makeMdxpError(
          ErrorCodes.RequestCancelled,
          'format query cancelled'
        )
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (
          [
            ErrorCodes.PermissionDenied,
            ErrorCodes.PairRevoked,
            ErrorCodes.RequestCancelled,
            ErrorCodes.RateLimited,
          ] as readonly unknown[]
        ).includes(error.code)
      ) {
        // Preserve the control outcome, never an extractor's raw error text.
        throw makeMdxpError(error.code as number, 'format query refused')
      }
      return { available: false, reason: 'extractor-failed', entries: [] }
    } finally {
      activeSessions.delete(session)
    }
  }
}
