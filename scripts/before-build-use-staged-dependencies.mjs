import path from 'node:path'

/**
 * The Electron package stager has already resolved, filtered, and copied the
 * complete target dependency closure. Returning false tells electron-builder
 * not to rebuild or independently recollect dependencies from the workspace
 * root, which would bypass that reviewed staging boundary.
 */
export default async function useStagedDependencies(context) {
  const expectedAppDir = path.resolve(context.appDir)
  if (
    path.basename(expectedAppDir) !== 'electron-app' ||
    path.basename(path.dirname(expectedAppDir)) !== 'dist'
  ) {
    throw new Error(
      '[before-build-use-staged-dependencies] expected appDir to be dist/electron-app'
    )
  }
  return false
}
