import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'

/** Match aria2's persisted native path keys without changing app path identity. */
export function legacyWirePath(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (
    !paths.isAbsolute(value) ||
    paths.normalize(value) !== value ||
    Buffer.byteLength(value) > 4096 ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  )
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Invalid legacy checkpoint path'
    )
  if (platform !== 'win32') return value
  // Local drive paths only. The engine verifies NTFS, exact on-disk casing,
  // reparse points, file identity and ACLs through held read-only handles.
  if (!/^[A-Z]:\\/.test(value))
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Invalid legacy checkpoint drive'
    )
  const parts = value.slice(3).split('\\')
  if (
    parts.some(
      (part) =>
        !part ||
        /[. ]$|[:<>"|?*]/.test(part) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(
          part
        )
    )
  )
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Invalid legacy checkpoint component'
    )
  return value.replaceAll('\\', '/')
}
