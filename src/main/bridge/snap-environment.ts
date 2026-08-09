import { dirname, isAbsolute, join, normalize, posix } from 'node:path'
import type { Platform } from './native-messaging-installer'

export interface PackagedLinuxSnapEnvironment {
  installRoot: string
  realHome: string
  instanceName: string
}

export interface SnapEnvironmentOptions {
  platform: Platform
  isPackaged: boolean
  resourcesPath: string
  env: Readonly<Record<string, string | undefined>>
}

export interface ElectronSelfUpdateOptions {
  hasUpdateMetadata: boolean
  isPackaged: boolean
  snapEnvironment: PackagedLinuxSnapEnvironment | null
}

const SNAP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const SNAP_INSTANCE_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:_[a-z0-9]{1,10})?$/

export function isValidSnapInstanceName(value: string): boolean {
  return SNAP_INSTANCE_NAME.test(value)
}

/**
 * Store-managed packages must not compete with electron-updater. Even if an
 * app-update.yml file is accidentally staged, snapd remains the only
 * application update authority for a packaged Snap.
 */
export function isElectronSelfUpdateSupported(
  options: ElectronSelfUpdateOptions
): boolean {
  return (
    options.isPackaged &&
    options.snapEnvironment === null &&
    options.hasUpdateMetadata
  )
}

function canonicalAbsoluteDirectory(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    dirname(value) === value
  ) {
    throw new Error(`${label} must be a canonical absolute directory`)
  }
  return value
}

function canonicalAbsoluteSnapDirectory(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    posix.dirname(value) === value
  ) {
    throw new Error(`${label} must be a canonical absolute directory`)
  }
  return value
}

function snapIdentity(env: Readonly<Record<string, string | undefined>>): {
  instanceName: string
  snapName: string
} {
  const explicitInstance = env.SNAP_INSTANCE_NAME
  const fallbackName = env.SNAP_NAME
  const instanceName =
    explicitInstance === undefined || explicitInstance.length === 0
      ? fallbackName
      : explicitInstance

  if (!instanceName || !isValidSnapInstanceName(instanceName)) {
    throw new Error('SNAP_INSTANCE_NAME must be a valid snap instance name')
  }
  const snapName = fallbackName ?? instanceName.split('_', 1)[0]
  if (
    !snapName ||
    !SNAP_NAME.test(snapName) ||
    (instanceName !== snapName && !instanceName.startsWith(`${snapName}_`))
  ) {
    throw new Error('SNAP_NAME must match SNAP_INSTANCE_NAME')
  }
  return { instanceName, snapName }
}

function isPathWithin(parent: string, child: string): boolean {
  const childRelative = posix.relative(parent, child)
  return (
    childRelative === '' ||
    (!childRelative.startsWith('..') && !posix.isAbsolute(childRelative))
  )
}

/**
 * Resolve the environment contract snapd provides to a packaged Linux app.
 *
 * `SNAP` is the activation signal. Once present, every security-sensitive
 * value is required to be internally consistent; malformed partial Snap
 * environments fail closed instead of writing browser manifests elsewhere.
 */
export function resolvePackagedLinuxSnapEnvironment(
  options: SnapEnvironmentOptions
): PackagedLinuxSnapEnvironment | null {
  if (options.platform !== 'linux' || !options.isPackaged) {
    return null
  }

  const rawInstallRoot = options.env.SNAP
  if (rawInstallRoot === undefined) {
    return null
  }

  const installRoot = canonicalAbsoluteSnapDirectory(rawInstallRoot, 'SNAP')
  const realHome = canonicalAbsoluteSnapDirectory(
    options.env.SNAP_REAL_HOME ?? '',
    'SNAP_REAL_HOME'
  )
  const { instanceName, snapName } = snapIdentity(options.env)
  const resourcesPath = canonicalAbsoluteSnapDirectory(
    options.resourcesPath,
    'process.resourcesPath'
  )

  if (posix.basename(posix.dirname(installRoot)) !== snapName) {
    throw new Error('SNAP does not match SNAP_NAME')
  }
  if (!isPathWithin(installRoot, resourcesPath)) {
    throw new Error('process.resourcesPath must be inside SNAP')
  }

  return { installRoot, realHome, instanceName }
}

/**
 * Recognize only the historical default produced when Node resolved
 * `os.homedir()` from Snap's revision-scoped HOME. User-selected directories
 * outside this exact shape must survive upgrades unchanged.
 */
export function isLegacySnapDefaultSaveDir(
  value: string,
  snap: Pick<PackagedLinuxSnapEnvironment, 'instanceName' | 'realHome'>
): boolean {
  if (
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes('\0')
  ) {
    return false
  }
  const legacyRoot = posix.join(snap.realHome, 'snap', snap.instanceName)
  const segments = posix.relative(legacyRoot, value).split('/')
  return (
    segments.length === 2 &&
    (segments[0] === 'current' || /^[1-9]\d*$/.test(segments[0])) &&
    segments[1] === 'Downloads'
  )
}

/**
 * Bridge persistence may be moved to a revision-independent directory by a
 * packaging environment. Missing overrides preserve the historic
 * `<userData>/bridge` path; malformed overrides are rejected.
 */
export function resolveBridgeDataDir(
  userDataDir: string,
  override: string | undefined
): string {
  if (override === undefined) {
    return join(userDataDir, 'bridge')
  }
  return canonicalAbsoluteDirectory(override, 'MOTRIX_BRIDGE_DATA_DIR')
}
