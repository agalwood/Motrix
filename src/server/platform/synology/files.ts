import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  type NasFileAccess,
  type NasFilePermission,
  NasFiles,
} from '../nas/files'
import type { NasIdentity } from '../nas/identity'
import type { SynologyAccounts } from './accounts'

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

export function dsmPermission(
  acl: {
    read: boolean
    write: boolean
    append: boolean
    exec: boolean
    del: boolean
  },
  permission: NasFilePermission,
  directory: boolean
): boolean {
  return permission === 'deletable'
    ? acl.del
    : permission === 'writable'
      ? acl.write && (!directory || (acl.exec && acl.append))
      : acl.read && (!directory || acl.exec)
}

export class SynologyFileAccess implements NasFileAccess {
  readonly platform = 'synology' as const
  constructor(
    private readonly configFile: string,
    private readonly accounts: SynologyAccounts
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
      const roots = await this.authorizedRoots()
      if (
        !roots.some(
          (root) => candidate === root || candidate.startsWith(`${root}/`)
        )
      )
        return false
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) return false
      await access(
        permission === 'deletable' ? path.dirname(candidate) : candidate,
        permission === 'readable' ? constants.R_OK : constants.W_OK
      )
      const file = await this.accounts.inspectFile(
        user,
        candidate,
        AbortSignal.timeout(5000)
      )
      return (
        file !== null &&
        file.isdir === info.isDirectory() &&
        dsmPermission(file.additional.perm.acl, permission, file.isdir)
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
