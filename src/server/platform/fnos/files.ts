import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { z } from 'zod'
import {
  createServerDownloadPathPolicy,
  DirectoryAuthorizationError,
  type ServerDownloadPathPolicy,
} from '../../download-path-policy'

export const fnosUser = new AsyncLocalStorage<number>()
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

export class FnosFiles {
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

  async roots(): Promise<string[]> {
    const shared = rootsSchema.parse(
      await this.call('trim.file.getSharedAccessibleFolders', {})
    )
    const roots = [
      ...new Set([
        ...(this.env.TRIM_DATA_SHARE_PATHS ?? '').split(':').filter(Boolean),
        ...shared.paths,
      ]),
    ]
    if (roots.length === 0)
      throw new DirectoryAuthorizationError(
        'outsideRoots',
        'No fnOS directories are authorized'
      )
    return roots
  }

  async check(
    candidate: string,
    permission: 'readable' | 'writable' | 'deletable',
    uid = fnosUser.getStore()
  ): Promise<void> {
    if (uid === undefined) return // Instance-owned background work uses the package ACL.
    const entries = aclSchema.parse(
      await this.call('trim.file.checkUserACL', { uid, path: [candidate] })
    )
    if (
      !entries.some((entry) => entry.path === candidate && entry[permission])
    ) {
      throw new DirectoryAuthorizationError(
        'permissionDenied',
        'fnOS file permission denied'
      )
    }
  }

  async policy(defaultSaveDir: string): Promise<ServerDownloadPathPolicy> {
    let roots = await this.roots()
    const snapshot = async () => {
      roots = await this.roots()
      return createServerDownloadPathPolicy({
        defaultSaveDir,
        allowedSaveDirs: roots,
        initialize: false,
      })
    }
    return {
      get allowedSaveDirs() {
        return roots
      },
      authorizeDirectory: async (candidate) => {
        const directory = await (await snapshot()).authorizeDirectory(candidate)
        await this.check(directory.canonicalPath, 'readable')
        return directory
      },
      prepareSaveDir: async (requested) => {
        const candidate = requested || defaultSaveDir
        const policy = await snapshot()
        // Check the existing ancestor before creating anything. A nonexistent
        // path returns all-false from the platform ACL API.
        let ancestor = path.resolve(candidate)
        for (;;) {
          try {
            await lstat(ancestor)
            break
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
              path.dirname(ancestor) === ancestor
            )
              throw error
            ancestor = path.dirname(ancestor)
          }
        }
        const directory = await policy.authorizeDirectory(ancestor)
        await this.check(directory.canonicalPath, 'writable')
        const result = await policy.prepareSaveDir(candidate)
        await this.check(result, 'writable')
        return result
      },
    }
  }

  async authorizeFile(
    candidate: string,
    policy: ServerDownloadPathPolicy,
    uid = fnosUser.getStore()
  ): Promise<string> {
    if (!path.isAbsolute(candidate) || candidate.includes('\0'))
      throw new Error('Invalid file path')
    const canonical = await realpath(candidate)
    await policy.authorizeDirectory(path.dirname(candidate))
    await policy.authorizeDirectory(path.dirname(canonical))
    await this.check(canonical, 'readable', uid)
    return canonical
  }

  async authorizeRemoval(
    candidate: string,
    policy: ServerDownloadPathPolicy
  ): Promise<void> {
    const info = await lstat(candidate).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    )
    if (!info) return
    if (info.isSymbolicLink()) throw new Error('Refusing to remove a symlink')
    const canonical = await realpath(candidate)
    await policy.authorizeDirectory(path.dirname(candidate))
    await policy.authorizeDirectory(path.dirname(canonical))
    await this.check(canonical, 'deletable')
  }
}
