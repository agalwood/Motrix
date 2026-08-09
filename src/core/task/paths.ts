import { INCOMPLETE_SUFFIX } from '@shared/constants/incomplete'

export function toTempPath(path: string): string {
  if (path.endsWith(INCOMPLETE_SUFFIX)) return path
  return `${path}${INCOMPLETE_SUFFIX}`
}

export function toFinalPath(path: string): string {
  if (!path.endsWith(INCOMPLETE_SUFFIX)) return path
  return path.slice(0, path.length - INCOMPLETE_SUFFIX.length)
}

export function isTempPath(path: string): boolean {
  return path.endsWith(INCOMPLETE_SUFFIX)
}
