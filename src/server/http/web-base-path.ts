import type { IncomingMessage } from 'node:http'
import type { FastifyInstance } from 'fastify'

/** Normalize before routing AND authentication, including caller-added routes. */
export function createWebBasePath(value = '') {
  const basePath = value === '/' ? '' : value.replace(/\/$/, '')
  if (basePath && !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(basePath)) {
    throw new Error('Invalid MOTRIX_WEB_BASE_PATH')
  }
  const outside = new WeakSet<IncomingMessage>()
  const redirect = new WeakSet<IncomingMessage>()
  return {
    basePath,
    rewriteUrl(req: IncomingMessage) {
      const url = req.url ?? '/'
      if (!basePath) return url
      const [pathname] = url.split('?')
      if (pathname === basePath) {
        redirect.add(req)
        return `/${url.slice(basePath.length)}`
      }
      if (pathname.startsWith(`${basePath}/`)) return url.slice(basePath.length)
      outside.add(req)
      return '/'
    },
    register(app: FastifyInstance) {
      app.addHook('onRequest', async (req, reply) => {
        if (outside.has(req.raw))
          return reply.code(404).send({ error: 'not found' })
        if (redirect.has(req.raw)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return reply.code(404).send({ error: 'not found' })
          }
          const query = req.url.includes('?')
            ? req.url.slice(req.url.indexOf('?'))
            : ''
          return reply.redirect(`${basePath}/${query}`, 308)
        }
      })
    },
  }
}
