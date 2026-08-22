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

/**
 * Official aria2 reports option validation failures as errorCode=28. Keep the
 * classifier narrow so unrelated option errors are never retried silently.
 */
export function isConnectionLimitRangeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const isExpectedRange = /must\s+be\s+between\s+1\s+and\s+16\b/i.test(message)
  const identifiesConnectionOption =
    /max-connection-per-server|(?:^|\W)split(?:\W|$)/i.test(message)
  const identifiesAria2OptionError = /errorCode\s*=\s*28\b/i.test(message)
  return (
    isExpectedRange &&
    (identifiesConnectionOption || identifiesAria2OptionError)
  )
}
