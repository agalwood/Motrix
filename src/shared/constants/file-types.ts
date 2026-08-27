import { extractExtension } from '@shared/lib/path-ext'

/** Video extensions recognized consistently by torrent filtering and core. */
export const VIDEO_FILE_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.ts',
  '.rmvb',
] as const

const VIDEO_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(
  VIDEO_FILE_EXTENSIONS
)

export function isVideoFilePath(filePath: string): boolean {
  return VIDEO_FILE_EXTENSION_SET.has(extractExtension(filePath))
}

/** Empty and mixed file lists are deliberately not treated as video-only. */
export function containsOnlyVideoFiles(filePaths: readonly string[]): boolean {
  return filePaths.length > 0 && filePaths.every(isVideoFilePath)
}
