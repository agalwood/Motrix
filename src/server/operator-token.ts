import { randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  const token = randomBytes(32).toString('base64url')
  const path = join(opts.dataDir, 'operator-token')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, token, { mode: 0o600 })
  await chmod(path, 0o600)
  return { token, source: 'file', path }
}
