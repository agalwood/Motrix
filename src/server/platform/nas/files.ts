import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  createServerDownloadPathPolicy,
  DirectoryAuthorizationError,
  type ServerDownloadPathPolicy,
} from '../../download-path-policy'
import {
  currentNasUser,
  type NasIdentity,
  type NasPlatform,
  runAsNasUser,
} from './identity'

export type NasFilePermission = 'readable' | 'writable' | 'deletable'

/** The vendor adapter owns account/ACL lookup and application folder grants.
 * Canonicalization, containment, grant refresh and command guards are shared. */
export interface NasFileAccess {
  readonly platform: NasPlatform
  authorizedRoots(): Promise<string[]>
  checkAccess(
    user: NasIdentity,
    path: string,
    permission: NasFilePermission
  ): Promise<boolean>
}

export class NasFiles {
  constructor(private readonly access: NasFileAccess) {}

  async roots(): Promise<string[]> {
    const roots = [...new Set(await this.access.authorizedRoots())]
    if (roots.length === 0)
      throw new DirectoryAuthorizationError(
        'outsideRoots',
        'No NAS directories are authorized'
      )
    return roots
  }

  async check(
    candidate: string,
    permission: NasFilePermission,
    user = currentNasUser()
  ): Promise<void> {
    // Instance-owned background work still uses the package ACL. All external
    // admission must establish a trusted user before invoking these methods.
    if (user === undefined) return
    if (
      user.platform !== this.access.platform ||
      !(await this.access.checkAccess(user, candidate, permission))
    )
      throw new DirectoryAuthorizationError(
        'permissionDenied',
        'NAS file permission denied'
      )
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
        // Check an existing ancestor before creating directories. Missing
        // mounts are rejected by the root policy, never recreated here.
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
    user = currentNasUser()
  ): Promise<string> {
    const authorize = async () => {
      if (!path.isAbsolute(candidate) || candidate.includes('\0'))
        throw new Error('Invalid file path')
      const canonical = await realpath(candidate)
      await policy.authorizeDirectory(path.dirname(candidate))
      await policy.authorizeDirectory(path.dirname(canonical))
      await this.check(canonical, 'readable')
      return canonical
    }
    // An explicit caller also owns the parent-directory checks. Never mix
    // a delegated file identity with the ambient request's permissions.
    return user ? runAsNasUser(user, authorize) : authorize()
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
