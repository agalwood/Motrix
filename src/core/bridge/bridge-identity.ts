import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

export interface BridgeIdentity {
  localToken: string
  serverGeneration: string
}

/**
 * Load (or create) the bridge's persistent machine-owner identity.
 *
 * `localToken` is the attestation root the native host derives its
 * ticket-MAC key from (spec §9.1) — it MUST survive bridge restarts, so it
 * is read from `tokenFilePath` when present and only minted once. A file
 * that is missing, unreadable, or fails the `operator-token`-style shape
 * check is treated as absent and regenerated.
 *
 * `serverGeneration` is the opposite: a fresh UUID on EVERY call, so a
 * ticket minted before a restart is a stale-generation downgrade rather
 * than a MAC failure (spec §9.2).
 *
 * The token file is written atomically at owner-only (0600) permissions,
 * and re-chmodded on load so a file loosened out-of-band is tightened
 * again rather than silently trusted.
 */
export async function loadOrCreateBridgeIdentity(
  tokenFilePath: string
): Promise<BridgeIdentity> {
  await mkdir(dirname(tokenFilePath), { recursive: true })

  const existing = await readExistingToken(tokenFilePath)
  const localToken = existing ?? (await createToken(tokenFilePath))

  return { localToken, serverGeneration: randomUUID() }
}

async function readExistingToken(
  tokenFilePath: string
): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(tokenFilePath, 'utf-8')
  } catch {
    return undefined
  }
  if (!TOKEN_PATTERN.test(raw)) return undefined
  await chmod(tokenFilePath, 0o600)
  return raw
}

async function createToken(tokenFilePath: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await writeFileAtomic(tokenFilePath, token, { mode: 0o600 })
  await chmod(tokenFilePath, 0o600)
  return token
}
