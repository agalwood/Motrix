import { execFile } from 'node:child_process'
import { release } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { WindowsDefaultAssociations } from '@shared/types/windows-default-apps'

const execFileAsync = promisify(execFile)

export const WINDOWS_REGISTERED_APP_NAME = 'Motrix'
export const WINDOWS_DEFAULT_APPS_SETTINGS_URL = 'ms-settings:defaultapps'
const WINDOWS_CAPABILITIES_REGISTRY_PATH = 'Software\\Motrix\\Capabilities'
const WINDOWS_TORRENT_PROGID = 'Motrix.File.Torrent'
const WINDOWS_MAGNET_PROGID = 'Motrix.Url.Magnet'
const WINDOWS_ASSOCIATION_KEYS = {
  torrent:
    'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.torrent',
  magnet:
    'Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\magnet',
} as const
const WINDOWS_USER_CHOICE_SUFFIXES = [
  'UserChoiceLatest\\ProgId',
  'UserChoiceLatest',
  'UserChoice',
] as const

type WindowsAssociation = keyof typeof WINDOWS_ASSOCIATION_KEYS

interface WindowsUserChoiceResult {
  ok: boolean
  progId: string | null
}

interface ReadWindowsUserChoiceDeps {
  queryProgId?: (key: string) => Promise<string | null>
}

export type WindowsRegistrationScope = 'user' | 'machine'

interface ResolveWindowsDefaultAppsSettingsUrlDeps {
  osRelease?: string
  hasRegistration?: (scope: WindowsRegistrationScope) => Promise<boolean | null>
}

interface GetWindowsDefaultAssociationsDeps {
  platform?: NodeJS.Platform
  hasRegistration?: (scope: WindowsRegistrationScope) => Promise<boolean | null>
  readUserChoice?: (
    association: WindowsAssociation
  ) => Promise<WindowsUserChoiceResult>
}

/**
 * The registered-app query was backported to specific Windows 11 cumulative
 * updates. Windows 10 and earlier Windows 11 builds only support the generic
 * Default Apps page.
 */
export function supportsRegisteredAppDefaultAppsQuery(
  osRelease: string
): boolean {
  const [major, minor, build, revision = 0] = osRelease
    .split('.')
    .map((part) => Number.parseInt(part, 10))

  if (major !== 10 || minor !== 0) return false
  if (build === 22000) return revision >= 1817
  if (build === 22621) return revision >= 1555
  return build >= 22631
}

export function buildWindowsDefaultAppsSettingsUrl(
  scope: WindowsRegistrationScope | null
): string {
  if (!scope) return WINDOWS_DEFAULT_APPS_SETTINGS_URL
  const query = scope === 'user' ? 'registeredAppUser' : 'registeredAppMachine'
  return `${WINDOWS_DEFAULT_APPS_SETTINGS_URL}?${query}=${encodeURIComponent(WINDOWS_REGISTERED_APP_NAME)}`
}

async function hasWindowsRegistration(
  scope: WindowsRegistrationScope
): Promise<boolean | null> {
  const root = scope === 'user' ? 'HKCU' : 'HKLM'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const regExe = path.win32.join(systemRoot, 'System32', 'reg.exe')

  try {
    const { stdout } = await execFileAsync(
      regExe,
      ['query', `${root}\\Software\\RegisteredApplications`, '/reg:64'],
      { timeout: 2_000, windowsHide: true }
    )
    const registration = new RegExp(
      `^\\s*${WINDOWS_REGISTERED_APP_NAME}\\s+REG_\\w+\\s+(.+?)\\s*$`,
      'imu'
    ).exec(stdout.toString())?.[1]
    return (
      registration?.toLowerCase() ===
      WINDOWS_CAPABILITIES_REGISTRY_PATH.toLowerCase()
    )
  } catch {
    return null
  }
}

