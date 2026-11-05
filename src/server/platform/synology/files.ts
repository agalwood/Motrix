import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { sameNasAccount } from '../nas/client-authorization'
import {
  type NasFileAccess,
  type NasFilePermission,
  NasFiles,
} from '../nas/files'
import type { NasIdentity } from '../nas/identity'
import type { SynologyAccounts } from './accounts'
import { type DsmCommand, dsmCommand } from './commands'

export const dsmDirectoryConfig = z
  .object({
    roots: z
      .array(
        z
          .string()
          .regex(/^\/volume[1-9]\d*\/[^/]+(?:\/.*)?$/)
          .max(4096)
      )
      .min(1)
      .max(64),
  })
  .strict()

/** Only the single effective-permission mask is accepted, never an ACE list.
 * Unknown DSM tool output fails closed and must be checked on the target DSM. */
export function dsmPermission(
  output: string,
  permission: NasFilePermission,
  directory: boolean
): boolean {
  const match =
    /^Final permission: \[([r-][w-][x-][p-][d-][D-][a-][A-][R-][W-][c-][C-][o-])\]\s*$/.exec(
      output.trim()
    )
  if (!match) return false
  const mask = match[1]
  return permission === 'deletable'
    ? mask.includes('d')
    : permission === 'writable'
      ? mask.includes('w') &&
        (!directory || (mask.includes('x') && mask.includes('p')))
      : mask.includes('r') && (!directory || mask.includes('x'))
}

export class SynologyFileAccess implements NasFileAccess {
  readonly platform = 'synology' as const
  constructor(
    private readonly configFile: string,
    private readonly accounts: SynologyAccounts,
    private readonly command: DsmCommand = dsmCommand
  ) {}

  async authorizedRoots(): Promise<string[]> {
    const config = dsmDirectoryConfig.parse(
      JSON.parse(await readFile(this.configFile, 'utf8'))
    )
    return Promise.all(
      config.roots.map(async (root) => {
        const canonical = await realpath(root)
        if (canonical !== root || !(await lstat(root)).isDirectory())
          throw new Error('DSM share unavailable')
        // Pin the volume to an actual mount; never create a download root on the
        // system volume after storage has gone offline.
        const volume = root.split('/').slice(0, 2).join('/')
        const mounts = await readFile('/proc/self/mountinfo', 'utf8')
        if (!mounts.split('\n').some((line) => line.split(' ')[4] === volume))
          throw new Error('DSM volume offline')
        return canonical
      })
    )
  }

  async checkAccess(
    user: NasIdentity,
    candidate: string,
    permission: NasFilePermission
  ): Promise<boolean> {
    if (user.platform !== this.platform) return false
    try {
      const account = await this.accounts.resolve(
        user,
        AbortSignal.timeout(4000)
      )
      if (!account || (user.accountRevision && !sameNasAccount(user, account)))
        return false
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) return false
      await access(
        permission === 'deletable' ? path.dirname(candidate) : candidate,
        permission === 'readable' ? constants.R_OK : constants.W_OK
      )
      return dsmPermission(
        await this.command('/usr/syno/bin/synoacltool', [
          '-get-perm',
          candidate,
          user.username,
        ]),
        permission,
        info.isDirectory()
      )
    } catch {
      return false
    }
  }
}

export class SynologyFiles extends NasFiles {
  constructor(configFile: string, accounts: SynologyAccounts) {
    super(new SynologyFileAccess(configFile, accounts))
  }
}
