import {
  type DownloadSubmitParams,
  DownloadSubmitParamsSchema,
} from '@motrix/mdxp'
import { isDownloadErrorReason } from '@/shared/integration'
import { MEDIA_SUBMIT_ERROR } from '@/shared/messages'

const MIN_IDEMPOTENCY_KEY_LENGTH = 8
const MAX_IDEMPOTENCY_KEY_LENGTH = 128

/**
 * Completes a trusted media submission with the caller's logical-operation
 * key. Parsing the complete object keeps the background as the protocol
 * boundary and guarantees the key reaches Motrix unchanged.
 */
export function applyCallerIdempotencyKey(
  params: DownloadSubmitParams,
  request: unknown
): DownloadSubmitParams {
  const idempotencyKey =
    typeof request === 'object' && request !== null
      ? (request as { idempotencyKey?: unknown }).idempotencyKey
      : undefined
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
  }
  const parsed = DownloadSubmitParamsSchema.safeParse({
    ...params,
    idempotencyKey,
  })
  if (!parsed.success) throw new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
  return parsed.data
}

/** Prevent active URLs, cookies, native paths and transport details leaking. */
export function toSafeMediaSubmitError(error: unknown): Error {
  return isDownloadErrorReason((error as Error)?.message) ||
    (error as Error)?.message === MEDIA_SUBMIT_ERROR.invalidRequest
    ? (error as Error)
    : new Error(MEDIA_SUBMIT_ERROR.submitFailed)
}
