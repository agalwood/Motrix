import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  type CreateTorrentHooks,
  createTorrent,
} from '@core/torrent/create-torrent'
import type {
  TaskCreateCommandResult,
  TaskCreateRequest,
} from '@shared/schemas/add-task'
import {
  serverCreateTorrentSchema,
  TORRENT_CREATOR_API,
  TORRENT_SEED_HEADER,
  torrentExportSchema,
} from '@shared/schemas/create-torrent'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerDownloadPathPolicy } from '../download-path-policy'

export interface TorrentCreatorDeps {
  policy: ServerDownloadPathPolicy
  authorizeFile?: (canonical: string) => Promise<string>
  createTask: (request: TaskCreateRequest) => Promise<TaskCreateCommandResult>
}
type Result = Awaited<ReturnType<typeof createTorrent>>
type Principal = { id: string; eligible: () => boolean }
interface Job {
  id: string
  owner: string
  source: string
  touched: number
  abort: AbortController
  progress: number
  entries: Map<string, 'file' | 'directory'>
  result?: Result
  failed?: boolean
  reading?: boolean
  seed?: Promise<boolean>
}
const HASH_IDLE_LIMIT = 2 * 60_000
const IDLE_LIMIT = 10 * 60_000
const MAX_RESULTS = 4

/** Only authenticated requests can retrieve their own results. No metainfo or
 * source payload is persisted and creating/exporting alone never starts a task. */
