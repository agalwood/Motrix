import { randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { operatorTokenSchema } from '@shared/schemas/operator-token'

export interface ProvisionedOperatorToken {
  token: string
  source: 'env' | 'file'
  /** Where the host operator can read the token (only when minted to a file). */
  path?: string
}

/**
 * Provision the operator (machine-owner) secret for the server control plane,
 * INDEPENDENTLY of the (non-fatal) MDXP bridge bootstrap (Spec 9 / F1). The
 * bridge writes the AGENT `localToken` to `endpoint.json`, but that step can
 * fail (port in use, bad host, write error) — so the operator secret must NOT
 * ride on it, or a bridge failure would lock the web UI behind an in-memory
 * token with no readable source.
 *
 * `MOTRIX_OPERATOR_TOKEN` wins (the operator set it; nothing to discover).
 * Otherwise mint a random token and write it to `<dataDir>/operator-token`
 * (mode 0600) so a host operator can read it. The token itself is never logged
 * (callers log only `source`/`path`).
 */
export async function provisionOperatorToken(opts: {
  dataDir: string
  env?: NodeJS.ProcessEnv
}): Promise<ProvisionedOperatorToken> {
  const env = opts.env ?? process.env
  const fromEnv = env.MOTRIX_OPERATOR_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { token: fromEnv, source: 'env' }
  }
  const path = join(opts.dataDir, 'operator-token')
  await mkdir(dirname(path), { recursive: true })
  const existing = await readExistingToken(path)
  if (existing) return { token: existing, source: 'file', path }

  const token = randomBytes(32).toString('base64url')
  try {
    await writeFile(path, token, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const concurrent = await readExistingToken(path)
    if (concurrent) return { token: concurrent, source: 'file', path }
    throw error
  }
  await chmod(path, 0o600)
  return { token, source: 'file', path }
}

async function readExistingToken(path: string): Promise<string | undefined> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!metadata.isFile()) {
    throw new Error(`Operator token path is not a regular file: ${path}`)
  }
  const token = await readFile(path, 'utf8')
  if (!operatorTokenSchema.safeParse(token).success) {
    throw new Error(`Operator token file is invalid: ${path}`)
  }
  await chmod(path, 0o600)
  return token
}

/** Keep the previous credential intact if writing the replacement fails. */
export async function persistOperatorToken(
  path: string,
  token: string
): Promise<void> {
  operatorTokenSchema.parse(token)
  const metadata = await lstat(path)
  if (!metadata.isFile())
    throw new Error('Operator token is not a regular file')
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(token, 'utf8')
    await file.sync()
    await file.close()
    await rename(temporary, path)
  } finally {
    await file.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** Basic with an empty username carries Unicode/space-containing passphrases. */
export function operatorTokenAuthorization(token: string): string {
  return /^[\x21-\x7e]+$/.test(token)
    ? `Bearer ${token}`
    : `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`
}
