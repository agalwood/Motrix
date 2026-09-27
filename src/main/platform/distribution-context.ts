export interface DistributionContextInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  windowsStore?: boolean
}

export interface DistributionContext {
  readonly distribution: 'development' | 'direct' | 'windows-package'
  readonly isWindowsPackage: boolean
}

/**
 * Electron's windowsStore flag identifies MSIX/AppX packaging, including
 * sideloaded test packages. It does not verify a Store publisher or package
 * family. Exact package identity validation would require a separate native
 * identity query; no such validation is performed here.
 */
export function resolveDistributionContext({
  platform,
  isPackaged,
  windowsStore,
}: DistributionContextInput): DistributionContext {
  if (!isPackaged) {
    return { distribution: 'development', isWindowsPackage: false }
  }
  if (platform === 'win32' && windowsStore === true) {
    return { distribution: 'windows-package', isWindowsPackage: true }
  }
  return { distribution: 'direct', isWindowsPackage: false }
}
