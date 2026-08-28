import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { aria2BinaryName } from '@shared/platform/aria2'
import { type PlatformServices, RunHost } from '@shared/platform/services'
import { app } from 'electron'

export function createElectronPlatformServices(): PlatformServices {
  const isDev = !app.isPackaged
  const userDataOverride = process.env.MOTRIX_USER_DATA
  const defaultUserDataDir = app.getPath('userData')
  const userDataDir =
    userDataOverride ||
    (isDev ? `${defaultUserDataDir}-dev` : defaultUserDataDir)

  // Resolve this before any persistent service or the single-instance lock.
  // Electron requires an existing absolute directory for app.setPath().
  if (userDataOverride || isDev) {
    if (!path.isAbsolute(userDataDir)) {
      throw new Error('MOTRIX_USER_DATA must be an absolute path')
    }
    mkdirSync(userDataDir, { recursive: true })
    app.setPath('userData', userDataDir)
    app.setPath('sessionData', userDataDir)
  }

  const projectRoot = isDev ? path.resolve(__dirname, '..', '..') : ''
  const extraDir = isDev
    ? path.join(projectRoot, 'extra')
    : path.join(process.resourcesPath, 'extra')

  return {
    host: RunHost.Electron,
    userDataDir,
    extraResourceDir: extraDir,
    aria2BinaryPath: path.join(
      extraDir,
      process.platform,
      process.arch,
      aria2BinaryName(process.platform)
    ),
    isDev,
  }
}
