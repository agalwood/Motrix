export interface ElectronSelfUpdateOptions {
  hasUpdateMetadata: boolean
  isPackaged: boolean
  isWindowsPackage: boolean
  isSnap: boolean
}

/** System-managed packages cannot opt into EXE updates by carrying a feed. */
export function isElectronSelfUpdateSupported(
  options: ElectronSelfUpdateOptions
): boolean {
  return (
    options.isPackaged &&
    !options.isWindowsPackage &&
    !options.isSnap &&
    options.hasUpdateMetadata
  )
}
