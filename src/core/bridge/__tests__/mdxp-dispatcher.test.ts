import { ErrorCodes, InitializeParamsSchema } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MdxpDispatcher } from '../mdxp-dispatcher'
import type { MdxpSessionContext } from '../mdxp-session-context'

const fakeCtx = {
  identity: { kind: 'extension', browser: 'chromium', extensionId: 'abc' },
  startedAt: 0,
  isReady: () => true,
  markReady: () => {},
  pendingPair: null,
} as MdxpSessionContext

describe('MdxpDispatcher', () => {
  it('validates params then calls the handler with typed params + ctx', async () => {
    const d = new MdxpDispatcher()
    const handler = vi.fn(async (params: { x: number }) => ({
      doubled: params.x * 2,
    }))
    d.register('demo/echo', z.object({ x: z.number() }), handler)

    const result = await d.dispatch('demo/echo', { x: 21 }, fakeCtx)

    expect(result).toEqual({ doubled: 42 })
    expect(handler).toHaveBeenCalledWith({ x: 21 }, fakeCtx)
  })

  it('throws InvalidParams when params fail the schema', async () => {
    const d = new MdxpDispatcher()
    d.register('demo/echo', z.object({ x: z.number() }), async () => null)
    await expect(
      d.dispatch('demo/echo', { x: 'nope' }, fakeCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('throws CapabilityNotSupported for an unregistered method', async () => {
    const d = new MdxpDispatcher()
    await expect(d.dispatch('demo/missing', {}, fakeCtx)).rejects.toMatchObject(
      { code: ErrorCodes.CapabilityNotSupported }
    )
  })

  it('has() reports registration state', () => {
    const d = new MdxpDispatcher()
    expect(d.has('demo/echo')).toBe(false)
    d.register('demo/echo', z.object({}), async () => null)
    expect(d.has('demo/echo')).toBe(true)
  })

  it('validates a real mdxp schema: motrix/initialize rejects a bad protocolVersion', async () => {
    // Guards the turbo-side contract that the dispatcher actually validates
    // initialize params (the check that previously lived in initializeHandler's
    // own safeParse now lives at the dispatcher boundary).
    const d = new MdxpDispatcher()
    const handler = vi.fn(async () => ({ ok: true }))
    d.register('motrix/initialize', InitializeParamsSchema, handler)

    await expect(
      d.dispatch(
        'motrix/initialize',
        {
          protocolVersion: '2.0',
          client: {
            name: 'x',
            version: '1',
            extensionId: 'abc',
            browser: 'chromium',
            browserVersion: '1',
            locale: 'en',
          },
          capabilities: {},
          adapters: [],
        },
        fakeCtx
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
    expect(handler).not.toHaveBeenCalled()
  })
})
