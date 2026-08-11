import { lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'

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
  const trimmed = value.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new AppError(
      ErrorCode.SettingsInvalid,
      `${label} must be an absolute path`
    )
  }
  return path.resolve(trimmed)
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
    const root = absolutePath(raw, 'MOTRIX_ALLOWED_SAVE_DIRS entry')
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

  async prepareSaveDir(requested: string | undefined): Promise<string> {
    const raw = requested?.trim() || this.defaultSaveDir
    const candidate = absolutePath(raw, 'Save directory')
    const matchingRoots = this.allowedRoots.filter((root) =>
      pathIsInside(root.configured, candidate)
    )
    if (this.allowedRoots.length > 0 && matchingRoots.length === 0) {
      throw pathFailure(
        `Save directory is outside MOTRIX_ALLOWED_SAVE_DIRS: ${candidate}`
      )
    }

    if (matchingRoots.length > 0) {
      const ancestor = await deepestExistingAncestor(candidate)
      const canonicalAncestor = await realpath(ancestor)
      if (
        !matchingRoots.some((root) =>
          pathIsInside(root.canonical, canonicalAncestor)
        )
      ) {
        throw pathFailure(
          `Save directory resolves outside the allowed root: ${candidate}`
        )
      }
    }

    await ensureDirectory(candidate)
    const canonical = await realpath(candidate)
    if (
      matchingRoots.length > 0 &&
      !matchingRoots.some((root) => pathIsInside(root.canonical, canonical))
    ) {
      throw pathFailure(
        `Save directory resolves outside the allowed root: ${candidate}`
      )
    }
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
  if (
    configuredRoots.length > 0 &&
    !configuredRoots.some((root) => pathIsInside(root, defaultSaveDir))
  ) {
    throw new AppError(
      ErrorCode.SettingsInvalid,
      'MOTRIX_DEFAULT_SAVE_DIR must be inside MOTRIX_ALLOWED_SAVE_DIRS'
    )
  }

  const allowedRoots: AllowedRoot[] = []
  for (const configured of configuredRoots) {
    await ensureDirectory(configured)
    const canonical = await realpath(configured)
    await ensureWritable(canonical)
    allowedRoots.push({ configured, canonical })
  }

  const policy = new DownloadPathPolicy(defaultSaveDir, allowedRoots)
  await policy.prepareSaveDir(defaultSaveDir)
  return policy
}
