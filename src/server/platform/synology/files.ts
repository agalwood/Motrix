import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from 'node:fs/promises'
import path from 'node:path'
import { nasRootPathSchema } from '@shared/schemas/nas-settings'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
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
    directoryIdentities: z
      .array(z.string().regex(/^\d{1,20}:\d{1,20}$/))
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.directoryIdentities ||
      value.directoryIdentities.length === value.roots.length
  )

/** Capture only canonical directories on mounted DSM volumes. A failed lookup
 * cannot establish a new grant or satisfy a previously recorded identity. */
export async function inspectDsmRoots(roots: string[]) {
  dsmDirectoryConfig.parse({ roots })
  const mounts = new Set(
    (await readFile('/proc/self/mountinfo', 'utf8'))
      .split('\n')
      .map((line) => line.split(' ')[4])
  )
  return Promise.all(
    roots.map(async (root) => {
      if (!mounts.has(root.split('/').slice(0, 2).join('/'))) return null
      try {
        const directory = await open(
          root,
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK
        )
        try {
          const held = await directory.stat({ bigint: true })
          if ((await realpath(root)) !== root) return null
          await access(root, constants.R_OK | constants.W_OK | constants.X_OK)
          const named = await lstat(root, { bigint: true })
          return held.dev === named.dev && held.ino === named.ino
            ? `${held.dev}:${held.ino}`
            : null
        } finally {
          await directory.close()
        }
      } catch {
        return null
      }
    })
  )
}

export async function readDsmDirectoryGrants(
  configFile: string,
  initializeLegacy = false
) {
  const text = await readNasConfigurationText(configFile)
  let document: unknown
  try {
    document = JSON.parse(text ?? '')
  } catch {
    throw new Error('Invalid DSM directory configuration')
  }
  const config = dsmDirectoryConfig.parse(document)
  const current = await inspectDsmRoots(config.roots)
  // Only the serialized lifecycle's initial server startup may migrate a
  // path-only configuration. Later requests never adopt a new directory.
  if (
    initializeLegacy &&
    !config.directoryIdentities &&
    current.every((id): id is string => id !== null)
  ) {
    config.directoryIdentities = current
    await writeFileAtomic(configFile, `${JSON.stringify(config)}\n`, {
      mode: 0o600,
    })
    const parent = await open(
      path.dirname(configFile),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }
  const unavailable = config.roots.filter(
    (_, i) =>
      current[i] === null ||
      (config.directoryIdentities
        ? current[i] !== config.directoryIdentities[i]
        : !initializeLegacy)
  )
  return { ...config, unavailable }
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
    const config = await readDsmDirectoryGrants(this.configFile)
    if (config.unavailable.length) throw new Error('DSM share unavailable')
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

  override async policy(
    defaultSaveDir: string
  ): Promise<ServerDownloadPathPolicy> {
    const base = await super.policy(defaultSaveDir)
    return {
      get allowedSaveDirs() {
        return base.allowedSaveDirs
      },
      authorizeDirectory: base.authorizeDirectory,
      prepareSaveDir: async (requested) => {
        const candidate = requested || defaultSaveDir
        if (
          !path.isAbsolute(candidate) ||
          path.resolve(candidate) !== candidate ||
          candidate.includes('\0')
        )
          throw Error('Invalid DSM save path')
        const root = (await this.roots())
          .filter((dir) => candidate === dir || candidate.startsWith(`${dir}/`))
          .sort((a, b) => b.length - a.length)[0]
        if (!root) throw Error('DSM directory is outside authorized shares')
        const flags =
          constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK
        let name = root
        let held = await open(root, flags)
        try {
          for (const part of [
            ...path.relative(root, candidate).split(path.sep).filter(Boolean),
            null,
          ]) {
            if ((await base.authorizeDirectory(name)).canonicalPath !== name)
              throw Error('DSM directory changed')
            const opened = await held.stat({ bigint: true }),
              named = await lstat(name, { bigint: true })
            if (named.dev !== opened.dev || named.ino !== opened.ino)
              throw Error('DSM directory changed')
            const fd = `/proc/self/fd/${held.fd}`
            if (!part) {
              await this.check(name, 'writable')
              await access(fd, constants.W_OK | constants.X_OK)
              return name
            }
            const child = path.join(fd, part)
            let next: typeof held
            try {
              next = await open(child, flags)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error
              await this.check(name, 'writable')
              await mkdir(child).catch((cause: NodeJS.ErrnoException) => {
                if (cause.code !== 'EEXIST') throw cause
              })
              next = await open(child, flags)
            }
            await held.close()
            held = next
            name = path.join(name, part)
          }
          throw Error('Invalid DSM save path')
        } finally {
          await held.close()
        }
      },
    }
  }
}
