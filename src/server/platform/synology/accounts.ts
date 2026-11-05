import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { NasAccountAuthority } from '../nas/client-authorization'
import type { NasIdentity } from '../nas/identity'
import { type DsmCommand, dsmCommand } from './commands'

const usernamePattern = /^(?!.*[\s:[\]\\/])\P{Cc}{1,128}$/u
export function validDsmUsername(name: string): boolean {
  return usernamePattern.test(name) && !name.startsWith('-')
}

/** synouser's local-account view includes live expiration and group membership.
 * Domain/LDAP accounts need their own authoritative status contract. */
export function parseDsmAccount(output: string, username: string) {
  const field = (name: string) => {
    const matches = [
      ...output.matchAll(
        new RegExp(`^${name}\\s*:\\s*\\[([^\\]\\r\\n]*)\\]\\s*$`, 'gm')
      ),
    ]
    return matches.length === 1 ? matches[0][1] : undefined
  }
  const uid = field('User uid')
  if (
    !validDsmUsername(username) ||
    field('User Name') !== username ||
    field('User Type') !== 'AUTH_LOCAL' ||
    field('Expired') !== 'false' ||
    !uid ||
    !/^[1-9]\d*$/.test(uid) ||
    !Number.isSafeInteger(Number(uid)) ||
    Number(uid) >= 0xffffffff ||
    !/^\(101\) administrators\s*$/m.test(output)
  )
    return null
  return {
    platform: 'synology' as const,
    userId: uid,
    username,
    administrator: true,
  }
}

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
  constructor(
    private readonly command: DsmCommand = dsmCommand,
    private readonly epoch = accountEpoch
  ) {}

  async lookup(
    username: string,
    signal: AbortSignal
  ): Promise<NasIdentity | null> {
    if (!validDsmUsername(username)) return null
    signal.throwIfAborted()
    const before = await this.epoch()
    const account = parseDsmAccount(
      await this.command(
        '/usr/syno/sbin/synouser',
        ['--get', username],
        {},
        signal
      ),
      username
    )
    const after = await this.epoch()
    if (!account || before !== after) return null
    // Conservatively revoke every binding when either local account database
    // changes, including UID reuse. No password data is read or persisted.
    return {
      ...account,
      accountRevision: createHash('sha256')
        .update(`${after}|${account.userId}|${username}`)
        .digest('hex'),
    }
  }

  async resolve(
    identity: NasIdentity,
    signal: AbortSignal
  ): Promise<NasIdentity | null> {
    if (identity.platform !== this.platform) return null
    const current = await this.lookup(identity.username, signal)
    return current?.userId === identity.userId ? current : null
  }
}
