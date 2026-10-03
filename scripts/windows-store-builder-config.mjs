import path from 'node:path'

/**
 * Prepare only the directory payload for later Windows SDK packaging.
 * Package identity, signing, and AppX generation are separate operations.
 */
export function createWindowsStoreBuilderConfig(base, { outputDirectory }) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new Error('Electron builder configuration must be an object')
  }
  if (
    typeof outputDirectory !== 'string' ||
    !path.isAbsolute(outputDirectory)
  ) {
    throw new Error('Windows Store output directory must be absolute')
  }
  if (base.directories?.app !== 'dist/electron-app' || base.asar !== true) {
    throw new Error('Windows Store payload requires the staged Electron asar')
  }
  if (
    base.beforePack !== './scripts/before-pack-verify.mjs' ||
    base.beforeBuild !== './scripts/before-build-use-staged-dependencies.mjs'
  ) {
    throw new Error('Windows Store payload requires the existing staging hooks')
  }
  if (!base.win || !Array.isArray(base.win.extraResources)) {
    throw new Error('Windows Store payload requires Windows runtime resources')
  }

  const config = structuredClone(base)
  // Disable automatic config inheritance and global/Windows update publishers.
  // The caller must also invoke electron-builder with --win --x64 --publish never.
  config.extends = null
  config.publish = null
  config.forceCodeSigning = false
  config.detectUpdateChannel = false
  config.generateUpdatesFilesForAllChannels = false
  config.directories.output = path.resolve(outputDirectory)
  config.win.target = [{ target: 'dir', arch: ['x64'] }]
  config.win.publish = null
  // Store signs the outer package. Preserve EXE resource editing and all fuses.
  config.win.signExecutable = false
  delete config.nsis
  delete config.artifactBuildCompleted
  return config
}
