import fs from 'node:fs/promises'

/**
 * Returns true when the path is reachable via `fs.access` (the file or
 * directory exists and the current process has at least the default
 * `F_OK` permission). All errors are swallowed and coerced to `false`
 * — callers that need richer diagnostics should use `fs.stat` directly.
 */
export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}
