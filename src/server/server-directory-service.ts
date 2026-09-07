import { constants } from 'node:fs'
import { access, mkdir, opendir } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/errors'
import {
  CreateServerDirectoryRequestSchema,
  type CreateServerDirectoryResult,
  CreateServerDirectoryResultSchema,
  type DirectoryErrorCode,
  ListServerDirectoriesRequestSchema,
  type ListServerDirectoriesResult,
  ListServerDirectoriesResultSchema,
  SERVER_DIRECTORY_ENTRY_LIMIT,
  SERVER_DIRECTORY_PATH_LIMIT,
  SERVER_DIRECTORY_SCAN_LIMIT,
  ValidateServerDirectoryRequestSchema,
  type ValidateServerDirectoryResult,
  ValidateServerDirectoryResultSchema,
} from '@shared/schemas/server-directory'
import {
  type AuthorizedServerDirectory,
  DirectoryAuthorizationError,
  type ServerDownloadPathPolicy,
} from './download-path-policy'

const filesystem = { access, mkdir, opendir }

function errorCode(error: unknown): DirectoryErrorCode {
  if (error instanceof DirectoryAuthorizationError) return error.directoryCode
  if (error instanceof AppError) return 'invalidPath'
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case 'ENOENT':
      return 'notFound'
    case 'ENOTDIR':
      return 'notDirectory'
    case 'EPERM':
    case 'EROFS':
    case 'EACCES':
      return 'permissionDenied'
    case 'EEXIST':
      return 'alreadyExists'
    case 'ENAMETOOLONG':
      return 'tooLarge'
    case 'EINVAL':
      return 'invalidPath'
    default:
      return 'unavailable'
  }
}

function failure(code: DirectoryErrorCode) {
  return { ok: false as const, error: { code } }
}

function validName(name: string): boolean {
  if (
    name === '.' ||
    name === '..' ||
    /[/\\]/u.test(name) ||
    Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return false
  if (process.platform !== 'win32') return true
  return !(
    /[<>:"|?*]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)
  )
}

function navigation(directory: AuthorizedServerDirectory) {
  const breadcrumbs = [
    {
      name: path.basename(directory.rootPath) || directory.rootPath,
      path: directory.rootPath,
    },
  ]
  const suffix = path.relative(directory.rootPath, directory.path)
  let current = directory.rootPath
  for (const name of suffix ? suffix.split(path.sep) : []) {
    current = path.join(current, name)
    breadcrumbs.push({ name, path: current })
  }
  return {
    breadcrumbs,
    parentPath: suffix === '' ? null : path.dirname(directory.path),
  }
}

/** Read operations never prepare directories or create write probes. */
export class ServerDirectoryService {
  constructor(
    private readonly policy: ServerDownloadPathPolicy,
    private readonly fs: typeof filesystem = filesystem
  ) {}

  private async writable(
    directory: AuthorizedServerDirectory
  ): Promise<boolean> {
    try {
      await this.fs.access(
        directory.canonicalPath,
        constants.W_OK | constants.X_OK
      )
      return true
    } catch (error) {
      if (errorCode(error) === 'permissionDenied') return false
      throw error
    }
  }

  async list(raw: unknown): Promise<ListServerDirectoriesResult> {
    const request = ListServerDirectoriesRequestSchema.safeParse(raw)
    if (!request.success) return failure('invalidPath')
    try {
      const directory = await this.policy.authorizeDirectory(request.data.path)
      await this.fs.access(
        directory.canonicalPath,
        constants.R_OK | constants.X_OK
      )
      const entries: Array<{ name: string; path: string }> = []
      const handle = await this.fs.opendir(directory.canonicalPath)
      let scanned = 0
      let truncated = false
      try {
        while (
          scanned < SERVER_DIRECTORY_SCAN_LIMIT &&
          entries.length < SERVER_DIRECTORY_ENTRY_LIMIT
        ) {
          const entry = await handle.read()
          if (!entry) break
          scanned++
          if (!request.data.showHidden && entry.name.startsWith('.')) continue
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
          const childPath = path.join(directory.path, entry.name)
          if (childPath.length > SERVER_DIRECTORY_PATH_LIMIT) {
            truncated = true
            continue
          }
          try {
            const child = await this.policy.authorizeDirectory(childPath)
            entries.push({ name: entry.name, path: child.path })
          } catch (error) {
            // An unresolvable child link must not hide its healthy siblings.
            // Direct requests still fail through the outer error boundary.
            if ((error as NodeJS.ErrnoException | null)?.code === 'ELOOP')
              continue
            if (
              ![
                'outsideRoots',
                'notFound',
                'notDirectory',
                'permissionDenied',
              ].includes(errorCode(error))
            )
              throw error
          }
        }
        truncated ||=
          scanned === SERVER_DIRECTORY_SCAN_LIMIT ||
          entries.length === SERVER_DIRECTORY_ENTRY_LIMIT
      } finally {
        await handle.close()
      }
      entries.sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'en', {
            numeric: true,
            sensitivity: 'base',
          }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      )
      return ListServerDirectoriesResultSchema.parse({
        ok: true,
        value: {
          path: directory.path,
          ...navigation(directory),
          entries,
          truncated,
          canCreate: await this.writable(directory),
        },
      })
    } catch (error) {
      return failure(errorCode(error))
    }
  }

  async validate(raw: unknown): Promise<ValidateServerDirectoryResult> {
    const request = ValidateServerDirectoryRequestSchema.safeParse(raw)
    if (!request.success) return failure('invalidPath')
    try {
      const directory = await this.policy.authorizeDirectory(request.data.path)
      if (!(await this.writable(directory))) return failure('permissionDenied')
      return ValidateServerDirectoryResultSchema.parse({
        ok: true,
        value: { path: directory.path },
      })
    } catch (error) {
      return failure(errorCode(error))
    }
  }

  async create(raw: unknown): Promise<CreateServerDirectoryResult> {
    const request = CreateServerDirectoryRequestSchema.safeParse(raw)
    if (!request.success)
      return failure(
        request.error.issues.some((issue) => issue.path[0] === 'name')
          ? 'invalidName'
          : 'invalidPath'
      )
    if (!validName(request.data.name)) return failure('invalidName')
    let created = false
    try {
      const parent = await this.policy.authorizeDirectory(
        request.data.parentPath
      )
      const childPath = path.join(parent.path, request.data.name)
      if (childPath.length > SERVER_DIRECTORY_PATH_LIMIT)
        return failure('tooLarge')
      if (!(await this.writable(parent))) return failure('permissionDenied')
      await this.fs.mkdir(childPath, { recursive: false })
      created = true
      const child = await this.policy.authorizeDirectory(childPath)
      return CreateServerDirectoryResultSchema.parse({
        ok: true,
        value: { path: child.path, name: request.data.name },
      })
    } catch (error) {
      // A completed mkdir is persistent even if its post-check cannot certify
      // the result. Never remove a path that could have changed concurrently.
      return failure(created ? 'creationOutcomeUnknown' : errorCode(error))
    }
  }
}
