import path from 'node:path'
import { bundledAria2Path } from '@shared/platform/aria2'
import { type PlatformServices, RunHost } from '@shared/platform/services'
import { app } from 'electron'

export function createElectronPlatformServices(): PlatformServices {
  const isDev = !app.isPackaged

  // Honor MOTRIX_USER_DATA so e2e harnesses (and any tooling that needs
  // hermetic state) can redirect settings/db/logs to a tmp dir without
  // polluting the developer's real userData. Must run before reading
  // userData so the override path is what's returned below.
  const userDataOverride = process.env.MOTRIX_USER_DATA
  if (userDataOverride) {
    app.setPath('userData', userDataOverride)
  }

  const projectRoot = isDev ? path.resolve(__dirname, '..', '..') : ''
  const extraDir = isDev
    ? path.join(projectRoot, 'extra')
    : path.join(process.resourcesPath, 'extra')

  return {
    host: RunHost.Electron,
    userDataDir: app.getPath('userData'),
    extraResourceDir: extraDir,
    aria2BinaryPath: bundledAria2Path(extraDir, process.platform, process.arch),
    isDev,
  }
}
