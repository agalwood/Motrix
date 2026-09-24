// Windows' legacy MAX_PATH (260) does not bound downloads: since
// 1.37.0-motrix.16 aria2c passes any path of 248+ characters through the \\?\
// namespace (resolved with GetFullPathNameW, following Rust std and Go), so it
// needs neither the LongPathsEnabled policy nor a shorter destination
// (agalwood/Motrix#2183). What remains is the extended-length limit of 32,767
// UTF-16 units, which the prefix itself counts toward. Past it no API can open
// the path, and ERROR_FILENAME_EXCED_RANGE surfaces as a generic write error.
//
// Motrix already budgets the filename against NAME_MAX (255 bytes, see
// direct-resource-validator). That is a different, per-component limit; it
// says nothing about the assembled path.

/** Longest prefix aria2 adds for the extended-length namespace. */
const ENGINE_LONG_PATH_PREFIX = '\\\\?\\UNC\\'

/** Usable UTF-16 units in a Windows path opened by the engine. */
export const WINDOWS_MAX_PATH = 32_767 - ENGINE_LONG_PATH_PREFIX.length

/** Paths already escaped with this prefix bypass the MAX_PATH parser. */
const LONG_PATH_PREFIX = '\\\\?\\'

export interface PathLengthOverrun {
  /** Length in UTF-16 code units — the unit Windows itself counts. */
  length: number
  limit: number
}

/**
 * Report a destination that the platform cannot open, or null when it fits.
 * Only win32 carries a whole-path cap worth checking here; POSIX PATH_MAX
 * (4096) is out of reach for any name a download produces.
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