async function queryWindowsRegistryProgId(key: string): Promise<string | null> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const regExe = path.win32.join(systemRoot, 'System32', 'reg.exe')

  try {
    const { stdout } = await execFileAsync(
      regExe,
      ['query', `HKCU\\${key}`, '/v', 'ProgId', '/reg:64'],
      { timeout: 2_000, windowsHide: true }
    )
    return (
      /^\s*ProgId\s+REG_\w+\s+(.+?)\s*$/imu.exec(stdout.toString())?.[1] ?? null
    )
  } catch {
    return null
  }
}

/**
 * Windows 11 24H2+ records the effective choice in UserChoiceLatest and may
 * leave the legacy UserChoice stale. Current builds nest ProgId one level
 * deeper, while earlier builds used a direct value. Probe both Latest layouts
 * before falling back to the legacy key so the verdict follows the handler
 * Windows actually resolves.
 */
export async function readWindowsUserChoice(
  association: WindowsAssociation,
  deps: ReadWindowsUserChoiceDeps = {}
): Promise<WindowsUserChoiceResult> {
  const queryProgId = deps.queryProgId ?? queryWindowsRegistryProgId
  const baseKey = WINDOWS_ASSOCIATION_KEYS[association]

  for (const suffix of WINDOWS_USER_CHOICE_SUFFIXES) {
    const progId = await queryProgId(`${baseKey}\\${suffix}`)
    if (progId !== null) return { ok: true, progId }
  }

  return { ok: false, progId: null }
}

export async function getWindowsDefaultAssociations(
  deps: GetWindowsDefaultAssociationsDeps = {}
): Promise<WindowsDefaultAssociations> {
  if ((deps.platform ?? process.platform) !== 'win32') {
    return {
      supported: false,
      registered: false,
      scope: null,
      torrent: false,
      magnet: false,
    }
  }

  const hasRegistration = deps.hasRegistration ?? hasWindowsRegistration
  const readUserChoice = deps.readUserChoice ?? readWindowsUserChoice
  const [userRegistered, torrentChoice, magnetChoice] = await Promise.all([
    hasRegistration('user'),
    readUserChoice('torrent'),
    readUserChoice('magnet'),
  ])
  const machineRegistered =
    userRegistered === true ? false : await hasRegistration('machine')
  const registered =
    userRegistered === true || machineRegistered === true
      ? true
      : userRegistered === false && machineRegistered === false
        ? false
        : null

  return {
    supported: true,
    registered,
    scope:
      userRegistered === true
        ? 'user'
        : userRegistered === false && machineRegistered === true
          ? 'machine'
          : null,
    torrent: torrentChoice.ok
      ? torrentChoice.progId?.toLowerCase() ===
        WINDOWS_TORRENT_PROGID.toLowerCase()
      : null,
    magnet: magnetChoice.ok
      ? magnetChoice.progId?.toLowerCase() ===
        WINDOWS_MAGNET_PROGID.toLowerCase()
      : null,
  }
}

export async function resolveWindowsDefaultAppsSettingsUrl(
  deps: ResolveWindowsDefaultAppsSettingsUrlDeps = {}
): Promise<string> {
  if (!supportsRegisteredAppDefaultAppsQuery(deps.osRelease ?? release())) {
    return WINDOWS_DEFAULT_APPS_SETTINGS_URL
  }

  const hasRegistration = deps.hasRegistration ?? hasWindowsRegistration
  const userRegistration = await hasRegistration('user')
  if (userRegistration === true) {
    return buildWindowsDefaultAppsSettingsUrl('user')
  }
  // An unreadable HKCU registration could shadow HKLM. Avoid a scope-specific
  // deep link when the effective scope cannot be established.
  if (userRegistration === null) return WINDOWS_DEFAULT_APPS_SETTINGS_URL
  if ((await hasRegistration('machine')) === true) {
    return buildWindowsDefaultAppsSettingsUrl('machine')
  }

  // The portable ZIP never runs the NSIS registration. Keep its button useful
  // by opening the generic page instead of deep-linking to a nonexistent app.
  return WINDOWS_DEFAULT_APPS_SETTINGS_URL
}
