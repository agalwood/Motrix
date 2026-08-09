// Sandbox helper for FS capabilities — every plugin-supplied path must go through
// `resolveInsideSandbox` before any read/write operation is performed.
// ENOENT fallback semantics: when the target does not exist yet (write to a new file),
// we realpath the parent directory and re-join the basename. This still catches
// symlink-escape because the parent's realpath is canonical.
// Used by: fs.storage (Task 7), fs.task (Task 8), and the cookie-jar persistence path.
import { realpath } from 'node:fs/promises'
import path from 'node:path'

export class FsSandboxError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FsSandboxError'
  }
}

const PATH_MAX = 4096

export async function resolveInsideSandbox(
  root: string,
  userPath: string
): Promise<string> {
  if (userPath.length > PATH_MAX) {
    throw new FsSandboxError(
      'plugin.fs.path_too_long',
      `plugin.fs.path_too_long: path exceeds ${PATH_MAX} characters`
    )
  }
  const normalized = userPath.normalize('NFC')
  const absolute = path.resolve(root, normalized)
  let real: string
  try {
    real = await realpath(absolute)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      real = path.normalize(
        path.join(
          await realpath(path.dirname(absolute)),
          path.basename(absolute)
        )
      )
    } else {
      throw e
    }
  }
  const realRoot = await realpath(root)
  const rootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  const cmp =
    process.platform === 'darwin' || process.platform === 'win32'
      ? (s: string) => s.toLowerCase()
      : (s: string) => s
  if (cmp(real) !== cmp(realRoot) && !cmp(real).startsWith(cmp(rootSep))) {
    throw new FsSandboxError(
      'plugin.fs.path_outside_sandbox',
      'plugin.fs.path_outside_sandbox: resolved path outside sandbox root'
    )
  }
  return real
}

export async function resolveDeepInsideSandbox(
  root: string,
  userPath: string
): Promise<string> {
  if (userPath.length > PATH_MAX) {
    throw new FsSandboxError(
      'plugin.fs.path_too_long',
      `plugin.fs.path_too_long: path exceeds ${PATH_MAX} characters`
    )
  }
  const normalized = userPath.normalize('NFC')
  const absolute = path.resolve(root, normalized)
  // Walk up until we find an existing ancestor
  let existing = absolute
  const tail: string[] = []
  while (true) {
    try {
      const real = await realpath(existing)
      // Found an existing ancestor — rejoin non-existing tail
      const resolved = tail.reduceRight((acc, seg) => path.join(acc, seg), real)
      // Sandbox check
      const realRoot = await realpath(root)
      const rootSep = realRoot.endsWith(path.sep)
        ? realRoot
        : realRoot + path.sep
      const cmp =
        process.platform === 'darwin' || process.platform === 'win32'
          ? (s: string) => s.toLowerCase()
          : (s: string) => s
      if (
        cmp(resolved) !== cmp(realRoot) &&
        !cmp(resolved).startsWith(cmp(rootSep))
      ) {
        throw new FsSandboxError(
          'plugin.fs.path_outside_sandbox',
          'plugin.fs.path_outside_sandbox: resolved path outside sandbox root'
        )
      }
      return resolved
    } catch (e: unknown) {
      if (e instanceof FsSandboxError) throw e
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') throw e
      const parent = path.dirname(existing)
      if (parent === existing) {
        // Reached filesystem root — use basic normalization
        break
      }
      tail.push(path.basename(existing))
      existing = parent
    }
  }
  // Fallback: pure path normalization (no realpath possible)
  const normalizedAbs = path.normalize(absolute)
  const realRoot = await realpath(root)
  const rootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  const cmp =
    process.platform === 'darwin' || process.platform === 'win32'
      ? (s: string) => s.toLowerCase()
      : (s: string) => s
  if (
    cmp(normalizedAbs) !== cmp(realRoot) &&
    !cmp(normalizedAbs).startsWith(cmp(rootSep))
  ) {
    throw new FsSandboxError(
      'plugin.fs.path_outside_sandbox',
      'plugin.fs.path_outside_sandbox: resolved path outside sandbox root'
    )
  }
  return normalizedAbs
}

export function assertBasename(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.startsWith('.')
  ) {
    throw new FsSandboxError(
      'plugin.fs.invalid_basename',
      `not a valid basename: ${name}`
    )
  }
}
