import { join } from 'node:path'
import type { PackagedLinuxSnapEnvironment } from '../bridge/snap-environment'
import { isLegacySnapDefaultSaveDir } from '../bridge/snap-environment'

export interface DefaultSaveDirOptionsInput {
  snapEnvironment: Pick<
    PackagedLinuxSnapEnvironment,
    'instanceName' | 'realHome'
  > | null
  getSystemDownloadsDir: () => string
  getHomeDir: () => string
  ensureDirectory: (directory: string) => void
  onSystemDownloadsDirError?: (error: unknown, fallbackDir: string) => void
}

export interface DefaultSaveDirOptions {
  defaultSaveDir: string
  isLegacyDefaultSaveDir?: (value: string) => boolean
}

/** Resolve host-specific defaults without changing an already persisted path. */
export function resolveDefaultSaveDirOptions({
  snapEnvironment,
  getSystemDownloadsDir,
  getHomeDir,
  ensureDirectory,
  onSystemDownloadsDirError,
}: DefaultSaveDirOptionsInput): DefaultSaveDirOptions {
  if (snapEnvironment === null) {
    try {
      return { defaultSaveDir: getSystemDownloadsDir() }
    } catch (error) {
      const fallbackDir = join(getHomeDir(), 'Downloads')
      ensureDirectory(fallbackDir)
      onSystemDownloadsDirError?.(error, fallbackDir)
      return { defaultSaveDir: fallbackDir }
    }
  }

  // Electron resolves Downloads from Snap's revision-scoped HOME. Strict
  // confinement cannot read the host's hidden XDG user-dir configuration
  // without a privileged personal-files grant, so retain the stable real-home
  // default and its narrowly scoped legacy migration.
  return {
    defaultSaveDir: join(snapEnvironment.realHome, 'Downloads'),
    isLegacyDefaultSaveDir: (value: string) =>
      isLegacySnapDefaultSaveDir(value, snapEnvironment),
  }
}
