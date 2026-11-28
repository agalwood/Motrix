import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { MAX_TORRENT_FILE_SIZE } from '@shared/lib/torrent-meta'
import {
  NAS_FILE_API,
  nasTaskActionSchema,
  nasTorrentPathSchema,
} from '@shared/schemas/nas-files'
import type { DownloadTask } from '@shared/types/task'
import {
  canOpenTaskFile,
  canRevealTaskFolder,
} from '@shared/types/task-actions'
import type { FastifyInstance } from 'fastify'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import type { NasFiles } from './files'
import { currentNasUser, type NasIdentity } from './identity'
import { openNasFile } from './open-file'

export function nasFileRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(size) || size < 0) return null
  if (header === undefined) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || size === 0 || (!match[1] && !match[2])) return null
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if (
    [first, last].some(
      (value) =>
        value !== undefined && (!Number.isSafeInteger(value) || value < 0)
    )
  )
    return null
  if (first === undefined)
    return last && last > 0
      ? { start: Math.max(0, size - last), end: size - 1 }
      : null
  if (first >= size || (last !== undefined && last < first)) return null
  return { start: first, end: Math.min(last ?? size - 1, size - 1) }
}

export async function readNasTorrent(
  candidate: string,
  files: NasFiles,
  policy: ServerDownloadPathPolicy,
  user: NasIdentity
): Promise<Buffer> {
  if (!candidate.toLowerCase().endsWith('.torrent'))
    throw new Error('Not a torrent')
  const canonical = await files.authorizeFile(candidate, policy, user)
  const handle = await openNasFile(canonical, (opened) =>
    files.authorizeFile(opened, policy, user)
  )
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size > BigInt(MAX_TORRENT_FILE_SIZE))
      throw new Error('Torrent too large')
    const data = Buffer.alloc(Number(info.size) + 1)
    let size = 0
    while (size < data.length) {
      const read = await handle.read(data, size, data.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      BigInt(size) !== info.size ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      throw new Error('Torrent changed during read')
    await files.authorizeFile(canonical, policy, user)
    const named = await lstat(canonical, { bigint: true })
    if (
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.size !== info.size ||
      named.mtimeNs !== info.mtimeNs ||
      named.ctimeNs !== info.ctimeNs
    )
      throw new Error('Torrent identity changed')
    return data.subarray(0, size)
  } finally {
    await handle.close()
  }
}

