import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BRIDGE_DATA_DIR_LOCK_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_RECOVERY_GUARD_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_UNAVAILABLE,
  type BridgeDataDirLockRecoveryAuthority,
} from '@core/bridge/bridge-data-dir-lock'

const OWNERSHIP_EPOCH_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const WINDOWS_DESKTOP_RESIDUE_FILE_NAMES = [
  'endpoint.json',
  'extension-pairings.json.lock',
  BRIDGE_DATA_DIR_LOCK_RECOVERY_GUARD_FILE_NAME,
  BRIDGE_DATA_DIR_LOCK_FILE_NAME,
] as const

export interface WindowsDesktopStartupRecoveryOptions {
  readonly platform: NodeJS.Platform
  readonly dataDirectory: string
  readonly bridgeDataDirectoryOverride: string | undefined
  readonly authority: BridgeDataDirLockRecoveryAuthority
}

function unavailable(): Error {
  return new Error(BRIDGE_DATA_DIR_LOCK_UNAVAILABLE)
}

/**
 * Migrate crash residue created by desktop betas that could not recover their
 * bridge lock on Windows. This is limited to Electron's default private data
 * root, where the already-held app single-instance lock is the owner proof.
 * Server and explicitly shared/custom roots keep the core fail-closed policy.
 */
export async function recoverDefaultWindowsDesktopBridgeResidue(
  options: WindowsDesktopStartupRecoveryOptions
): Promise<void> {
  if (
    options.platform !== 'win32' ||
    options.bridgeDataDirectoryOverride !== undefined
  ) {
    return
  }

  if (!OWNERSHIP_EPOCH_PATTERN.test(options.authority.ownershipEpoch)) {
    throw unavailable()
  }

  let authorized = false
  try {
    authorized =
      (await options.authority.assertExclusiveProcessOwnership()) === true
  } catch {
    throw unavailable()
  }
  if (!authorized) throw unavailable()

  for (const fileName of WINDOWS_DESKTOP_RESIDUE_FILE_NAMES) {
    const filePath = join(options.dataDirectory, fileName)
    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw unavailable()
    }

    // unlink removes a final symlink itself, never its target. Directories and
    // other unexpected filesystem objects remain untouched and fail closed.
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw unavailable()
    }
    try {
      await unlink(filePath)
    } catch {
      throw unavailable()
    }
  }
}
