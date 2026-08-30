import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/
const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

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

/**
 * Load the stable MBP1 transcript identity for a shell which has no settings
 * store of its own (currently Motrix Server). Missing is the only create case:
 * malformed, symbolic-link, non-regular, or multiply-linked state fails
 * closed so a storage problem cannot silently present a new Server identity.
 * The caller must already own the bridge data-directory lock.
 */
export async function loadOrCreateBridgeInstanceId(
  instanceIdFilePath: string
): Promise<string> {
  await mkdir(dirname(instanceIdFilePath), { recursive: true })
  try {
    const before = await lstat(instanceIdFilePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error('bridge instance identity unavailable')
    }
    const handle = await open(
      instanceIdFilePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    let value: string
    try {
      const during = await handle.stat({ bigint: true })
      if (during.dev !== before.dev || during.ino !== before.ino) {
        throw new Error('bridge instance identity unavailable')
      }
      value = await handle.readFile('utf8')
      const after = await lstat(instanceIdFilePath, { bigint: true })
      if (after.dev !== during.dev || after.ino !== during.ino) {
        throw new Error('bridge instance identity unavailable')
      }
    } finally {
      await handle.close()
    }
    if (!INSTANCE_ID_PATTERN.test(value)) {
      throw new Error('bridge instance identity unavailable')
    }
    await chmod(instanceIdFilePath, 0o600)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const value = randomUUID()
  await writeFileAtomic(instanceIdFilePath, value, { mode: 0o600 })
  await chmod(instanceIdFilePath, 0o600)
  return value
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
