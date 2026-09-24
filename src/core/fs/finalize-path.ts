import { Buffer } from 'node:buffer'
import path from 'node:path'

/** Resolve plugin-relative targets and apply the same boundary at commit time. */
export function resolveFinalizeTarget(
  saveDir: string,
  targetPath: string,
  paths: typeof path = path
): string {
  if (
    !paths.isAbsolute(saveDir) ||
    saveDir.includes('\0') ||
    targetPath.includes('\0')
  ) {
    throw new Error('finalize save directory must be an absolute path')
  }
  const target = paths.resolve(saveDir, targetPath)
  // Windows API paths and user-selected paths can name the same directory
  // using different namespace prefixes. Keep the original IO representation,
  // but compare both with the same Win32 path semantics.
  const comparable = (value: string): string =>
    paths.sep === '\\'
      ? value
          .replace(/^\\\\\?\\UNC\\/i, '\\\\')
          .replace(/^\\\\\?\\([a-z]:\\)/i, '$1')
      : value
  const relative = paths.relative(comparable(saveDir), comparable(target))
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    throw new Error('finalize target must be a descendant of saveDir')
  }
  return target
}

/**
 * Byte budget that stays under Unix NAME_MAX (255 bytes) and the Windows
 * per-component limit (255 UTF-16 units, always fewer than the UTF-8 bytes).
 * One byte short of the hard limit so the published name can still grow a
 * conflict suffix (` (1)`, `.N`) without breaking NAME_MAX; Firefox's
 * kDefaultMaxFileNameLength keeps the same 254-byte margin.
 */
const MAX_COMPONENT_BYTES = 254
/** Extensions longer than this are payload, not worth preserving. */
const MAX_EXTENSION_BYTES = 24
/** Result when every character of the input is stripped (for example `.`). */
const FALLBACK_NAME = 'download'
const REPLACEMENT = '_'

/**
 * Map a downloaded final-name candidate onto the one domain that is valid on
 * every filesystem Motrix publishes to, including Windows volumes the user
 * later copies the file to. Mirrors the sidecar's `sanitize_name` rule set
 * (Chromium filename_util tightened to a shared cross-platform domain; see
 * packages/finalize-fs/README.md). Idempotent, filesystem-free, and only ever
 * applied to the final path component — directories are validated, not
 * rewritten.
 */
export function sanitizeFinalizeFilename(component: string): string {
  const replaced = Array.from(component, (character) =>
    isForbiddenFilenameCharacter(character) ? REPLACEMENT : character
  ).join('')
  // Win32 silently drops trailing dots and spaces when reopening the file.
  const trimmed = replaced.replace(/[. ]+$/u, '')
  // Windows reserves whole device names including `CON.txt` forms.
  const dereserved = dereserveFilename(trimmed)
  const clamped = clampFilenameComponent(dereserved)
  return clamped === '' ? FALLBACK_NAME : clamped
}

/** Sanitize only the final component of an absolute target path. */
export function sanitizeFinalizePath(
  targetPath: string,
  paths: typeof path = path
): string {
  const name = paths.basename(targetPath)
  const sanitized = sanitizeFinalizeFilename(name)
  return sanitized === name
    ? targetPath
    : paths.join(paths.dirname(targetPath), sanitized)
}

function isForbiddenFilenameCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return (
    code <= 0x1f ||
    code === 0x7f ||
    // `:` covers the NTFS alternate-data-stream separator and the macOS
    // Finder `:`/`/` display split; `/` and `\` are replaced rather than
    // rejected so callers cannot smuggle in directory levels.
    '<>":|?*/\\:'.includes(character)
  )
}

function dereserveFilename(name: string): string {
  const stemEnd = name.indexOf('.')
  const stem = stemEnd === -1 ? name : name.slice(0, stemEnd)
  if (!isReservedFilenameStem(stem)) return name
  const rest = stemEnd === -1 ? '' : name.slice(stemEnd)
  return `${stem}_${rest}`
}

function isReservedFilenameStem(stem: string): boolean {
  const upper = stem.toUpperCase()
  if (['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'].includes(upper)) {
    return true
  }
  return /^(?:COM|LPT)(?:[1-9]|¹|²|³)$/.test(upper)
}

function clampFilenameComponent(name: string): string {
  if (Buffer.byteLength(name) <= MAX_COMPONENT_BYTES) return name
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const extension = name.slice(dot + 1)
    const extensionBytes = Buffer.byteLength(extension)
    if (extensionBytes > 0 && extensionBytes <= MAX_EXTENSION_BYTES) {
      const stemBudget = MAX_COMPONENT_BYTES - extensionBytes - 1
      const stem = truncateUtf8(name.slice(0, dot), stemBudget).replace(
        /[. ]+$/u,
        ''
      )
      return `${stem}.${extension}`
    }
  }
  return truncateUtf8(name, MAX_COMPONENT_BYTES).replace(/[. ]+$/u, '')
}

function truncateUtf8(value: string, maxBytes: number): string {
  let end = value.length
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) {
    end -= 1
  }
  return value.slice(0, end)
}
