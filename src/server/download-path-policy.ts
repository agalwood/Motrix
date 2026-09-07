import { lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { DirectoryErrorCode } from '@shared/schemas/server-directory'

interface DownloadPathEnvironment {
  MOTRIX_DEFAULT_SAVE_DIR?: string
}

export interface ServerDownloadPathPolicyOptions {
  defaultSaveDir: string
  allowedSaveDirsValue?: string
  pathDelimiter?: string
}

export interface ServerDownloadPathPolicy {
  readonly allowedSaveDirs: readonly string[]
  prepareSaveDir(requested: string | undefined): Promise<string>
  authorizeDirectory(requested: string): Promise<AuthorizedServerDirectory>
}

export interface AuthorizedServerDirectory {
  path: string
  canonicalPath: string
  rootPath: string
  modifiedAt?: number
}

export class DirectoryAuthorizationError extends AppError {
  constructor(
    readonly directoryCode: DirectoryErrorCode,
    message: string
  ) {
    super(ErrorCode.TaskCreateFailed, message)
  }
}

interface AllowedRoot {
  configured: string
  canonical: string
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function absolutePath(value: string, label: string): string {
  if (!value || !path.isAbsolute(value) || value.includes('\0')) {
    throw new AppError(
      ErrorCode.SettingsInvalid,
      `${label} must be an absolute path`
    )
  }
  return path.resolve(value)
}

function parseAllowedSaveDirs(
  value: string | undefined,
  delimiter: string
): string[] {
  if (!value?.trim()) return []
  const seen = new Set<string>()
  const roots: string[] = []
  for (const raw of value.split(delimiter)) {
    if (!raw.trim()) continue
    const root = absolutePath(raw.trim(), 'MOTRIX_ALLOWED_SAVE_DIRS entry')
    if (!seen.has(root)) {
      seen.add(root)
      roots.push(root)
    }
  }
  return roots
}

function pathFailure(message: string, cause?: unknown): AppError {
  return new AppError(ErrorCode.TaskCreateFailed, message, cause)
}

async function ensureDirectory(candidate: string): Promise<void> {
  try {
    await mkdir(candidate, { recursive: true })
    const info = await stat(candidate)
    if (!info.isDirectory()) {
      throw pathFailure(`Save directory is not a directory: ${candidate}`)
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw pathFailure(`Save directory cannot be created: ${candidate}`, cause)
  }
}

async function ensureWritable(candidate: string): Promise<void> {
  const probe = path.join(
    candidate,
    `.motrix-write-test-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(probe, 'wx', 0o600)
    await handle.close()
    handle = undefined
    await unlink(probe)
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    await unlink(probe).catch(() => undefined)
    throw pathFailure(`Save directory is not writable: ${candidate}`, cause)
  }
}

async function deepestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate
  for (;;) {
    try {
      await lstat(current)
      return current
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      const parent = path.dirname(current)
      if (parent === current) throw cause
      current = parent
    }
  }
}

class DownloadPathPolicy implements ServerDownloadPathPolicy {
  readonly allowedSaveDirs: readonly string[]

  constructor(
    private readonly defaultSaveDir: string,
    private readonly allowedRoots: readonly AllowedRoot[]
  ) {
    this.allowedSaveDirs = allowedRoots.map((root) => root.configured)
  }

  private resolveCandidate(requested: string): {
    candidate: string
    matchingRoots: AllowedRoot[]
  } {
    let candidate = absolutePath(requested, 'Save directory')
    let matchingRoots = this.allowedRoots.filter((root) =>
      pathIsInside(root.configured, candidate)
    )
    // Older settings persist canonical paths. Map only a canonical subtree of
    // a configured root back to its logical alias, then repeat both checks.
    if (this.allowedRoots.length > 0 && matchingRoots.length === 0) {
      const alias = this.allowedRoots
        .filter((root) => pathIsInside(root.canonical, candidate))
        .sort((a, b) => b.canonical.length - a.canonical.length)[0]
      if (alias) {
        candidate = path.join(
          alias.configured,
          path.relative(alias.canonical, candidate)
        )
        matchingRoots = this.allowedRoots.filter((root) =>
          pathIsInside(root.configured, candidate)
        )
      }
    }
    if (this.allowedRoots.length > 0 && matchingRoots.length === 0) {
      throw new DirectoryAuthorizationError(
        'outsideRoots',
        `Save directory is outside MOTRIX_ALLOWED_SAVE_DIRS: ${candidate}`
      )
    }
    return { candidate, matchingRoots }
  }

  private checkCanonical(
    candidate: string,
    canonical: string,
    roots: readonly AllowedRoot[]
  ): AllowedRoot | undefined {
    const matching = roots
      .filter((root) => pathIsInside(root.canonical, canonical))
      .sort((a, b) => b.configured.length - a.configured.length)
    if (roots.length > 0 && matching.length === 0) {
      throw new DirectoryAuthorizationError(
        'outsideRoots',
        `Save directory resolves outside the allowed root: ${candidate}`
      )
    }
    return matching[0]
  }

  async authorizeDirectory(
    requested: string
  ): Promise<AuthorizedServerDirectory> {
    const { candidate, matchingRoots } = this.resolveCandidate(requested)
    const canonical = await realpath(candidate)
    const root = this.checkCanonical(candidate, canonical, matchingRoots)
    const info = await stat(canonical)
    if (!info.isDirectory()) {
      throw new DirectoryAuthorizationError(
        'notDirectory',
        'Save directory is not a directory'
      )
    }
    return {
      path: candidate,
      canonicalPath: canonical,
      rootPath: root?.configured ?? path.parse(candidate).root,
      ...(Number.isFinite(info.mtimeMs) ? { modifiedAt: info.mtimeMs } : {}),
    }
  }

  async prepareSaveDir(requested: string | undefined): Promise<string> {
    const raw =
      requested === undefined || requested === ''
        ? this.defaultSaveDir
        : requested
    const { candidate, matchingRoots } = this.resolveCandidate(raw)

    if (matchingRoots.length > 0) {
      const ancestor = await deepestExistingAncestor(candidate)
      const canonicalAncestor = await realpath(ancestor)
      this.checkCanonical(candidate, canonicalAncestor, matchingRoots)
    }

    await ensureDirectory(candidate)
    const canonical = await realpath(candidate)
    this.checkCanonical(candidate, canonical, matchingRoots)
    await ensureWritable(canonical)
    return canonical
  }
}

export function resolveServerDefaultSaveDir(
  env: DownloadPathEnvironment,
  fallback: string
): string {
  return absolutePath(
    env.MOTRIX_DEFAULT_SAVE_DIR?.trim() || fallback,
    env.MOTRIX_DEFAULT_SAVE_DIR?.trim()
      ? 'MOTRIX_DEFAULT_SAVE_DIR'
      : 'Server default save directory'
  )
}

export async function createServerDownloadPathPolicy(
  options: ServerDownloadPathPolicyOptions
): Promise<ServerDownloadPathPolicy> {
  const defaultSaveDir = absolutePath(
    options.defaultSaveDir,
    'MOTRIX_DEFAULT_SAVE_DIR'
  )
  const configuredRoots = parseAllowedSaveDirs(
    options.allowedSaveDirsValue,
    options.pathDelimiter ?? path.delimiter
  )
  const allowedRoots: AllowedRoot[] = []
  for (const configured of configuredRoots) {
    await ensureDirectory(configured)
    const canonical = await realpath(configured)
    await ensureWritable(canonical)
    allowedRoots.push({ configured, canonical })
  }

  const policy = new DownloadPathPolicy(defaultSaveDir, allowedRoots)
  try {
    await policy.prepareSaveDir(defaultSaveDir)
  } catch (error) {
    if (
      error instanceof DirectoryAuthorizationError &&
      error.directoryCode === 'outsideRoots'
    ) {
      throw new AppError(
        ErrorCode.SettingsInvalid,
        'MOTRIX_DEFAULT_SAVE_DIR must be inside MOTRIX_ALLOWED_SAVE_DIRS',
        error
      )
    }
    throw error
  }
  return policy
}
