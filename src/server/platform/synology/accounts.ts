import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  type NasAccountAuthority,
  sameNasAccount,
} from '../nas/client-authorization'
import type { NasIdentity } from '../nas/identity'
import {
  type DsmApi,
  dsmAccountSchema,
  dsmApi,
  dsmBootstrapSchema,
  dsmFileSchema,
  dsmSessionSchema,
} from './api'
import { readDsmPosixAccount } from './commands'
import { type DsmContext, validDsmUsername } from './validation'

export { validDsmUsername } from './validation'

async function accountEpoch(): Promise<string> {
  const records = await Promise.all(
    ['/etc/passwd', '/etc/group'].map(async (file) => {
      const info = await stat(file, { bigint: true })
      if (!info.isFile() || info.uid !== 0n || (info.mode & 0o022n) !== 0n)
        throw new Error('Untrusted DSM account database')
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(
        ':'
      )
    })
  )
  return records.join('|')
}

export class SynologyAccounts implements NasAccountAuthority {
  readonly platform = 'synology' as const
  // No cookie/token is written to disk or returned to a client. Reopening the
  // DSM app supplies a new context after restart/expiration; bindings persist.
  // Only DSM determines session validity: every operation rechecks it. A local
  // inactivity cutoff must not interrupt a still-authorized long download.
  private readonly sessions = new Map<string, { context: DsmContext }>()
  constructor(
    private readonly api: DsmApi = dsmApi,
    private readonly epoch = accountEpoch,
    private readonly posix = readDsmPosixAccount
  ) {}

  private async validate(context: DsmContext, signal: AbortSignal) {
    const bootstrap = dsmBootstrapSchema.safeParse(
      await this.api(context, { kind: 'bootstrap' }, undefined, signal)
    )
    if (!bootstrap.success) return null
    const token = bootstrap.data.SynoToken
    const session = dsmSessionSchema.safeParse(
      await this.api(context, { kind: 'session' }, token, signal)
    )
    if (!session.success) return null
    const username = session.data.data.username
    const before = await this.epoch()
    const result = dsmAccountSchema.safeParse(
      await this.api(context, { kind: 'account', username }, token, signal)
    )
    if (!result.success) return null
    const record = result.data.data.users[0]
    const unix = await this.posix(username, signal)
    const after = await this.epoch()
    if (
      record.name !== username ||
      record.uid !== unix.uid ||
      !unix.administrator ||
      before !== after
    )
      return null
    return {
      token,
      identity: {
        platform: this.platform,
        userId: String(record.uid),
        username,
        administrator: true,
        accountRevision: createHash('sha256')
          .update(`${after}|${record.uid}|${username}`)
          .digest('hex'),
      },
    }
  }

  async authenticate(
    context: DsmContext,
    signal: AbortSignal
  ): Promise<NasIdentity | null> {
    const result = await this.validate(context, signal)
    if (!result) return null
    if (
      !this.sessions.has(result.identity.username) &&
      this.sessions.size >= 64
    ) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
    const existing = this.sessions.get(result.identity.username)
    const entry =
      existing && JSON.stringify(existing.context) === JSON.stringify(context)
        ? existing
        : { context: { ...context } }
    this.sessions.delete(result.identity.username)
    this.sessions.set(result.identity.username, entry)
    return result.identity
  }

  private async current(username: string, signal: AbortSignal) {
    if (!validDsmUsername(username)) return null
    const entry = this.sessions.get(username)
    if (!entry) return null
    const forget = () => {
      if (this.sessions.get(username) === entry) this.sessions.delete(username)
    }
    try {
      const result = await this.validate(entry.context, signal)
      if (!result || result.identity.username !== username) {
        forget()
        return null
      }
      if (this.sessions.get(username) !== entry) return null
      this.sessions.delete(username)
      this.sessions.set(username, entry)
      return { ...result, context: entry.context }
    } catch (error) {
      forget()
      throw error
    }
  }

  async lookup(
    username: string,
    signal: AbortSignal
  ): Promise<NasIdentity | null> {
    return (await this.current(username, signal))?.identity ?? null
  }
  async resolve(
    identity: NasIdentity,
    signal: AbortSignal
  ): Promise<NasIdentity | null> {
    if (identity.platform !== this.platform) return null
    const current = await this.lookup(identity.username, signal)
    return current?.userId === identity.userId ? current : null
  }
  async inspectFile(
    identity: NasIdentity,
    candidate: string,
    signal: AbortSignal
  ) {
    if (
      !/^\/volume[1-9]\d*\/[^/]+(?:\/.*)?$/.test(candidate) ||
      candidate
        .split('/')
        .slice(1)
        .some((p) => !p || p === '.' || p === '..')
    )
      return null
    const current = await this.current(identity.username, signal)
    if (!current || !sameNasAccount(current.identity, identity)) return null
    const virtual = candidate.replace(/^\/volume[1-9]\d*/, '')
    const result = dsmFileSchema.safeParse(
      await this.api(
        current.context,
        { kind: 'file', path: virtual },
        current.token,
        signal
      )
    )
    if (!result.success) return null
    const file = result.data.data.files[0]
    if (file.path !== virtual || file.additional.real_path !== candidate)
      return null
    return file
  }
}
