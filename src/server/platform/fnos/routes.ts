import path from 'node:path'
import type { DownloadTask } from '@shared/types/task'
import { canOpenTaskFile } from '@shared/types/task-actions'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import { readNasTorrent } from '../nas/file-routes'
import type { NasFiles } from '../nas/files'
import { currentNasUser } from '../nas/identity'

const pathSchema = z.object({ path: z.string().min(1).max(4096) }).strict()
const taskSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    action: z.enum(['open', 'reveal']),
  })
  .strict()

export function registerFnosRoutes(
  app: FastifyInstance,
  files: NasFiles,
  policy: ServerDownloadPathPolicy,
  getTask: (id: string) => DownloadTask | undefined
) {
  app.post('/api/fnos/directory', async (req, reply) => {
    const body = pathSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid path' })
    try {
      return { path: await policy.prepareSaveDir(body.data.path) }
    } catch {
      return reply.code(403).send({ error: 'directory not authorized' })
    }
  })
  app.post('/api/fnos/task-path', async (req, reply) => {
    const body = taskSchema.safeParse(req.body)
    const user = currentNasUser()
    if (!body.success || user === undefined)
      return reply.code(400).send({ error: 'invalid request' })
    const task = getTask(body.data.taskId)
    if (!task || (body.data.action === 'open' && !canOpenTaskFile(task)))
      return reply.code(404).send({ error: 'output unavailable' })
    const stored = task.finalPath || task.diskPath
    if (!stored) return reply.code(404).send({ error: 'output unavailable' })
    try {
      const candidate =
        body.data.action === 'reveal' ? path.dirname(stored) : stored
      const canonical =
        body.data.action === 'reveal'
          ? (await policy.authorizeDirectory(candidate)).canonicalPath
          : await files.authorizeFile(candidate, policy, user)
      await files.check(canonical, 'readable', user)
      const current = getTask(task.id)
      if (!current || (current.finalPath || current.diskPath) !== stored)
        throw new Error('Task changed')
      return { path: canonical }
    } catch {
      return reply.code(403).send({ error: 'output not authorized' })
    }
  })
  app.post('/api/fnos/torrent', async (req, reply) => {
    const body = pathSchema.safeParse(req.body)
    const user = currentNasUser()
    if (
      !body.success ||
      user === undefined ||
      !body.data.path.toLowerCase().endsWith('.torrent')
    )
      return reply.code(400).send({ error: 'invalid torrent path' })
    try {
      const data = await readNasTorrent(body.data.path, files, policy, user)
      return reply.type('application/x-bittorrent').send(data)
    } catch {
      return reply.code(403).send({ error: 'torrent not authorized' })
    }
  })
}
