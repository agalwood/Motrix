import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { AppImageNativeHost } from './appimage-native-host'
import { resolveBridgeDataDir } from './snap-environment'

let installation: AppImageNativeHost | null = null

export function getAppImageNativeHost(): AppImageNativeHost | null {
  if (process.platform !== 'linux' || !app.isPackaged || !process.env.APPIMAGE)
    return null
  installation ??= new AppImageNativeHost({
    home: homedir(),
    env: process.env,
    appImagePath: process.env.APPIMAGE,
    sourceHostPath: join(process.resourcesPath, 'bin/motrix-native-host'),
    userDataDir: app.getPath('userData'),
    bridgeDataDir: resolveBridgeDataDir(
      app.getPath('userData'),
      process.env.MOTRIX_BRIDGE_DATA_DIR
    ),
    arch: process.arch,
  })
  return installation
}
