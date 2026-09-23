// Windows caps a path at MAX_PATH (260 including the terminating NUL, so 259
// usable characters) unless BOTH the machine's LongPathsEnabled policy is on
// AND the process declares `longPathAware` in its manifest. aria2c.exe carries
// that manifest (aria2_motrix/src/aria2c.manifest), but the policy is off by
// default on most installs, so an over-long destination still fails — and it
// fails with ERROR_PATH_NOT_FOUND, whose text ("The system cannot find the
// path specified") reads as a missing directory rather than an over-long path.
//
// Motrix already budgets the filename against NAME_MAX (255 bytes, see
// direct-resource-validator). That is a different, per-component limit; it
// says nothing about the assembled path. See agalwood/Motrix#2183.

/** Usable characters in a Windows path without the `\\?\` escape. */
export const WINDOWS_MAX_PATH = 259

/** Paths already escaped with this prefix bypass the MAX_PATH parser. */
const LONG_PATH_PREFIX = '\\\\?\\'

export interface PathLengthOverrun {
  /** Length in UTF-16 code units — the unit Windows itself counts. */
  length: number
  limit: number
}

/**
 * Report a destination that the platform cannot open, or null when it fits.
 * Only win32 has a whole-path cap low enough to hit in practice; POSIX
 * PATH_MAX (4096) is out of reach for any name a download produces.
 */
export function exceedsPathLimit(
  filePath: string,
  platform: NodeJS.Platform | string
): PathLengthOverrun | null {
  if (platform !== 'win32') return null
  if (filePath.startsWith(LONG_PATH_PREFIX)) return null
  // `.length` is already UTF-16 code units, which is what the Win32 wide-char
  // APIs count — an astral character costs two, exactly as it does there.
  const length = filePath.length
  if (length <= WINDOWS_MAX_PATH) return null
  return { length, limit: WINDOWS_MAX_PATH }
}

const FILE_OPEN_MESSAGE = /^Failed to open the file (.+), cause: /u

/**
 * Recover the destination from aria2's EX_FILE_OPEN message
 * (`Failed to open the file %s, cause: %s`). The greedy capture is deliberate:
 * a filename may contain ", " itself, while the trailing ", cause: " separator
 * appears once, last.
 */
export function extractAria2FilePath(
  errorMessage: string | null | undefined
): string | null {
  if (!errorMessage) return null
  return FILE_OPEN_MESSAGE.exec(errorMessage)?.[1] ?? null
}

export interface PathOverrun extends PathLengthOverrun {
  path: string
}

/**
 * Worst over-long path among the destinations a task will write, or null when
 * they all fit. Reporting the worst (not the first) keeps the error message
 * pointed at the path the user actually has to shorten.
 */
export function findPathOverrun(
  candidates: readonly string[],
  platform: NodeJS.Platform | string
): PathOverrun | null {
  let worst: PathOverrun | null = null
  for (const candidate of candidates) {
    if (!candidate) continue
    const overrun = exceedsPathLimit(candidate, platform)
    if (overrun === null) continue
    if (worst === null || overrun.length > worst.length) {
      worst = { ...overrun, path: candidate }
    }
  }
  return worst
}
