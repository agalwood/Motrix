import { randomBytes } from 'node:crypto'
import { getLogger } from '@core/logger'
import {
  type ClientPairingCapabilities,
  FNOS_EVENT_PROTOCOL,
  FNOS_EVENT_TICKET_PREFIX,
  type NasCapabilities,
  nasAuthDiagnosticSchema,
  WEB_ORIGIN_HEADER,
} from '@shared/schemas/operator-auth'
import { webEventRenewalSchema } from '@shared/schemas/web-event-stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { NasIdentity } from '../platform/nas/identity'
import { runAsNasGatewayUser } from '../platform/nas/identity'
import { NAS_EVENT_AUTH_MS, NasEventSessions } from './nas-event-sessions'
import type { OperatorSessionPolicy } from './operator-auth'

type Principal = NasIdentity
export interface NasGatewayOptions {
  mode: 'fnosGateway' | 'synologyDsm'
  now?: () => number
  isListener(req: FastifyRequest): boolean
  authenticate(
    req: FastifyRequest
  ): Principal | undefined | Promise<Principal | undefined>
  hasIdentity(req: FastifyRequest): boolean
  diagnostic?(req: FastifyRequest): object | undefined
  publicShell?: boolean
  capabilities?: NasCapabilities
  unavailableDownloadRoots?: readonly string[]
}
interface EventTicket {
  principal: Principal
  origin: string
  expiresAt: number
  sessionExpiresAt: number
}

function browserOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    if (
      ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.origin === value
    )
      return value
  } catch {
    /* Reject malformed or opaque origins. */
  }
  return undefined
}

/** A cross-origin browser cannot supply this non-safelisted header without a
 * CORS preflight. This listener never permits preflights or enables CORS.
 * fnOS rewrites Host (including its port), so it cannot identify the browser
 * origin. The marker must also match Origin when the browser supplies it. */
function requestOrigin(req: FastifyRequest): string | undefined {
  const marker = browserOrigin(req.headers[WEB_ORIGIN_HEADER])
  if (
    !marker ||
    (req.headers.origin !== undefined && req.headers.origin !== marker)
  )
    return undefined
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none')
    return undefined
  return marker
}

