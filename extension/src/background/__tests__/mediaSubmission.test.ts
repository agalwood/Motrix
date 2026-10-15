import type { DownloadSubmitParams } from '@motrix/mdxp'
import { describe, expect, it } from 'vitest'
import {
  applyCallerIdempotencyKey,
  toSafeMediaSubmitError,
} from '@/background/mediaSubmission'
import { MEDIA_SUBMIT_ERROR } from '@/shared/messages'

const BASE_PARAMS: DownloadSubmitParams = {
  source: {
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Example',
    detectedAt: 1234,
  },
  selection: {
    kind: 'direct',
    primary: {
      url: 'https://cdn.example.com/video.mp4',
      headers: {},
      cookies: [],
      refererPolicy: 'strict-origin-when-cross-origin',
    },
  },
  meta: { suggestedFilename: 'video.mp4', qualityLabel: 'auto' },
}

describe('media submission protocol boundary', () => {
  it('preserves a valid caller idempotency key in complete MDXP params', () => {
    const result = applyCallerIdempotencyKey(BASE_PARAMS, {
      idempotencyKey: 'caller-key-12345678',
    })

    expect(result).toEqual({
      ...BASE_PARAMS,
      idempotencyKey: 'caller-key-12345678',
    })
  })

  it.each([
    undefined,
    null,
    {},
    { idempotencyKey: 123 },
    { idempotencyKey: 'short' },
    { idempotencyKey: 'x'.repeat(129) },
  ])(
    'rejects an invalid caller key without exposing schema details',
    (request) => {
      expect(() => applyCallerIdempotencyKey(BASE_PARAMS, request)).toThrow(
        MEDIA_SUBMIT_ERROR.invalidRequest
      )
    }
  )

  it('maps private transport details to a stable public error', () => {
    expect(
      toSafeMediaSubmitError(
        new Error(
          'failed for https://user:secret@example.com at /Users/private'
        )
      ).message
    ).toBe(MEDIA_SUBMIT_ERROR.submitFailed)
  })

  it('keeps the stable invalid-request reason intact', () => {
    const error = new Error(MEDIA_SUBMIT_ERROR.invalidRequest)
    expect(toSafeMediaSubmitError(error)).toBe(error)
  })
})
