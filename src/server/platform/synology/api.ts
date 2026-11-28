import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { DsmCommandError } from './commands'
import {
  type DsmContext,
  dsmContextSchema,
  dsmText,
  dsmUsername,
} from './validation'

type DsmRequest =
  | { kind: 'bootstrap' }
  | { kind: 'session' }
  | { kind: 'account'; username: string }
  | { kind: 'file'; path: string }
export type DsmApi = (
  context: DsmContext,
  request: DsmRequest,
  token?: string,
  signal?: AbortSignal
) => Promise<unknown>

const socketPath = '/run/synoscgi.sock'
export async function probeDsmApi() {
  try {
    const [socket, parent] = await Promise.all([
      lstat(socketPath),
      lstat('/run'),
    ])
    if (
      !socket.isSocket() ||
      ![0, 1023].includes(socket.uid) ||
      (socket.mode & 0o007) !== 0 ||
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0
    )
      throw new Error('Untrusted DSM endpoint')
    return { webApiSocketProbe: 'passed' as const }
  } catch {
    return { webApiSocketProbe: 'failed' as const }
  }
}

/** Only fixed, read-only vendor routes. Credentials stay in memory on the NAS.
 * No HTTP redirect, remote host, executable, arbitrary API or environment input. */
export function dsmScgiRequest(
  context: DsmContext,
  request: DsmRequest,
  token?: string
): Buffer {
  const c = dsmContextSchema.parse(context)
  const bootstrap = request.kind === 'bootstrap'
  const script = bootstrap ? '/webman/login.cgi' : '/webapi/entry.cgi'
  let params: Record<string, string>
  switch (request.kind) {
    case 'bootstrap':
      params = {}
      break
    case 'session':
      params = { api: 'SYNO.Core.NormalUser', version: '1', method: 'get' }
      break
    case 'account':
      params = {
        api: 'SYNO.Core.User',
        version: '1',
        method: 'get',
        name: dsmUsername.parse(request.username),
        type: 'local',
        additional: '["expired"]',
      }
      break
    case 'file': {
      const file = dsmText(4096)
        .regex(/^\/[^/]+(?:\/.*)?$/)
        .parse(request.path)
      if (
        file
          .split('/')
          .slice(1)
          .some((p) => !p || p === '.' || p === '..')
      )
        throw new Error('Invalid DSM path')
      params = {
        api: 'SYNO.FileStation.List',
        version: '2',
        method: 'getinfo',
        path: JSON.stringify([file]),
        additional: '["real_path","perm"]',
      }
      break
    }
    default:
      throw new Error('Unsupported DSM operation')
  }
  const csrf = bootstrap ? undefined : dsmText(4096).min(1).parse(token)
  const body = Buffer.from(new URLSearchParams(params).toString())
  const env = {
    CONTENT_LENGTH: String(body.length),
    SCGI: '1',
    REQUEST_METHOD: bootstrap ? 'GET' : 'POST',
    SCRIPT_FILENAME: `/usr/syno/synoman${script}`,
    SCRIPT_NAME: script,
    REQUEST_URI: script,
    DOCUMENT_URI: script,
    DOCUMENT_ROOT: '/usr/syno/synoman',
    QUERY_STRING: '',
    CONTENT_TYPE: 'application/x-www-form-urlencoded',
    SERVER_PROTOCOL: 'HTTP/1.1',
    GATEWAY_INTERFACE: 'CGI/1.1',
    REQUEST_SCHEME: c.scheme,
    HTTPS: c.scheme === 'https' ? 'on' : '',
    REMOTE_ADDR: c.remoteAddress,
    REMOTE_PORT: '0',
    SERVER_ADDR: c.serverAddress,
    SERVER_PORT: String(c.serverPort),
    HTTP_HOST: c.host ?? c.serverAddress,
    HTTP_COOKIE: c.cookie,
    HTTP_USER_AGENT: c.userAgent ?? '',
    ...(csrf === undefined ? {} : { HTTP_X_SYNO_TOKEN: csrf }),
  }
  const header = Buffer.from(`${Object.entries(env).flat().join('\0')}\0`)
  return Buffer.concat([
    Buffer.from(`${header.length}:`),
    header,
    Buffer.from(','),
    body,
  ])
}

export function parseDsmScgiResponse(bytes: Buffer): unknown {
  const offset = bytes.indexOf('\r\n\r\n')
  if (offset < 0 || offset > 16384) throw new DsmCommandError({})
  const headers = bytes.subarray(0, offset).toString('utf8')
  const statuses = [
    ...headers.matchAll(/^Status:\s*(\d{3})(?:\s[^\r\n]*)?\r?$/gim),
  ]
  if (
    statuses.length > 1 ||
    (statuses.length === 1 && statuses[0][1] !== '200') ||
    /^Transfer-Encoding:/im.test(headers)
  )
    throw new DsmCommandError({})
  const body = bytes.subarray(offset + 4)
  const lengths = [...headers.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
  if (
    lengths.length > 1 ||
    (lengths.length === 1 && Number(lengths[0][1]) !== body.length)
  )
    throw new DsmCommandError({})
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new DsmCommandError({})
  }
}

export const dsmApi: DsmApi = async (context, request, token, signal) => {
  if (signal?.aborted || (await probeDsmApi()).webApiSocketProbe !== 'passed')
    throw new DsmCommandError({})
  let payload: Buffer
  try {
    payload = dsmScgiRequest(context, request, token)
  } catch {
    throw new DsmCommandError({})
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    let size = 0,
      settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(new DsmCommandError(error))
      else {
        try {
          resolve(parseDsmScgiResponse(Buffer.concat(chunks)))
        } catch {
          reject(new DsmCommandError({}))
        }
      }
    }
    const abort = () => finish({ killed: true })
    const timer = setTimeout(abort, 2500)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    socket.on('connect', () => socket.write(payload))
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 128 * 1024)
        finish({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      else chunks.push(chunk)
    })
    socket.on('error', finish)
    socket.on('end', () => finish())
    socket.on('close', () => {
      if (!settled) finish({})
    })
  })
}

export const dsmBootstrapSchema = z.object({
  success: z.literal(true),
  SynoToken: dsmText(4096).min(1),
})
export const dsmSessionSchema = z.object({
  success: z.literal(true),
  data: z.object({ username: dsmUsername }),
})
export const dsmAccountSchema = z.object({
  success: z.literal(true),
  data: z.object({
    users: z
      .array(
        z.object({
          name: dsmUsername,
          uid: z.number().int().positive().max(0xfffffffe),
          expired: z.literal('normal'),
        })
      )
      .length(1),
  }),
})
export const dsmFileSchema = z.object({
  success: z.literal(true),
  data: z.object({
    files: z
      .array(
        z.object({
          path: z.string(),
          isdir: z.boolean(),
          additional: z.object({
            real_path: z.string(),
            perm: z.object({
              acl: z.object({
                read: z.boolean(),
                write: z.boolean(),
                append: z.boolean(),
                exec: z.boolean(),
                del: z.boolean(),
              }),
            }),
          }),
        })
      )
      .length(1),
  }),
})
