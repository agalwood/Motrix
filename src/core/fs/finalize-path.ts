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
