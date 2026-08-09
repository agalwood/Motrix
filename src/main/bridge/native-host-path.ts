import { join, posix } from 'node:path'
import type { Platform } from './native-messaging-installer'
import { isValidSnapInstanceName } from './snap-environment'

export const NATIVE_HOST_BASENAME = 'motrix-native-host'

export interface NativeHostPathOptions {
  platform: Platform
  arch: string
  isPackaged: boolean
  resourcesPath: string
  cwd: string
  devOverride?: string
  snapInstanceName?: string
}

export function nativeHostBinaryName(platform: Platform): string {
  return platform === 'win32'
    ? `${NATIVE_HOST_BASENAME}.exe`
    : NATIVE_HOST_BASENAME
}

export function resolveNativeHostBinaryPath(
  options: NativeHostPathOptions
): string {
  if (options.arch !== 'x64' && options.arch !== 'arm64') {
    throw new Error(`Unsupported native-host architecture: ${options.arch}`)
  }

  const binaryName = nativeHostBinaryName(options.platform)
  if (options.isPackaged) {
    if (
      options.platform === 'linux' &&
      options.snapInstanceName !== undefined
    ) {
      if (!isValidSnapInstanceName(options.snapInstanceName)) {
        throw new Error('Invalid Snap native-host instance name')
      }
      return posix.join('/snap/bin', `${options.snapInstanceName}.native-host`)
    }
    return join(options.resourcesPath, 'bin', binaryName)
  }

  return (
    options.devOverride ??
    join(
      options.cwd,
      'packages',
      'native-host',
      'dist',
      `${options.platform}-${options.arch}`,
      binaryName
    )
  )
}
