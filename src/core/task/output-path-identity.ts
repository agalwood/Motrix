import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Reserve conservatively on hosts that commonly use case-insensitive volumes. */
export function outputNameIdentity(value: string): string {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? value.normalize('NFD').toLowerCase()
    : value
}

/** Resolve existing ancestors as well as aliases to not-yet-created outputs. */
export function outputPathIdentity(value: string): string {
  let ancestor = path.resolve(value)
  const suffix: string[] = []
  while (true) {
    try {
      return outputNameIdentity(path.join(realpathSync(ancestor), ...suffix))
    } catch {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return outputNameIdentity(path.resolve(value))
      suffix.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}
