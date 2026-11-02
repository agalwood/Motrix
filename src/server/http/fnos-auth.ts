import type { FastifyInstance, FastifyRequest } from 'fastify'
import { fnosUser } from '../platform/fnos/files'
import {
  type FnosGatewayOptions,
  fnosPrincipal,
} from '../platform/fnos/identity'
import type { OperatorSessionPolicy } from './operator-auth'

function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return false
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  const protocol = req.headers['x-forwarded-proto']
  if (typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.origin === origin &&
      parsed.host === host &&
      (protocol === undefined || parsed.protocol === `${protocol}:`)
    )
  } catch {
    return false
  }
}

export function registerFnosAuth(
  app: FastifyInstance,
  opts: FnosGatewayOptions
): OperatorSessionPolicy {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const pathname = req.url.split('?')[0]
    if (req.method === 'GET' && pathname === '/healthz') return
    const principal = fnosPrincipal(req, opts)
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket'
    const forbiddenOrigin =
      principal &&
      (upgrade || req.headers.origin !== undefined) &&
      !sameOrigin(req)
    if (!principal || forbiddenOrigin) {
      const code = forbiddenOrigin ? 403 : 401
      if (upgrade) {
        reply.hijack()
        req.raw.socket.end(
          `HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        )
        return
      }
      return reply
        .code(code)
        .send({ error: 'fnos administrator session required' })
    }
  })
  app.get('/rpc/auth/status', async (req) => ({
    authed: true,
    mode: 'fnosGateway',
    canLogout: false,
    username: fnosPrincipal(req, opts)?.username,
  }))
  app.addHook('preHandler', (req, _reply, done) => {
    const uid = fnosPrincipal(req, opts)?.uid
    if (uid === undefined) done()
    else fnosUser.run(uid, done)
  })
  return {
    principal(req) {
      const user = fnosPrincipal(req, opts)
      return user ? { id: `fnos:${user.uid}`, eligible: () => true } : undefined
    },
    bindSocket(req, socket) {
      const user = fnosPrincipal(req, opts)
      let eligible = user !== undefined
      // Reconnect through the gateway regularly so revoked NAS sessions cannot
      // retain an indefinitely authorized event stream.
      const timer = setTimeout(() => {
        eligible = false
        socket.close(4401, 'Gateway reauthentication required')
      }, 60_000)
      timer.unref()
      return {
        eligible: () => eligible,
        dispose: () => {
          clearTimeout(timer)
          eligible = false
        },
      }
    },
  }
}