export function registerNasAuth(
  app: FastifyInstance,
  opts: NasGatewayOptions,
  clientPairing: ClientPairingCapabilities = { cli: false, extension: false }
): OperatorSessionPolicy {
  const log = getLogger('nas:auth')
  const now = opts.now ?? Date.now
  const sessions = new NasEventSessions(now)
  let lastRejectionAt = -Infinity
  const tickets = new Map<string, EventTicket>()
  const identities = new WeakMap<FastifyRequest, Principal>()
  const socketExpirations = new WeakMap<FastifyRequest, number>()
  app.addHook('onClose', async () => {
    tickets.clear()
  })
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const pathname = req.url.split('?')[0]
    if (req.method === 'GET' && pathname === '/healthz') return
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket'
    let principal = await opts.authenticate(req)
    let reason: string | undefined
    if (!opts.isListener(req)) reason = 'untrusted-listener'
    else if (upgrade) {
      const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((value) => value.trim())
      const token =
        protocols.length === 2 &&
        protocols[0] === FNOS_EVENT_PROTOCOL &&
        protocols[1].startsWith(FNOS_EVENT_TICKET_PREFIX)
          ? protocols[1].slice(FNOS_EVENT_TICKET_PREFIX.length)
          : ''
      const ticket = tickets.get(token)
      tickets.delete(token)
      const hasIdentityHeaders = opts.hasIdentity(req)
      if (!ticket || ticket.expiresAt <= now()) reason = 'event-ticket-required'
      else if (req.headers.origin !== ticket.origin) reason = 'origin-mismatch'
      else if (
        hasIdentityHeaders &&
        (!principal ||
          principal.userId !== ticket.principal.userId ||
          principal.username !== ticket.principal.username ||
          principal.accountRevision !== ticket.principal.accountRevision)
      )
        reason = 'identity-rejected'
      else {
        // Some gateway versions omit X-Trim-* on upgrades. Only a one-use
        // ticket from a freshly authenticated HTTP request can supply identity.
        principal = ticket.principal
        socketExpirations.set(req, ticket.sessionExpiresAt)
      }
    } else if (!principal) reason = 'identity-rejected'
    else if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !requestOrigin(req)
    )
      reason = 'origin-mismatch'
    if (reason || !principal) {
      // A rejected DSM session can only consume its own origin-bound renewal
      // challenge and close the stream. All data routes still require identity.
      if (
        opts.mode === 'synologyDsm' &&
        reason === 'identity-rejected' &&
        !upgrade &&
        req.method === 'POST' &&
        pathname === '/rpc/auth/event-renew' &&
        requestOrigin(req)
      )
        return
      // An unauthenticated browser may load the shell and its status message;
      // all data and command endpoints remain behind the same gate.
      if (
        opts.publicShell &&
        opts.isListener(req) &&
        !upgrade &&
        req.method === 'GET' &&
        (pathname === '/rpc/auth/status' ||
          pathname === '/' ||
          pathname === '/index.html' ||
          pathname.startsWith('/assets/'))
      )
        return
      const code = reason === 'origin-mismatch' ? 403 : 401
      const diagnostic = opts.diagnostic?.(req)
      if (now() - lastRejectionAt >= 60_000) {
        lastRejectionAt = now()
        log.warn({ reason, diagnostic }, 'NAS gateway request rejected')
      }
      if (upgrade) {
        reply.hijack()
        req.raw.socket.end(
          `HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        )
        return
      }
      return reply.code(code).send({
        error: 'NAS administrator session required',
        reason,
        diagnostic,
      })
    }
    identities.set(req, principal)
  })
  app.get('/rpc/auth/status', async (req) => {
    const diagnostic =
      opts.mode === 'synologyDsm' && !identities.has(req)
        ? nasAuthDiagnosticSchema.safeParse(opts.diagnostic?.(req))
        : undefined
    return {
      authed: identities.has(req),
      mode: opts.mode,
      canLogout: false,
      username: identities.get(req)?.username,
      clientPairing,
      ...(opts.capabilities ? { nasCapabilities: opts.capabilities } : {}),
      ...(identities.has(req) && opts.unavailableDownloadRoots?.length
        ? { nasUnavailableDownloadRoots: opts.unavailableDownloadRoots }
        : {}),
      ...(diagnostic?.success ? { nasAuthDiagnostic: diagnostic.data } : {}),
    }
  })
  app.post('/rpc/auth/event-ticket', async (req, reply) => {
    const principal = identities.get(req)
    const origin = requestOrigin(req)
    if (!principal || !origin)
      return reply.code(403).send({ error: 'unauthorized' })
    for (const [key, ticket] of tickets)
      if (ticket.expiresAt <= now()) tickets.delete(key)
    if (tickets.size >= 256)
      return reply
        .code(429)
        .send({ error: 'too many pending event connections' })
    const token = randomBytes(24).toString('base64url')
    tickets.set(token, {
      principal,
      origin,
      expiresAt: now() + 30_000,
      sessionExpiresAt: now() + NAS_EVENT_AUTH_MS,
    })
    return { ticket: token }
  })
  if (opts.mode === 'synologyDsm') {
    app.post('/rpc/auth/event-renew', { bodyLimit: 512 }, (req, reply) => {
      const owner = identities.get(req)
      const origin = requestOrigin(req)
      const frame = webEventRenewalSchema.safeParse(req.body)
      if (!frame.success)
        return reply.code(400).send({ error: 'Invalid event renewal' })
      if (!origin || !sessions.renew(frame.data.challenge, origin, owner))
        return reply
          .code(owner ? 403 : 401)
          .send({ error: 'Event renewal denied' })
      return reply.code(204).send()
    })
  }
  app.addHook('preHandler', (req, _reply, done) => {
    const principal = identities.get(req)
    if (!principal) done()
    else runAsNasGatewayUser(principal, done)
  })
  return {
    principal(req) {
      const user = identities.get(req)
      return user
        ? { id: `${user.platform}:${user.userId}`, eligible: () => true }
        : undefined
    },
    bindSocket(req, socket) {
      return sessions.bind(
        socket,
        socketExpirations.get(req) ?? now(),
        identities.get(req),
        opts.mode === 'synologyDsm'
          ? browserOrigin(req.headers.origin)
          : undefined
      )
    },
  }
}
