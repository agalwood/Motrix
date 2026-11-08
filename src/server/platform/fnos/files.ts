import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { z } from 'zod'
import {
  type NasFileAccess,
  type NasFilePermission,
  NasFiles,
} from '../nas/files'
import type { NasIdentity } from '../nas/identity'

const responseSchema = z.object({ code: z.literal(0), data: z.unknown() })
const rootsSchema = z.object({
  paths: z.array(z.string().startsWith('/').max(4096)).max(1024),
})
const aclSchema = z.array(
  z.object({
    path: z.string(),
    readable: z.boolean(),
    writable: z.boolean(),
    deletable: z.boolean(),
  })
)

class FnosFileAccess implements NasFileAccess {
  readonly platform = 'fnos' as const
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly socketPath = '/var/run/trim_open_gateway_apiscope.socket'
  ) {}

  private async call(method: string, data: object): Promise<unknown> {
    const token = this.env.TRIM_API_TOKEN
    if (!token) throw new Error('fnOS API token unavailable')
    const body = JSON.stringify({
      reqId: randomUUID(),
      req: method,
      appName: 'motrix',
      data,
    })
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: '/api/v1/trimapp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          let length = 0
          res.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > 1024 * 1024)
              req.destroy(new Error('fnOS response too large'))
            else chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', () => {
            try {
              if (res.statusCode !== 200)
                throw new Error('fnOS API unavailable')
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      const timer = setTimeout(
        () => req.destroy(new Error('fnOS API timed out')),
        5_000
      )
      req.on('close', () => clearTimeout(timer))
      req.on('error', reject)
      req.end(body)
    })
    return responseSchema.parse(value).data
  }

  async authorizedRoots(): Promise<string[]> {
    const shared = rootsSchema.parse(
      await this.call('trim.file.getSharedAccessibleFolders', {})
    )
    return [
      ...(this.env.TRIM_DATA_SHARE_PATHS ?? '').split(':').filter(Boolean),
      ...shared.paths,
    ]
  }

  async checkAccess(
    user: NasIdentity,
    candidate: string,
    permission: NasFilePermission
  ): Promise<boolean> {
    if (user.platform !== this.platform) return false
    const uid = z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative().safe())
      .parse(user.userId)
    const entries = aclSchema.parse(
      await this.call('trim.file.checkUserACL', { uid, path: [candidate] })
    )
    return entries.some(
      (entry) => entry.path === candidate && entry[permission]
    )
  }
}

export class FnosFiles extends NasFiles {
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    socketPath = '/var/run/trim_open_gateway_apiscope.socket'
  ) {
    super(new FnosFileAccess(env, socketPath))
  }
}
