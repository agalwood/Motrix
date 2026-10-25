import { statSync } from 'node:fs'
import path from 'node:path'
import type { AppUpdateState } from '@shared/types/app-update'

export interface MacUpdateInstallContext {
  platform: NodeJS.Platform
  isPackaged: boolean
  execPath: string
  temporaryDirectory: string
}

/**
 * Squirrel moves the installed app into NSTemporaryDirectory before replacing
 * it. Across volumes this is a copy/delete sequence, not an atomic rename;
 * interruption can leave the installed app missing. Keep these installations
 * on manual updates until the native installer can stage and recover safely.
 * https://github.com/Squirrel/Squirrel.Mac/issues/334
 */
export function getMacUpdateInstallBlockReason(
  context: MacUpdateInstallContext
): AppUpdateState['manualInstallReason'] {
  if (context.platform !== 'darwin' || !context.isPackaged) return undefined

  const executableDirectory = path.dirname(context.execPath)
  const contentsDirectory = path.dirname(executableDirectory)
  const bundleDirectory = path.dirname(contentsDirectory)
  if (
    path.basename(executableDirectory) !== 'MacOS' ||
    path.basename(contentsDirectory) !== 'Contents' ||
    !bundleDirectory.endsWith('.app')
  ) {
    return 'location-unavailable'
  }

  try {
    // stat follows links and compares actual filesystems, not path prefixes.
    // ~/Applications and other directories on the same volume remain valid.
    const bundle = statSync(bundleDirectory)
    const parent = statSync(path.dirname(bundleDirectory))
    const temporary = statSync(context.temporaryDirectory)
    if (!bundle.isDirectory() || !temporary.isDirectory()) {
      return 'location-unavailable'
    }
    if (bundle.dev !== temporary.dev || parent.dev !== bundle.dev) {
      return 'cross-volume'
    }
    return undefined
  } catch {
    // A disconnected or inaccessible volume must not reach quitAndInstall.
    return 'location-unavailable'
  }
}
