import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { Logger } from '@core/logger'
import type { TaskActionDeps } from '@core/task/actions'
import { pauseAllTasks, resumeAllTasks } from '@core/task/actions'
import type { FastifyInstance } from 'fastify'

export interface TasksBulkDeps extends TaskActionDeps {
  adapter: EngineAdapter
  log: Logger
}

export function registerTasksBulkRoutes(
  app: FastifyInstance,
  deps: TasksBulkDeps
): void {
  app.post('/api/tasks/pause-all', async (_req, reply) => {
    await pauseAllTasks(deps)
    reply.send({ ok: true })
  })

  app.post('/api/tasks/resume-all', async (_req, reply) => {
    await resumeAllTasks(deps)
    reply.send({ ok: true })
  })
}
