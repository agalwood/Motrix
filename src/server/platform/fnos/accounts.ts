import { lstat } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { z } from 'zod'
import type { NasAccountAuthority } from '../nas/client-authorization'
import { type NasIdentity, nasIdentitySchema } from '../nas/identity'

const responseSchema = z
  .object({
    version: z.literal(1),
    ok: z.literal(true),
    identity: nasIdentitySchema
      .unwrap()
      .extend({
        platform: z.literal('fnos'),
        accountRevision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .readonly()
      .nullable(),
  })
  .strict()
const unavailable = () => new Error('fnOS account authority unavailable')

/** Only a root-owned endpoint inside a root-controlled directory can supply
 * account state. Network callers and NAS cookies are not account authorities. */
async function protectedSocket(socketPath: string) {
  const [parent, socket] = await Promise.all([
    lstat(path.dirname(socketPath), { bigint: true }),
    lstat(socketPath, { bigint: true }),
  ])
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0n ||
    (parent.mode & 0o022n) !== 0n ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== 0n ||
    (socket.mode & 0o007n) !== 0n
  )
    throw unavailable()
  return socket
}

export class FnosAccountAuthority implements NasAccountAuthority {
  readonly platform = 'fnos' as const
  constructor(private readonly socketPath: string) {
    if (!path.isAbsolute(socketPath) || socketPath.includes('\0'))
      throw unavailable()
  }

  async resolve(
    identity: NasIdentity,
    signal: AbortSignal
  ): Promise<NasIdentity | null> {
    if (identity.platform !== 'fnos' || !/^(0|[1-9]\d*)$/.test(identity.userId))
      return null
    const uid = Number(identity.userId)
    if (!Number.isSafeInteger(uid) || uid >= 0xffffffff) return null
    signal.throwIfAborted()
    const before = await protectedSocket(this.socketPath)
    signal.throwIfAborted()
    const response = await new Promise<unknown>((resolve, reject) => {
      const socket = connect(this.socketPath)
      const chunks: Buffer[] = []
      let length = 0
      let settled = false
      const fail = () => {
        if (!settled) {
          settled = true
          reject(unavailable())
        }
        socket.destroy()
      }
      const abort = () => fail()
      socket.on('error', fail)
      socket.on('close', () => {
        signal.removeEventListener('abort', abort)
        if (!settled) fail()
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        fail()
        return
      }
      socket.setTimeout(4000, fail)
      socket.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 8192) {
          fail()
          return
        }
        chunks.push(chunk)
      })
      socket.once('connect', () =>
        socket.end(`${JSON.stringify({ version: 1, uid })}\n`)
      )
      socket.once('end', () => {
        if (settled) return
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          settled = true
          resolve(value)
        } catch {
          fail()
        }
        socket.destroy()
      })
    })
    signal.throwIfAborted()
    const after = await protectedSocket(this.socketPath)
    if (before.dev !== after.dev || before.ino !== after.ino)
      throw unavailable()
    const result = responseSchema.parse(response).identity
    if (result && result.userId !== identity.userId) throw unavailable()
    return result
  }
}
