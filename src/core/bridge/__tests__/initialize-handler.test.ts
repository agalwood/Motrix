import { createInitializeHandler } from '@core/bridge/handlers/initialize-handler'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import type { PairRequestArgs } from '@core/bridge/web-socket-bridge-server'
import { ErrorCodes } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'

const baseCapabilities = {
  motrixVersion: '2.0',
  ffmpegAvailable: true,
}

const validClientInfo = {
  protocolVersion: '1.0',
  // Post-validation shape: the dispatcher's InitializeParamsSchema injects
  // kind:'extension' for the shipped extension (compat shim), so the handler
  // always sees a discriminated `client`.
  client: {
    kind: 'extension' as const,
    name: 'motrix-extension',
    version: '0.1',
    extensionId: 'abc',
    browser: 'chromium' as const,
    browserVersion: '120',
    locale: 'en',
  },
  capabilities: {},
  adapters: [],
}

const fakePairArgs: PairRequestArgs = {
  extensionId: 'abc',
  browser: 'chromium',
  extensionName: 'Test Ext',
  extensionVersion: '0.1',
}

function makeCtx(opts: {
  extensionId?: string
  pendingPair?: PairRequestArgs | null
  markAuthorized?: () => void
}): MdxpSessionContext {
  return {
    identity: {
      kind: 'extension',
      browser: 'chromium',
      extensionId: opts.extensionId ?? 'abc',
    },
    startedAt: 0,
    isReady: () => false,
    markReady: () => {},
    isAuthorized: () => false,
    markAuthorized: opts.markAuthorized ?? (() => {}),
    pendingPair: opts.pendingPair ?? null,
  }
}

describe('initialize handler', () => {
  it('first-pair success: returns pairToken + capabilities', async () => {
    const issueToken = vi.fn().mockResolvedValue({ token: 'tok-1' })
    const onPairRequest = vi
      .fn()
      .mockResolvedValue({ decision: 'allow', addToRegistry: false })
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken } as never,
      registry: { has: () => false, add: vi.fn() } as never,
      onPairRequest,
    })

    const markAuthorized = vi.fn()
    const result = await handler(
      validClientInfo as never,
      makeCtx({ pendingPair: fakePairArgs, markAuthorized })
    )

    expect(result.protocolVersion).toBe('1.0')
    expect(result.server.name).toBe('motrix')
    expect(result.pairToken).toBe('tok-1')
    expect(onPairRequest).toHaveBeenCalledWith(fakePairArgs)
    // Approval authorizes the session for control-plane / download methods.
    expect(markAuthorized).toHaveBeenCalledOnce()
  })

  it('first-pair deny: does NOT authorize the session', async () => {
    const markAuthorized = vi.fn()
    const onPairRequest = vi
      .fn()
      .mockResolvedValue({ decision: 'deny', addToRegistry: false })
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken: vi.fn() } as never,
      registry: { has: () => false } as never,
      onPairRequest,
    })

    await expect(
      handler(
        validClientInfo as never,
        makeCtx({ pendingPair: fakePairArgs, markAuthorized })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.PermissionDenied })
    expect(markAuthorized).not.toHaveBeenCalled()
  })

  it('first-pair deny: throws -32003 Permission denied', async () => {
    const onPairRequest = vi
      .fn()
      .mockResolvedValue({ decision: 'deny', addToRegistry: false })
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken: vi.fn() } as never,
      registry: { has: () => false } as never,
      onPairRequest,
    })

    await expect(
      handler(validClientInfo as never, makeCtx({ pendingPair: fakePairArgs }))
    ).rejects.toMatchObject({ code: ErrorCodes.PermissionDenied })
  })

  it('reconnect (pendingPair=null): returns capabilities without minting a token', async () => {
    const issueToken = vi.fn()
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken } as never,
      registry: { has: () => true } as never,
      onPairRequest: vi.fn(),
    })

    const result = await handler(
      validClientInfo as never,
      makeCtx({ pendingPair: null })
    )

    expect(result.protocolVersion).toBe('1.0')
    expect(issueToken).not.toHaveBeenCalled()
    expect(result.pairToken).toBeUndefined()
  })

  it('reconnect rejects mismatched extensionId in params vs session', async () => {
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken: vi.fn() } as never,
      registry: { has: () => true } as never,
      onPairRequest: vi.fn(),
    })

    await expect(
      handler(
        {
          ...validClientInfo,
          client: { ...validClientInfo.client, extensionId: 'xyz' },
        } as never,
        makeCtx({ extensionId: 'abc', pendingPair: null })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('reconnect fails closed for a non-extension client kind', async () => {
    // v1 only admits extension reconnect; a non-extension kind must be rejected
    // outright, not skip the identity check (no fail-open auth gate).
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken: vi.fn() } as never,
      registry: { has: () => true } as never,
      onPairRequest: vi.fn(),
    })

    await expect(
      handler(
        {
          ...validClientInfo,
          client: { kind: 'cli', name: 'motrix-cli', version: '2.0' },
        } as never,
        makeCtx({ extensionId: 'abc', pendingPair: null })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('reconnect fails closed for a non-extension session identity', async () => {
    // The /v1 route only ever creates extension sessions, but the handler must
    // not assume it: a cli-kind session identity reconnecting (a future
    // device-code session) must be rejected, not silently bypass the
    // extensionId match against an absent field.
    const handler = createInitializeHandler({
      ...baseCapabilities,
      pairing: { issueToken: vi.fn() } as never,
      registry: { has: () => true } as never,
      onPairRequest: vi.fn(),
    })

    const cliCtx: MdxpSessionContext = {
      identity: { kind: 'cli', id: 'local' },
      startedAt: 0,
      isReady: () => false,
      markReady: () => {},
      isAuthorized: () => false,
      markAuthorized: () => {},
      pendingPair: null,
    }

    await expect(
      handler(validClientInfo as never, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('ffmpegAvailable:false → selectionKinds is only ["direct"]', async () => {
    const onPairRequest = vi
      .fn()
      .mockResolvedValue({ decision: 'allow', addToRegistry: false })
    const handler = createInitializeHandler({
      motrixVersion: '2.0',
      ffmpegAvailable: false,
      pairing: {
        issueToken: vi.fn().mockResolvedValue({ token: 'tok' }),
      } as never,
      registry: { has: () => false, add: vi.fn() } as never,
      onPairRequest,
    })
    const result = await handler(
      validClientInfo as never,
      makeCtx({ pendingPair: fakePairArgs })
    )
    expect(result.capabilities.selectionKinds).toEqual(['direct'])
  })

  it('ffmpegAvailable:true → selectionKinds is ["direct","hls","dash","mux"]', async () => {
    const onPairRequest = vi
      .fn()
      .mockResolvedValue({ decision: 'allow', addToRegistry: false })
    const handler = createInitializeHandler({
      motrixVersion: '2.0',
      ffmpegAvailable: true,
      pairing: {
        issueToken: vi.fn().mockResolvedValue({ token: 'tok' }),
      } as never,
      registry: { has: () => false, add: vi.fn() } as never,
      onPairRequest,
    })
    const result = await handler(
      validClientInfo as never,
      makeCtx({ pendingPair: fakePairArgs })
    )
    expect(result.capabilities.selectionKinds).toEqual([
      'direct',
      'hls',
      'dash',
      'mux',
    ])
  })
})
