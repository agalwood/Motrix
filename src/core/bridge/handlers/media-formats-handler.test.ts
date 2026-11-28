import { ErrorCodes, type MediaFormatsResult } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import type { MdxpSessionContext } from '../mdxp-session-context'
import { createMediaFormatsHandler } from './media-formats-handler'

const params = { url: 'https://example.com/watch' }
const result: MediaFormatsResult = {
  available: true,
  entries: [{ kind: 'video', key: '720p', label: '720p' }],
}

function context(overrides: Partial<MdxpSessionContext> = {}) {
  const session = new AbortController()
  const request = new AbortController()
  const ctx: MdxpSessionContext = {
    identity: { kind: 'extension', browser: 'chromium', extensionId: 'test' },
    startedAt: 0,
    pendingPair: null,
    isAuthorized: () => true,
    isReady: () => true,
    markAuthorized: () => {},
    markReady: () => {},
    sessionSignal: session.signal,
    requestSignal: AbortSignal.any([session.signal, request.signal]),
    ...overrides,
  }
  return { ctx, session, request }
}

describe('media/formats admission', () => {
  it.each([
    { isAuthorized: () => false },
    { isReady: () => false },
    { identity: { kind: 'cli', clientId: 'cli' } as never },
    { sessionSignal: undefined },
    { requestSignal: undefined },
  ])(
    'rejects a session without ready extension authority: %s',
    async (override) => {
      const list = vi.fn(async () => result)
      await expect(
        createMediaFormatsHandler(list)(params, context(override).ctx)
      ).rejects.toMatchObject({ code: ErrorCodes.PermissionDenied })
      expect(list).not.toHaveBeenCalled()
    }
  )

  it('rejects credentials before any shell work, while allowing an empty array', async () => {
    const list = vi.fn(async () => result)
    const handle = createMediaFormatsHandler(list)
    const { ctx } = context()
    await expect(
      handle(
        {
          ...params,
          cookies: [
            {
              name: 'session',
              value: 'secret',
              domain: 'example.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'lax',
            },
          ],
        },
        ctx
      )
    ).resolves.toEqual({
      available: false,
      reason: 'credentials-unsupported',
      entries: [],
    })
    expect(list).not.toHaveBeenCalled()
    await expect(handle({ ...params, cookies: [] }, ctx)).resolves.toEqual(
      result
    )
  })

  it('limits each connection to one and the server to two active queries', async () => {
    const pending = Promise.withResolvers<MediaFormatsResult>()
    const list = vi.fn(() => pending.promise)
    const handle = createMediaFormatsHandler(list)
    const a = context(),
      b = context(),
      c = context()
    const first = handle(params, a.ctx)
    await expect(handle(params, a.ctx)).rejects.toMatchObject({
      code: ErrorCodes.RateLimited,
    })
    const second = handle(params, b.ctx)
    await expect(handle(params, c.ctx)).rejects.toMatchObject({
      code: ErrorCodes.RateLimited,
    })
    // Cancelling does not free a slot while the child process is still draining.
    a.request.abort()
    await expect(handle(params, c.ctx)).rejects.toMatchObject({
      code: ErrorCodes.RateLimited,
    })
    const rejected = expect(first).rejects.toMatchObject({
      code: ErrorCodes.RequestCancelled,
    })
    pending.resolve(result)
    await rejected
    await second
    await expect(handle(params, c.ctx)).resolves.toEqual(result)
  })

  it.each(['request', 'session'] as const)(
    'discards results after %s cancellation',
    async (target) => {
      const pending = Promise.withResolvers<MediaFormatsResult>()
      const list = vi.fn(() => pending.promise)
      const state = context()
      const response = createMediaFormatsHandler(list)(params, state.ctx)
      state[target].abort()
      pending.resolve(result)
      await expect(response).rejects.toMatchObject({
        code: ErrorCodes.RequestCancelled,
      })
    }
  )

  it('rechecks authorization after a shell probe and releases failed work', async () => {
    let authorized = true
    const { ctx } = context({ isAuthorized: () => authorized })
    const handle = createMediaFormatsHandler(async () => {
      authorized = false
      return result
    })
    await expect(handle(params, ctx)).rejects.toMatchObject({
      code: ErrorCodes.PermissionDenied,
    })
  })

  it('sends only a parsed public result and refuses malformed output', async () => {
    const { ctx } = context()
    const handle = createMediaFormatsHandler(async () => ({
      ...result,
      secret: 'private',
    }))
    await expect(handle(params, ctx)).resolves.toEqual(result)
    const invalid = createMediaFormatsHandler(async () => ({
      available: true,
      entries: [],
    }))
    await expect(invalid(params, ctx)).resolves.toEqual({
      available: false,
      reason: 'invalid-result',
      entries: [],
    })
  })

  it('does not expose extractor error messages or retain failed admission slots', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('https://secret.example/?token=private'))
      .mockResolvedValue(result)
    const handle = createMediaFormatsHandler(list)
    const { ctx } = context()
    await expect(handle(params, ctx)).resolves.toEqual({
      available: false,
      reason: 'extractor-failed',
      entries: [],
    })
    await expect(handle(params, ctx)).resolves.toEqual(result)
  })
})
