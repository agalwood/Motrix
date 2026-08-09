import { randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'

export function newTaskId(): string {
  return uuidv7()
}

/**
 * Mint a caller-reserved aria2 gid: exactly 16 hex characters (lowercase
 * when self-minted). Prefers the injected override (deterministic tests /
 * shells) and validates whatever it returns — a malformed reserved gid
 * would silently break the reservation-shield protocol in TaskManager.
 * `callerName` keeps each dispatch site's original error message.
 */
export function newEngineTaskId(
  override: (() => string) | undefined,
  callerName: string
): string {
  const gid = override?.() ?? randomBytes(8).toString('hex')
  if (!/^[0-9a-fA-F]{16}$/.test(gid)) {
    throw new TypeError(
      `${callerName} reserved gid must contain exactly 16 hexadecimal characters`
    )
  }
  return gid
}
