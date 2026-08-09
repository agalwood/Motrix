import { DeviceCodeService } from '@core/bridge/device-code-service'
import type { PairedClient, PairingService } from '@core/bridge/pairing-service'
import { BridgeCommands } from '@shared/protocol/bridge'
import { Commands } from '@shared/protocol/commands'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'

const TOKEN = 'machine-owner-token-xyz'

/** Pull the mtx_op cookie value out of a Set-Cookie header. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const header = Array.isArray(raw) ? raw[0] : (raw as string)
  return header.split(';')[0] // "mtx_op=<id>"
}

describe('operator auth gate', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp({
      commandHandlers: {
        [Commands.AddMagnetTask]: async () => ({ ok: true }),
      },
      queryHandlers: {},
      operatorAuth: { operatorToken: TOKEN },
    })
  })
  afterEach(async () => {
    await app.close()
  })

  const cmd = (over = {}) => ({
    method: 'POST' as const,
    url: `/rpc/command/${encodeURIComponent(Commands.AddMagnetTask)}`,
    payload: { args: [{}] },
    ...over,
  })

  it('rejects an anonymous /rpc/command with 401', async () => {
    expect((await app.inject(cmd())).statusCode).toBe(401)
  })

  it('rejects an anonymous /api/* route with 401 (gate is not /rpc-scoped)', async () => {
    // The onRequest gate runs before routing, so even an unregistered /api path
    // is denied rather than 404 — proving the deny-by-default coverage.
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/pause-all',
    })
    expect(res.statusCode).toBe(401)
  })

  it('leaves /healthz and the unlock/status endpoints public', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/healthz' })).statusCode
    ).toBe(200)
    const status = await app.inject({ method: 'GET', url: '/rpc/auth/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual({ authed: false })
  })

  it('rejects login with a wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: 'nope' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('login with the operator token issues an httpOnly SameSite=Strict cookie that authorizes /rpc', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: TOKEN },
    })
    expect(login.statusCode).toBe(200)
    const setCookie = login.headers['set-cookie'] as string
    expect(setCookie).toContain('mtx_op=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')

    const cookie = sessionCookie(login)
    const res = await app.inject(cmd({ headers: { cookie } }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const status = await app.inject({
      method: 'GET',
      url: '/rpc/auth/status',
      headers: { cookie },
    })
    expect(status.json()).toEqual({ authed: true })
  })

  it('accepts a Bearer operator token (host-script path)', async () => {
    const res = await app.inject(
      cmd({ headers: { authorization: `Bearer ${TOKEN}` } })
    )
    expect(res.statusCode).toBe(200)
  })

  it('logout invalidates the session', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: TOKEN },
    })
    const cookie = sessionCookie(login)
    await app.inject({
      method: 'POST',
      url: '/rpc/auth/logout',
      headers: { cookie },
    })
    expect((await app.inject(cmd({ headers: { cookie } }))).statusCode).toBe(
      401
    )
  })

  it('rejects a cross-origin mutation even with a valid cookie (CSRF defense)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: TOKEN },
    })
    const cookie = sessionCookie(login)
    const res = await app.inject(
      cmd({
        headers: { cookie, origin: 'http://evil.example', host: 'nas.local' },
      })
    )
    expect(res.statusCode).toBe(403)
  })

  it('rate-limits repeated FAILED login attempts', async () => {
    let last = 0
    for (let i = 0; i < 21; i++) {
      last = (
        await app.inject({
          method: 'POST',
          url: '/rpc/auth/login',
          payload: { token: 'wrong' },
        })
      ).statusCode
    }
    expect(last).toBe(429)
  })

  it('a correct token still logs in after the failure window is saturated (no DoS)', async () => {
    // An attacker flooding wrong tokens must not lock out the operator.
    for (let i = 0; i < 30; i++) {
      await app.inject({
        method: 'POST',
        url: '/rpc/auth/login',
        payload: { token: 'wrong' },
      })
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: TOKEN },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['set-cookie']).toBeDefined()
  })
})

describe('device-code approval is gated by the operator (the Codex bypass)', () => {
  function fakePairing(): PairingService {
    let n = 0
    return {
      issueToken: async (identity: PairedClient['identity'], name: string) =>
        ({
          identity,
          token: `tok-${++n}`,
          name,
          pairedAt: 0,
          lastActiveAt: null,
        }) as PairedClient,
    } as unknown as PairingService
  }

  const resolveUrl = `/rpc/command/${encodeURIComponent(BridgeCommands.ResolvePair)}`

  it('an anonymous resolvePair cannot approve a device-code request; only the operator can', async () => {
    const dc = new DeviceCodeService(fakePairing())
    const app = await createApp({
      commandHandlers: {},
      queryHandlers: {},
      bridgeCommandHandlers: {
        [BridgeCommands.ResolvePair]: async (...args: unknown[]) => {
          const p = args[0] as {
            kind: string
            requestId: string
            decision: string
          }
          if (p.kind === 'cli' && p.decision === 'allow') {
            await dc.approve(p.requestId)
          }
        },
      },
      operatorAuth: { operatorToken: TOKEN },
    })
    const { requestId } = dc.request('Agent', '1')

    // Anonymous self-approval — the whole attack — is blocked before the handler.
    const anon = await app.inject({
      method: 'POST',
      url: resolveUrl,
      payload: { args: [{ kind: 'cli', requestId, decision: 'allow' }] },
    })
    expect(anon.statusCode).toBe(401)
    expect(dc.poll(requestId).status).toBe('pending') // NOT approved

    // The machine-owner operator can approve.
    const ok = await app.inject({
      method: 'POST',
      url: resolveUrl,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { args: [{ kind: 'cli', requestId, decision: 'allow' }] },
    })
    expect(ok.statusCode).toBe(200)
    expect(dc.poll(requestId).status).toBe('approved')
    await app.close()
  })
})

describe('operator auth disabled (no operatorAuth option)', () => {
  it('leaves /rpc open when not configured (back-compat for unit tests)', async () => {
    const app = await createApp({
      commandHandlers: { [Commands.AddMagnetTask]: async () => ({ ok: true }) },
      queryHandlers: {},
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/command/${encodeURIComponent(Commands.AddMagnetTask)}`,
      payload: { args: [{}] },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
