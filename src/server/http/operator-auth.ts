import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Operator auth for the server-shell control plane (Spec 9).
 *
 * The Fastify app serves the OPERATOR control plane (`/rpc/*`, `/api/*`,
 * `/rpc/events`) — distinct from the agent API on the bridge (`/mdxp`). Anyone
 * who reaches `:8080` must NOT be able to drive the instance or, critically,
 * approve a device-code pairing (which mints an agent token). The operator is
 * "the machine owner" — proven by the independently provisioned operator
 * token (`MOTRIX_OPERATOR_TOKEN` or `<dataDir>/operator-token`). The browser
 * proves it once via `POST /rpc/auth/login` and gets an httpOnly,
 * SameSite=Strict session cookie; host scripts may instead send
 * `Authorization: Bearer <operatorToken>`.
 *
 * The gate is DENY-BY-DEFAULT with a small public allow-list — NOT scoped to
 * `/rpc/*` — because the actionable surface also includes `/api/tasks/*`.
 */

const COOKIE = 'mtx_op'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 60_000
const LOGIN_MAX = 20

export interface OperatorAuthOptions {
  /**
   * The operator (machine-owner) secret that authorizes the control plane.
   * Provisioned INDEPENDENTLY of the bridge (Spec 9 / F1) — it is NOT the agent
   * `/mdxp` localToken, so a leaked operator credential grants no agent access
   * and the control plane never depends on the (non-fatal) bridge bootstrap.
   */
  operatorToken: string
  /** Public operator URL advertised by MOTRIX_PUBLIC_URL. Cookie-authenticated
   * event WebSockets must present this exact URL origin; scripts using Bearer
   * authentication remain independent of browser Origin semantics. */
  publicUrl?: string
  /** Injectable clock (tests). */
  now?: () => number
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

/** Constant-time compare immune to length differences (hash both → fixed len,
 *  so `timingSafeEqual` never throws on a length mismatch). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = part.slice(i + 1).trim()
  }
  return out
}

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null
  return h.slice(7)
}

function isSecure(req: FastifyRequest): boolean {
  return (
    req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https'
  )
}

function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

function configuredPublicOrigin(value: string | undefined): string | null {
  if (value === undefined) return null
  try {
    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function exactBrowserOrigin(
  req: FastifyRequest,
  publicOrigin: string | null
): boolean {
  const presented = req.headers.origin
  if (typeof presented !== 'string' || presented.length === 0) return false
  const expected =
    publicOrigin ??
    (() => {
      const host = req.headers.host
      if (typeof host !== 'string' || host.length === 0) return null
      try {
        return new URL(`${isSecure(req) ? 'https' : 'http'}://${host}`).origin
      } catch {
        return null
      }
    })()
  return expected !== null && presented === expected
}

/** Deny a request. A normal `reply.send()` does NOT yield a clean HTTP response
 *  on a WebSocket UPGRADE request (the client just hangs), so for an upgrade we
 *  hijack and write a raw status line so the `ws` client gets `unexpected-response`. */
function deny(
  req: FastifyRequest,
  reply: FastifyReply,
  code: number,
  message: string
): FastifyReply | undefined {
  const isUpgrade = isWebSocketUpgrade(req)
  if (isUpgrade) {
    reply.hijack()
    const text = code === 403 ? 'Forbidden' : 'Unauthorized'
    req.raw.socket.write(
      `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    )
    req.raw.socket.destroy()
    return undefined
  }
  return reply.code(code).send({ error: message })
}

/** Public (no-auth) routes. Everything else requires the operator. The login
 *  endpoint is self-protected (it requires the localToken in its body). */
function isPublic(method: string, url: string): boolean {
  const path = url.split('?')[0]
  if (method === 'GET' && path === '/healthz') return true
  if (method === 'POST' && path === '/rpc/auth/login') return true
  if (method === 'GET' && path === '/rpc/auth/status') return true
  // Static SPA shell + assets: any GET that is not under /rpc or /api. The
  // unlock screen must load before the operator can authenticate; the bundle
  // carries no privileged data.
  if (
    method === 'GET' &&
    !path.startsWith('/rpc/') &&
    !path.startsWith('/api/')
  ) {
    return true
  }
  return false
}

export function registerOperatorAuth(
  app: FastifyInstance,
  opts: OperatorAuthOptions
): void {
  const now = opts.now ?? Date.now
  const publicOrigin = configuredPublicOrigin(opts.publicUrl)
  const sessions = new Map<string, number>() // sessionId -> expiresAt
  let failedLogins: number[] = [] // timestamps of FAILED attempts only

  const validSession = (id: string | undefined): boolean => {
    if (!id) return false
    const exp = sessions.get(id)
    if (!exp) return false
    if (now() > exp) {
      sessions.delete(id)
      return false
    }
    sessions.set(id, now() + SESSION_TTL_MS) // sliding renewal
    return true
  }

  const authenticate = (req: FastifyRequest): 'bearer' | 'cookie' | null => {
    const tok = bearerToken(req)
    if (tok && safeEqual(tok, opts.operatorToken)) return 'bearer'
    return validSession(parseCookies(req.headers.cookie)[COOKIE])
      ? 'cookie'
      : null
  }

  // ── deny-by-default gate ────────────────────────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (path.startsWith('/rpc/') || path.startsWith('/api/')) {
      // Operator responses can contain live pairing codes, task metadata, and
      // other machine-owner state. Keep them out of browser/proxy caches even
      // when the request is rejected or the caller used Bearer auth.
      reply.header('cache-control', 'no-store')
      reply.header('pragma', 'no-cache')
    }
    if (isPublic(req.method, req.url)) return
    const authentication = authenticate(req)
    // CSRF defense-in-depth on mutations: reject a present-but-cross-origin
    // Origin. SameSite=Strict is the primary defense; non-browser callers omit
    // Origin and authenticate by Bearer.
    if (req.method !== 'GET') {
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        let sameOrigin = false
        try {
          sameOrigin = new URL(origin).host === req.headers.host
        } catch {
          sameOrigin = false
        }
        if (!sameOrigin) {
          return deny(req, reply, 403, 'cross-origin forbidden')
        }
      }
    }
    if (authentication === null) {
      return deny(req, reply, 401, 'unauthorized')
    }
    if (
      isWebSocketUpgrade(req) &&
      authentication === 'cookie' &&
      !exactBrowserOrigin(req, publicOrigin)
    ) {
      return deny(req, reply, 403, 'cross-origin forbidden')
    }
  })

  // ── auth routes ─────────────────────────────────────────────────────────
  app.post<{ Body: { token?: string } }>(
    '/rpc/auth/login',
    async (req, reply) => {
      const t = now()
      const token = typeof req.body?.token === 'string' ? req.body.token : ''
      // Verify FIRST: a correct token is NEVER blocked by the failure limiter,
      // so a remote attacker flooding wrong tokens cannot lock out the operator.
      // (Token is never logged — mirrors EndpointFileWriter's rule.)
      if (token && safeEqual(token, opts.operatorToken)) {
        const id = randomBytes(32).toString('base64url')
        sessions.set(id, t + SESSION_TTL_MS)
        const flags = [
          `${COOKIE}=${id}`,
          'HttpOnly',
          'SameSite=Strict',
          'Path=/',
          `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ]
        if (isSecure(req)) flags.push('Secure')
        reply.header('set-cookie', flags.join('; '))
        return { ok: true }
      }
      // Rate-limit ONLY failed attempts (256-bit token → brute force is
      // infeasible regardless; this just bounds log spam / probing).
      failedLogins = failedLogins.filter((ts) => ts > t - LOGIN_WINDOW_MS)
      if (failedLogins.length >= LOGIN_MAX) {
        return reply.code(429).send({ error: 'too many attempts' })
      }
      failedLogins.push(t)
      return reply.code(401).send({ error: 'invalid token' })
    }
  )

  app.get('/rpc/auth/status', async (req) => ({
    authed: authenticate(req) !== null,
  }))

  app.post('/rpc/auth/logout', async (req, reply) => {
    const id = parseCookies(req.headers.cookie)[COOKIE]
    if (id) sessions.delete(id)
    reply.header(
      'set-cookie',
      `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    )
    return { ok: true }
  })
}
