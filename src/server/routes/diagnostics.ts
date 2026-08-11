import type { FastifyInstance } from 'fastify'

export function registerServerDiagnosticsRoute(
  app: FastifyInstance,
  snapshot: () => unknown | Promise<unknown>
): void {
  app.get('/api/diagnostics', async (_request, reply) => {
    try {
      return await snapshot()
    } catch (cause) {
      return reply.code(500).send({
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  })
}