export function registerTorrentCreator(
  app: FastifyInstance,
  deps: TorrentCreatorDeps,
  principal: (req: FastifyRequest) => Principal | undefined
) {
  const jobs = new Map<string, Job>()
  let running: Promise<void> | undefined
  let activeReads = 0
  const discard = (job: Job) => {
    job.abort.abort()
    jobs.delete(job.id)
  }
  const reap = () => {
    for (const job of jobs.values())
      if (
        Date.now() - job.touched >
        (job.result || job.failed ? IDLE_LIMIT : HASH_IDLE_LIMIT)
      )
        discard(job)
  }
  const timer = setInterval(reap, 60_000)
  timer.unref()
  app.addHook('onClose', async () => {
    clearInterval(timer)
    for (const job of jobs.values()) discard(job)
    await running
  })
  const authorize = async (candidate: string, kind: 'file' | 'directory') => {
    if (!path.isAbsolute(candidate) || candidate.includes('\0'))
      throw new Error('Invalid source')
    if (kind === 'directory')
      return (await deps.policy.authorizeDirectory(candidate)).canonicalPath
    await deps.policy.authorizeDirectory(path.dirname(candidate))
    const canonical = await realpath(candidate)
    await deps.policy.authorizeDirectory(path.dirname(canonical))
    if (
      deps.authorizeFile &&
      (await deps.authorizeFile(canonical)) !== canonical
    )
      throw new Error('Authorized file changed')
    if (!(await lstat(canonical)).isFile())
      throw new Error('Not a regular file')
    return canonical
  }
  const get = (req: FastifyRequest, id: string) => {
    reap()
    const job = jobs.get(id)
    const user = principal(req)
    if (!job || !user?.eligible() || user.id !== job.owner) return
    job.touched = Date.now()
    return job
  }
  function reserveResultSlot(owner: string) {
    if (jobs.size < MAX_RESULTS) return true
    const retained = [...jobs.values()]
    const idle = retained
      .filter((job) => !job.reading)
      .sort((a, b) => a.touched - b.touched)
    // Keep one successful result per owner before retaining a second one.
    // Failed jobs carry no useful result and can always be evicted.
    const victim =
      idle.find((job) => job.failed) ??
      idle.find((job) => job.owner === owner) ??
      idle.find((job) =>
        retained.some((other) => other !== job && other.owner === job.owner)
      )
    if (!victim) return false
    discard(victim)
    return true
  }

  // An info hash is a swarm identifier. Apply the same current per-entry grants
  // to revealing a ready summary as to exporting its bytes. Hold the slot
  // until both the filesystem work and the HTTP response have finished.
  async function readResult(
    req: FastifyRequest,
    reply: FastifyReply,
    job: Job,
    send: (t: Result, eligible: () => boolean) => Promise<void> | void
  ) {
    if (!job.result) return reply.code(404).send()
    if (job.reading || activeReads >= MAX_RESULTS)
      return reply.code(429).send({ error: 'Result busy' })
    job.reading = true
    activeReads++
    let working = true
    let finished = false
    const release = () => {
      if (working || !finished) return
      reply.raw.off('finish', onFinish)
      reply.raw.off('close', onFinish)
      job.reading = false
      activeReads--
    }
    const onFinish = () => {
      finished = true
      release()
    }
    reply.raw.once('finish', onFinish)
    reply.raw.once('close', onFinish)
    const user = principal(req)
    const eligible = () =>
      !job.abort.signal.aborted && !reply.raw.destroyed && !!user?.eligible()
    try {
      try {
        for (const [entry, kind] of job.entries) {
          if (!eligible() || (await authorize(entry, kind)) !== entry)
            throw new Error('Source no longer authorized')
        }
      } catch {
        return reply.code(403).send()
      }
      if (!eligible()) return reply.code(403).send()
      await send(job.result, eligible)
      return reply
    } finally {
      working = false
      release()
    }
  }
  app.post(TORRENT_CREATOR_API, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const user = principal(req)
    if (!user?.eligible()) return reply.code(401).send()
    const data = serverCreateTorrentSchema.safeParse(req.body)
    if (!data.success)
      return reply.code(400).send({ error: 'Invalid torrent options' })
    reap()
    if (running || !reserveResultSlot(user.id))
      return reply.code(429).send({ error: 'Torrent creator busy' })
    const { source, options } = data.data
    const job: Job = {
      id: randomUUID(),
      owner: user.id,
      source: source.path,
      touched: Date.now(),
      progress: 0,
      abort: new AbortController(),
      entries: new Map(),
    }
    jobs.set(job.id, job)
    const run = async () => {
      const canonical = await authorize(source.path, source.kind)
      const stat = await lstat(canonical)
      if (source.kind === 'file' ? !stat.isFile() : !stat.isDirectory())
        throw new Error('Source kind changed')
      const hooks: CreateTorrentHooks = {
        signal: job.abort.signal,
        picked: { path: canonical, dev: stat.dev, ino: stat.ino },
        authorizeEntry: async (entry, kind) => {
          if (!user.eligible() || (await authorize(entry, kind)) !== entry)
            throw new Error('Source no longer authorized')
          job.entries.set(entry, kind)
        },
        onProgress(done, total) {
          if (!user.eligible()) throw new Error('Session expired')
          job.progress = total ? done / total : 1
        },
      }
      job.result = await createTorrent(
        { ...options, sourcePath: canonical },
        hooks
      )
      // The torrent root name is the canonical basename, including when picked through an alias.
      job.source = canonical
    }
    running = run()
      .catch(() => {
        job.failed = true
        job.entries.clear()
      })
      .finally(() => {
        running = undefined
      })
    return reply.code(202).send({ id: job.id })
  })
  const endpoint = `${TORRENT_CREATOR_API}/:id`
  app.get<{ Params: { id: string } }>(endpoint, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const job = get(req, req.params.id)
    if (!job) return reply.code(404).send()
    if (job.failed) return { state: 'failed' }
    if (!job.result) return { state: 'hashing', progress: job.progress }
    return readResult(
      req,
      reply,
      job,
      ({ bytes: _bytes, directory: _directory, ...summary }) => {
        reply.send({ state: 'ready', result: { id: job.id, ...summary } })
      }
    )
  })
  app.delete<{ Params: { id: string } }>(endpoint, async (req, reply) => {
    const job = get(req, req.params.id)
    if (job) discard(job)
    return reply.code(204).send()
  })
  app.post<{ Params: { id: string } }>(
    `${endpoint}/export`,
    async (req, reply) => {
      const data = torrentExportSchema.safeParse(req.body)
      if (!data.success) return reply.code(400).send()
      const job = get(req, req.params.id)
      if (!job) return reply.code(404).send()
      return readResult(req, reply, job, async (t, eligible) => {
        let seeding = 'not-requested'
        if (data.data.seed) {
          job.seed ??= deps
            .createTask({
              type: 'bt',
              payload: {
                kind: 'torrent-base64',
                base64: Buffer.from(t.bytes).toString('base64'),
              },
              selectedFiles: Array.from({ length: t.fileCount }, (_, i) => i),
              saveDir: path.dirname(job.source),
              duplicatePolicy: 'use-existing',
            })
            .then((result) =>
              ['created', 'reused', 'rechecked'].includes(result.outcome)
            )
            .catch(() => false)
          seeding = (await job.seed) ? 'submitted' : 'failed'
        }
        if (!eligible()) {
          reply.code(403).send()
          return
        }
        reply
          .header('cache-control', 'no-store')
          .header(TORRENT_SEED_HEADER, seeding)
          .type('application/x-bittorrent')
          .send(Buffer.from(t.bytes))
      })
    }
  )
}
