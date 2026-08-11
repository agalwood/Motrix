import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aria2BinaryName } from '@shared/platform/aria2'
import type { PlatformServices } from '@shared/platform/services'
import { RunHost } from '@shared/platform/services'

export interface NodeServicesOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  homedir?: () => string
  moduleUrl?: string
}

const USER_DIR_NAME = 'motrix-turbo-server'

function defaultUserDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', USER_DIR_NAME)
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? home, USER_DIR_NAME)
  }
  return '/var/lib/motrix'
}

function defaultExtraResourceDir(
  platform: NodeJS.Platform,
  moduleUrl: string
): string {
  if (platform !== 'darwin' && platform !== 'win32') {
    return '/usr/share/motrix/extra'
  }
  // Resolve relative to the executing module (dist/server/index.mjs in prod).
  const here = path.dirname(fileURLToPath(moduleUrl))
  return path.resolve(here, '..', '..', 'extra')
}

function defaultAria2Path(
  platform: NodeJS.Platform,
  arch: string,
  extraResourceDir: string
): string {
  if (platform !== 'darwin' && platform !== 'win32') {
    return '/usr/bin/aria2c'
  }
  return path.join(extraResourceDir, platform, arch, aria2BinaryName(platform))
}

export function createNodePlatformServices(
  opts: NodeServicesOptions = {}
): PlatformServices {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const homedir = opts.homedir ?? os.homedir
  const moduleUrl = opts.moduleUrl ?? import.meta.url
  const home = homedir()

  const userDataDir =
    env.MOTRIX_DATA_DIR ?? defaultUserDataDir(platform, env, home)
  const extraResourceDir =
    env.MOTRIX_EXTRA_DIR ?? defaultExtraResourceDir(platform, moduleUrl)
  const aria2BinaryPath =
    env.MOTRIX_ARIA2_BIN ?? defaultAria2Path(platform, arch, extraResourceDir)
  const isDev = env.NODE_ENV === 'development'

  return {
    host: RunHost.Node,
    userDataDir,
    extraResourceDir,
    aria2BinaryPath,
    isDev,
  }
}
