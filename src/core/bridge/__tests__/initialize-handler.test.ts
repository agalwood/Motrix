import { createInitializeHandler } from '@core/bridge/handlers/initialize-handler'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import { ErrorCodes } from '@motrix/mdxp'
import type { Browser } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'

const baseCapabilities = {
  motrixVersion: '2.0',
  runtime: 'electron' as const,
  ffmpegAvailable: true,
  supportsTaskReveal: () => false,
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

function makeCtx(opts: {
  extensionId?: string
  browser?: Browser
  markAuthorized?: () => void
}): MdxpSessionContext {
  return {
    identity: {
      kind: 'extension',
      browser: opts.browser ?? 'chromium',
      extensionId: opts.extensionId ?? 'abc',
    },
    startedAt: 0,
    isReady: () => false,
    markReady: () => {},
    // Under MBP1 an extension session is authenticated at the transport, so it
    // arrives authorized; the handler must not be the gate that grants it.
    isAuthorized: () => true,
    markAuthorized: opts.markAuthorized ?? (() => {}),
    pendingPair: null,
  }
}

describe('initialize handler', () => {
  it('returns capabilities and never a pairToken', async () => {
    const handler = createInitializeHandler(baseCapabilities)

    const result = await handler(validClientInfo as never, makeCtx({}))

    expect(result.protocolVersion).toBe('1.0')
    expect(result.server.name).toBe('motrix')
    expect(result.pairToken).toBeUndefined()
  })

  it('does not authorize the session — the transport already did', async () => {
    // MBP1 authenticates below MDXP: `adoptAuthenticatedSession` marks the
    // connection authorized before any handler runs. A handler that also
    // granted authorization would be a second, weaker gate.
    const markAuthorized = vi.fn()
    const handler = createInitializeHandler(baseCapabilities)

    await handler(validClientInfo as never, makeCtx({ markAuthorized }))

    expect(markAuthorized).not.toHaveBeenCalled()
  })

  it('reports the runtime injected by the Server composition root', async () => {
    const handler = createInitializeHandler({
      ...baseCapabilities,
      runtime: 'server',
    })

    const result = await handler(validClientInfo as never, makeCtx({}))

    expect(result.server.runtime).toBe('server')
    expect(result.capabilities.taskReveal).toBe(false)
  })

  it('derives taskReveal from the currently registered shell capability', async () => {
    let registered = false
    const handler = createInitializeHandler({
      ...baseCapabilities,
      supportsTaskReveal: () => registered,
    })

    const beforeRegistration = await handler(
      validClientInfo as never,
      makeCtx({})
    )
    registered = true
    const afterRegistration = await handler(
      validClientInfo as never,
      makeCtx({})
    )

    expect(beforeRegistration.capabilities.taskReveal).toBe(false)
    expect(afterRegistration.capabilities.taskReveal).toBe(true)
  })

  it('rejects a mismatched extensionId on Chromium', async () => {
    // On Chromium the verified `Origin` host IS the extension id, so a client
    // that re-asserts a different one is inconsistent with its own transport.
    const handler = createInitializeHandler(baseCapabilities)

    await expect(
      handler(
        {
          ...validClientInfo,
          client: { ...validClientInfo.client, extensionId: 'xyz' },
        } as never,
        makeCtx({ extensionId: 'abc' })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('does not compare extensionId on Firefox, where the origin proves no Gecko id', async () => {
    // The session id is the `moz-extension://<UUID>` host; the client reports
    // its Gecko id. §5 says the two cannot be mapped to each other, so
    // comparing them would reject every legitimate Firefox session.
    const handler = createInitializeHandler(baseCapabilities)

    const result = await handler(
      {
        ...validClientInfo,
        client: {
          ...validClientInfo.client,
          browser: 'firefox',
          extensionId: 'motrix@example.org',
        },
      } as never,
      makeCtx({ browser: 'firefox', extensionId: 'a1b2c3d4-uuid' })
    )

    expect(result.protocolVersion).toBe('1.0')
  })

  it('fails closed for a non-extension client kind', async () => {
    // The MBP1 routes only admit extensions; a non-extension kind must be
    // rejected outright rather than skip the identity check.
    const handler = createInitializeHandler(baseCapabilities)

    await expect(
      handler(
        {
          ...validClientInfo,
          client: { kind: 'cli', name: 'motrix-cli', version: '2.0' },
        } as never,
        makeCtx({ extensionId: 'abc' })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('fails closed for a non-extension session identity', async () => {
    // `/pair` and `/v1` only ever create extension sessions, but the handler
    // must not assume it: a cli-kind session identity must be rejected, not
    // silently bypass the extensionId match against an absent field.
    const handler = createInitializeHandler(baseCapabilities)

    const cliCtx: MdxpSessionContext = {
      identity: { kind: 'cli', id: 'local' },
      startedAt: 0,
      isReady: () => false,
      markReady: () => {},
      isAuthorized: () => true,
      markAuthorized: () => {},
      pendingPair: null,
    }

    await expect(
      handler(validClientInfo as never, cliCtx)
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams })
  })

  it('ffmpegAvailable:false → selectionKinds is only ["direct"]', async () => {
    const handler = createInitializeHandler({
      ...baseCapabilities,
      ffmpegAvailable: false,
    })

    const result = await handler(validClientInfo as never, makeCtx({}))

    expect(result.capabilities.selectionKinds).toEqual(['direct'])
  })

  it('ffmpegAvailable:true → selectionKinds is ["direct","hls","dash","mux"]', async () => {
    const handler = createInitializeHandler(baseCapabilities)

    const result = await handler(validClientInfo as never, makeCtx({}))

    expect(result.capabilities.selectionKinds).toEqual([
      'direct',
      'hls',
      'dash',
      'mux',
    ])
  })
})