export function registerNasFileRoutes(
  app: FastifyInstance,
  options: {
    files: NasFiles
    policy: ServerDownloadPathPolicy
    getTask: (id: string) => DownloadTask | undefined
    webBasePath: string
    fileManagerUrl: (canonical: string) => string
    outputIdentity?: (
      task: DownloadTask,
      path: string
    ) => Promise<string | undefined>
  }
) {
  const { files, policy, getTask } = options
  const streams = new Set<Readable>()
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.destroy()
  })
  const output = (id: string, action: 'open' | 'reveal') => {
    const task = getTask(id)
    if (
      !task ||
      !(action === 'open' ? canOpenTaskFile(task) : canRevealTaskFolder(task))
    )
      throw new Error('Task output unavailable')
    const stored = task.finalPath || task.diskPath
    if (!stored) throw new Error('Task output unavailable')
    return {
      task,
      stored,
      candidate: action === 'reveal' ? path.dirname(stored) : stored,
    }
  }
  const openTaskFile = async (
    task: DownloadTask,
    stored: string,
    canonical: string,
    user: NasIdentity
  ) => {
    const expected = await options.outputIdentity?.(task, stored)
    const handle = await openNasFile(canonical, (opened) =>
      files.authorizeFile(opened, policy, user)
    )
    try {
      const named = await handle.stat({ bigint: true })
      if (expected && expected !== `${named.dev}:${named.ino}`)
        throw Error('Task output changed')
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }
  app.post(`${NAS_FILE_API}/task-action`, async (req, reply) => {
    const parsed = nasTaskActionSchema.safeParse(req.body),
      user = currentNasUser()
    if (!parsed.success || !user)
      return reply.code(400).send({ error: 'Invalid task action' })
    try {
      const { taskId, action } = parsed.data
      const { task, stored, candidate } = output(taskId, action)
      const canonical =
        action === 'reveal'
          ? (await policy.authorizeDirectory(candidate)).canonicalPath
          : await files.authorizeFile(candidate, policy, user)
      await files.check(canonical, 'readable', user)
      if (output(taskId, action).stored !== stored)
        throw new Error('Task changed')
      if (action === 'reveal') {
        await options.outputIdentity?.(task, stored)
        return { kind: 'file-manager', url: options.fileManagerUrl(canonical) }
      }
      const handle = await openTaskFile(task, stored, canonical, user)
      await handle.close()
      return {
        kind: 'download',
        url: `${options.webBasePath}${NAS_FILE_API}/tasks/${encodeURIComponent(taskId)}/file`,
      }
    } catch {
      return reply.code(403).send({ error: 'Task output is not authorized' })
    }
  })
  app.post(`${NAS_FILE_API}/torrent`, async (req, reply) => {
    const parsed = nasTorrentPathSchema.safeParse(req.body),
      user = currentNasUser()
    if (!parsed.success || !user)
      return reply.code(400).send({ error: 'Invalid torrent path' })
    try {
      const data = await readNasTorrent(parsed.data.path, files, policy, user)
      return reply
        .type('application/x-bittorrent')
        .header('cache-control', 'no-store')
        .send(data)
    } catch {
      return reply.code(403).send({ error: 'Torrent is not authorized' })
    }
  })
  app.route<{ Params: { taskId: string } }>({
    method: ['GET', 'HEAD'],
    exposeHeadRoute: false,
    url: `${NAS_FILE_API}/tasks/:taskId/file`,
    handler: async (req, reply) => {
      const user = currentNasUser()
      const site = req.headers['sec-fetch-site']
      if (
        !user ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')
      )
        return reply.code(403).send({ error: 'File is not authorized' })
      let handle: Awaited<ReturnType<typeof openNasFile>> | undefined
      try {
        const { task, stored, candidate } = output(req.params.taskId, 'open')
        const canonical = await files.authorizeFile(candidate, policy, user)
        handle = await openTaskFile(task, stored, canonical, user)
        const file = handle,
          original = await file.stat({ bigint: true })
        const range = nasFileRange(req.headers.range, Number(original.size))
        if (!range) {
          await file.close()
          return reply
            .code(416)
            .header('content-range', `bytes */${original.size}`)
            .send()
        }
        const recheck = async () => {
          if (
            output(req.params.taskId, 'open').stored !== stored ||
            (await files.authorizeFile(canonical, policy, user)) !== canonical
          )
            throw new Error('File authorization changed')
          const expected = await options.outputIdentity?.(task, stored)
          if (expected && expected !== `${original.dev}:${original.ino}`)
            throw Error('Task output changed')
          const current = await lstat(canonical, { bigint: true })
          if (
            current.dev !== original.dev ||
            current.ino !== original.ino ||
            current.size !== original.size ||
            current.mtimeNs !== original.mtimeNs ||
            current.ctimeNs !== original.ctimeNs
          )
            throw new Error('File identity changed')
        }
        await recheck()
        const stream = Readable.from(
          (async function* () {
            let position = range.start,
              lastCheck = performance.now(),
              sinceCheck = 0
            try {
              while (position <= range.end) {
                if (
                  performance.now() - lastCheck >= 1000 ||
                  sinceCheck >= 32 * 1024 * 1024
                ) {
                  await recheck()
                  lastCheck = performance.now()
                  sinceCheck = 0
                }
                const chunk = Buffer.alloc(
                  Math.min(64 * 1024, range.end - position + 1)
                )
                const { bytesRead } = await file.read(
                  chunk,
                  0,
                  chunk.length,
                  position
                )
                if (!bytesRead) throw new Error('File truncated')
                position += bytesRead
                sinceCheck += bytesRead
                if (position > range.end) await recheck()
                yield chunk.subarray(0, bytesRead)
              }
            } finally {
              await file.close().catch(() => {})
            }
          })(),
          { objectMode: false }
        )
        stream.once('close', () => {
          streams.delete(stream)
          void file.close().catch(() => {})
        })
        streams.add(stream)
        reply.raw.once('close', () => stream.destroy())
        const filename = encodeURIComponent(path.basename(canonical)).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        )
        reply
          .header(
            'content-disposition',
            `attachment; filename="download"; filename*=UTF-8''${filename}`
          )
          .header(
            'content-length',
            String(Math.max(0, range.end - range.start + 1))
          )
          .header('accept-ranges', 'bytes')
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'no-referrer')
          .header('content-security-policy', "sandbox; default-src 'none'")
          .type('application/octet-stream')
        if (req.headers.range !== undefined)
          reply
            .code(206)
            .header(
              'content-range',
              `bytes ${range.start}-${range.end}/${original.size}`
            )
        if (req.method === 'HEAD') {
          stream.destroy()
          await file.close()
          return reply.send()
        }
        return reply.send(stream)
      } catch {
        await handle?.close().catch(() => {})
        return reply.code(403).send({ error: 'File is not authorized' })
      }
    },
  })
}
