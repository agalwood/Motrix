import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { nasRootPathSchema } from '@shared/schemas/nas-settings'
import { z } from 'zod'
import {
  type NasFileAccess,
  type NasFilePermission,
  NasFiles,
} from '../nas/files'
import type { NasIdentity } from '../nas/identity'
import { readNasConfigurationText } from '../nas/settings-store'
import type { SynologyAccounts } from './accounts'

export const dsmDirectoryConfig = z
  .object({
    roots: z
      .array(
        nasRootPathSchema.refine((root) =>
          /^\/volume[1-9]\d*\/[^/]+(?:\/.*)?$/.test(root)
        )
      )
      .min(1)
      .max(64),
  })
  .strict()

/** Inspect existing grants without creating a directory or following a replaced
 * share onto another volume. A mount-table failure cannot grant any paths. */
export async function unavailableDsmRoots(
  roots: readonly string[]
): Promise<string[]> {
  const configured = dsmDirectoryConfig.parse({ roots }).roots
  const mounts = new Set(
    (await readFile('/proc/self/mountinfo', 'utf8'))
      .split('\n')
      .map((line) => line.split(' ')[4])
  )
  const checked = await Promise.all(
    configured.map(async (root) => {
      if (!mounts.has(root.split('/').slice(0, 2).join('/'))) return root
      try {
        if (
          (await realpath(root)) !== root ||
          !(await lstat(root)).isDirectory()
        )
          return root
        await access(root, constants.R_OK | constants.W_OK | constants.X_OK)
        return null
      } catch {
        return root
      }
    })
  )
  return checked.filter((root): root is string => root !== null)
}

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
    const text = await readNasConfigurationText(this.configFile)
    let document: unknown
    try {
      document = JSON.parse(text ?? '')
    } catch {
      throw new Error('Invalid DSM directory configuration')
    }
    const config = dsmDirectoryConfig.parse(document)
    if ((await unavailableDsmRoots(config.roots)).length)
      throw new Error('DSM share unavailable')
    return config.roots
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
