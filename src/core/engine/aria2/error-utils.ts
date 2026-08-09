/**
 * aria2 raises `GID <gid> is not found` when a gid has been evicted
 * (FIFO from `--max-download-result`, restart, or after a successful
 * `forceRemove`). Several call sites need to treat this as a no-op
 * rather than a hard failure.
 */
export function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\bGID\b[^\r\n]*\b(?:is\s+)?not\s+found\b/i.test(msg)
}
