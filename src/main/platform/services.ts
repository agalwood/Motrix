import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { aria2BinaryName } from '@shared/platform/aria2'
import { type PlatformServices, RunHost } from '@shared/platform/services'
import { app } from 'electron'
import {
  type DistributionContext,
  resolveDistributionContext,
} from './distribution-context'

export function createElectronPlatformServices(
  distributionContext: DistributionContext = resolveDistributionContext({
    platform: process.platform,
    isPackaged: app.isPackaged,
    windowsStore: process.windowsStore,
  })
): PlatformServices {
  const isDev = !app.isPackaged
  const userDataOverride = process.env.MOTRIX_USER_DATA
  const { isWindowsPackage } = distributionContext
  const dataPaths = process.platform === 'win32' ? path.win32 : path
  if (isWindowsPackage && userDataOverride) {
    throw new Error('MOTRIX_USER_DATA is unsupported for Windows packages')
  }
  if (isWindowsPackage && process.env.MOTRIX_BRIDGE_DATA_DIR) {
    // Bridge credentials and discovery state must share the isolated profile.
    // Reject this before any persistent consumer can reopen a direct profile.
    throw new Error(
      'MOTRIX_BRIDGE_DATA_DIR is unsupported for Windows packages'
    )
  }

  let userDataDir: string
  if (isWindowsPackage) {
    // Never consult or migrate the direct-install profile in package mode.
    // Resolve AppData through Electron so Windows controls its package mapping.
    userDataDir = dataPaths.join(app.getPath('appData'), 'Motrix-Store')
  } else {
    const defaultUserDataDir = app.getPath('userData')
    userDataDir =
      userDataOverride ||
      (isDev ? `${defaultUserDataDir}-dev` : defaultUserDataDir)
  }

  // Resolve this before any persistent service or the single-instance lock.
  // Electron requires an existing absolute directory for app.setPath().
  if (isWindowsPackage || userDataOverride || isDev) {
    if (!dataPaths.isAbsolute(userDataDir)) {
      throw new Error(
        isWindowsPackage
          ? 'Windows package AppData must be an absolute path'
          : 'MOTRIX_USER_DATA must be an absolute path'
      )
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
