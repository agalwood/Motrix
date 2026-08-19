import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Writes Native Messaging host manifest files for Chrome, Edge, Firefox, and
 * (on Linux) unbranded Chromium at OS-specific locations each browser scans.
 *
 * Chromium-family browsers expect `allowed_origins` with full
 * `chrome-extension://<id>/` URLs; Firefox expects a plain `allowed_extensions`
 * ID array. The host binary path is identical across browsers.
 *
 * On macOS/Linux each browser reads a host manifest from its own directory.
 * On Windows discovery is registry-based: we emit the JSON files under a
 * private Motrix folder and register a per-browser HKCU key whose default
 * value points at the matching JSON file (Chrome, Edge, and Firefox each use
 * a separate registry hive, e.g. Google\Chrome vs Microsoft\Edge).
 */

export type Platform = 'darwin' | 'linux' | 'win32'

export interface ManifestPaths {
  chrome: string
  firefox: string
  edge?: string
  /**
   * Unbranded Chromium (e.g. Debian/Ubuntu `chromium` packages). Linux only:
   * on Windows Chromium has no stable HKCU vendor key we register, and on
   * macOS the unbranded browser is not a supported target.
   */
  chromium?: string
}

export interface RegistryEntry {
  /** Registry hive; Native Messaging hosts are registered per-user under HKCU. */
  hive: 'HKCU'
  /** Backslash-separated key path under the hive, ending at the host name. */
  keyPath: string
  /** Default-value data: absolute path to the host manifest JSON file. */
  value: string
}

export type RegistryView = '32' | '64'

const MANIFEST_NAME = 'app.motrix.bridge.json'
const MANIFEST_HOST_NAME = 'app.motrix.bridge'
const MANIFEST_DESCRIPTION = 'Motrix browser download bridge'
const WINDOWS_REGISTRY_VIEWS: RegistryView[] = ['32', '64']
const FLATPAK_COMPANION_BINARY = 'motrix-flatpak-native-host'

interface ManifestOwnership {
  allowed_extensions?: unknown
  allowed_origins?: unknown
  description?: unknown
  name?: unknown
  path?: unknown
  type?: unknown
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  )
}

function isFlatpakCompanionManifest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const manifest = value as ManifestOwnership
  if (
    manifest.name === MANIFEST_HOST_NAME &&
    manifest.description === MANIFEST_DESCRIPTION &&
    manifest.type === 'stdio' &&
    typeof manifest.path === 'string' &&
    !manifest.path.includes('\0') &&
    posix.isAbsolute(manifest.path) &&
    posix.normalize(manifest.path) === manifest.path &&
    manifest.path.endsWith(
      `/motrix/native-messaging/${FLATPAK_COMPANION_BINARY}`
    )
  ) {
    const keys = Object.keys(value).sort().join(',')
    const chromiumKeys = 'allowed_origins,description,name,path,type'
    const firefoxKeys = 'allowed_extensions,description,name,path,type'
    return (
      (keys === chromiumKeys &&
        isNonEmptyStringArray(manifest.allowed_origins) &&
        manifest.allowed_origins.every(
          (origin) =>
            origin.startsWith('chrome-extension://') && origin.endsWith('/')
        )) ||
      (keys === firefoxKeys &&
        isNonEmptyStringArray(manifest.allowed_extensions))
    )
  }
  return false
}

function isOwnedManifest(value: unknown, hostBinaryPath: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  const manifest = value as ManifestOwnership
  return (
    manifest.name === MANIFEST_HOST_NAME && manifest.path === hostBinaryPath
  )
}

export function computeManifestPaths(
  platform: Platform,
  home: string,
  windowsRoamingAppData?: string
): ManifestPaths {
  if (platform === 'darwin') {
    return {
      chrome: `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${MANIFEST_NAME}`,
      firefox: `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/${MANIFEST_NAME}`,
      edge: `${home}/Library/Application Support/Microsoft Edge/NativeMessagingHosts/${MANIFEST_NAME}`,
    }
  }
  if (platform === 'linux') {
    return {
      chrome: `${home}/.config/google-chrome/NativeMessagingHosts/${MANIFEST_NAME}`,
      chromium: `${home}/.config/chromium/NativeMessagingHosts/${MANIFEST_NAME}`,
      firefox: `${home}/.mozilla/native-messaging-hosts/${MANIFEST_NAME}`,
      edge: `${home}/.config/microsoft-edge/NativeMessagingHosts/${MANIFEST_NAME}`,
    }
  }
  // win32: registry-based discovery. Use the resolved Roaming AppData known
  // folder when available because enterprise folder redirection can move it
  // outside the user's home directory.
  const roamingAppData = windowsRoamingAppData ?? `${home}/AppData/Roaming`
  const manifestDir = join(roamingAppData, 'Motrix', 'bridge', 'manifests')
  return {
    chrome: join(manifestDir, 'chrome.json'),
    edge: join(manifestDir, 'edge.json'),
    firefox: join(manifestDir, 'firefox.json'),
  }
}

/**
 * Native Messaging host registry entries to register on Windows. Returns an
 * empty list on macOS/Linux (which use file-based discovery). Each entry's
 * default value points at the host manifest JSON the installer writes, so the
 * Chrome and Edge keys resolve to their own files independently — Edge does not
 * read Chrome's registry key reliably (only the first key found is honoured).
 */
export function computeRegistryEntries(
  platform: Platform,
  paths: ManifestPaths
): RegistryEntry[] {
  if (platform !== 'win32') return []
  // Chrome, Firefox, and Edge each discover the host through their own HKCU
  // key; only the vendor segment and the target JSON file differ per browser.
  const hosts: Array<[vendor: string, manifest: string | undefined]> = [
    ['Google\\Chrome', paths.chrome],
    ['Mozilla', paths.firefox],
    ['Microsoft\\Edge', paths.edge],
  ]
  return hosts.flatMap(([vendor, manifest]): RegistryEntry[] =>
    manifest
      ? [
          {
            hive: 'HKCU',
            keyPath: `SOFTWARE\\${vendor}\\NativeMessagingHosts\\${MANIFEST_HOST_NAME}`,
            value: manifest,
          },
        ]
      : []
  )
}

/**
 * Default registry writer: sets the key's default value via `reg.exe add`.
 * Injectable through InstallerOptions.registryWriter so tests can record
 * entries without touching the real registry.
 */
async function regAddDefaultValue(
  entry: RegistryEntry,
  view: RegistryView
): Promise<void> {
  await execFileAsync('reg', [
    'add',
    `${entry.hive}\\${entry.keyPath}`,
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    entry.value,
    '/f',
    `/reg:${view}`,
  ])
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Deletes a Native Messaging registry key through the .NET registry API.
 * DeleteSubKeyTree(..., false) is idempotent for a missing key while access
 * and other real failures remain terminating PowerShell errors.
 */
async function regDeleteKey(
  entry: RegistryEntry,
  view: RegistryView
): Promise<void> {
  const registryView = view === '32' ? 'Registry32' : 'Registry64'
  const keyPath = quotePowerShellLiteral(entry.keyPath)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::${registryView})`,
    'try {',
    `  $baseKey.DeleteSubKeyTree(${keyPath}, $false)`,
    '} finally {',
    '  $baseKey.Dispose()',
    '}',
  ].join('\n')
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
}

export interface InstallerOptions {
  /** Absolute path to the Native Messaging host executable. */
  hostBinaryPath: string
  /**
   * Root used when resolving manifest output locations. In production this is
   * `os.homedir()`; tests inject a temp dir to avoid touching the real home.
   */
  manifestRoot: string
  platform: Platform
  /**
   * Resolved Windows Roaming AppData known folder. Production passes
   * `app.getPath('appData')`; tests may inject a redirected location.
   */
  windowsRoamingAppData?: string
  /**
   * Writes one Windows registry entry and view. Defaults to `reg.exe`; tests
   * inject a recorder to avoid touching the registry. Only invoked on win32.
   */
  registryWriter?: (entry: RegistryEntry, view: RegistryView) => Promise<void>
  /**
   * Deletes one Windows registry entry and view. Defaults to the PowerShell
   * .NET registry API; tests inject a recorder to avoid touching the registry.
   */
  registryDeleter?: (entry: RegistryEntry, view: RegistryView) => Promise<void>
  /**
   * Whether Motrix owns the host browser manifests. Flatpak uses `external`:
   * `/app` is not executable by a host browser, and a separate host-side
   * companion must own both the launcher and manifests.
   */
  registrationMode?: 'managed' | 'external'
}

export interface SyncArgs {
  /** Chromium-family extension IDs (Chrome / Edge). */
  chromium: string[]
  /** Firefox extension IDs (typically `name@vendor` form). */
  firefox: string[]
}

interface ChromiumManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

interface FirefoxManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_extensions: string[]
}

export class NativeMessagingInstaller {
  constructor(private readonly opts: InstallerOptions) {}

  async syncManifests(args: SyncArgs): Promise<void> {
    if (this.opts.registrationMode === 'external') return

    const paths = computeManifestPaths(
      this.opts.platform,
      this.opts.manifestRoot,
      this.opts.windowsRoamingAppData
    )

    const chromiumManifest: ChromiumManifest = {
      name: MANIFEST_HOST_NAME,
      description: MANIFEST_DESCRIPTION,
      path: this.opts.hostBinaryPath,
      type: 'stdio',
      allowed_origins: args.chromium.map((id) => `chrome-extension://${id}/`),
    }
    await this.writeJson(paths.chrome, chromiumManifest)
    if (paths.chromium) {
      await this.writeJson(paths.chromium, chromiumManifest)
    }
    if (paths.edge) {
      await this.writeJson(paths.edge, chromiumManifest)
    }

    const firefoxManifest: FirefoxManifest = {
      name: MANIFEST_HOST_NAME,
      description: MANIFEST_DESCRIPTION,
      path: this.opts.hostBinaryPath,
      type: 'stdio',
      allowed_extensions: args.firefox,
    }
    await this.writeJson(paths.firefox, firefoxManifest)

    // Windows: register each browser's host key so the JSON files are
    // discoverable. computeRegistryEntries returns [] on macOS/Linux (which use
    // file-based discovery), so the registration is a no-op there. The keys are
    // independent. Register both views because Chrome and Firefox query the
    // 32-bit view before the native view, and an older registration must not
    // shadow the current host path.
    const writeRegistry = this.opts.registryWriter ?? regAddDefaultValue
    const registryEntries = computeRegistryEntries(this.opts.platform, paths)
    await Promise.all(
      registryEntries.flatMap((entry) =>
        WINDOWS_REGISTRY_VIEWS.map((view) => writeRegistry(entry, view))
      )
    )
  }

  async unregister(): Promise<void> {
    if (this.opts.registrationMode === 'external') return

    const paths = computeManifestPaths(
      this.opts.platform,
      this.opts.manifestRoot,
      this.opts.windowsRoamingAppData
    )
    const registryEntries = computeRegistryEntries(this.opts.platform, paths)
    const deleteRegistry = this.opts.registryDeleter ?? regDeleteKey
    await Promise.all(
      registryEntries.flatMap((entry) =>
        WINDOWS_REGISTRY_VIEWS.map((view) => deleteRegistry(entry, view))
      )
    )

    const manifestPaths = [
      paths.chrome,
      paths.chromium,
      paths.edge,
      paths.firefox,
    ].filter((filePath): filePath is string => filePath !== undefined)
    await Promise.all(
      manifestPaths.map((filePath) => this.removeOwnedManifest(filePath))
    )
  }

  private async writeJson(filePath: string, obj: object): Promise<void> {
    if (
      this.opts.platform === 'linux' &&
      (await this.readManifest(filePath).then(isFlatpakCompanionManifest))
    ) {
      return
    }
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8')
  }

  private async removeOwnedManifest(filePath: string): Promise<void> {
    if (this.opts.platform === 'win32') {
      await rm(filePath, { force: true })
      return
    }
    const manifest = await this.readManifest(filePath)
    if (isOwnedManifest(manifest, this.opts.hostBinaryPath)) {
      await rm(filePath, { force: true })
    }
  }

  private async readManifest(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(filePath, 'utf-8'))
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return null
      }
      // Malformed or unreadable files are not treated as owned during
      // unregister. syncManifests may still repair them by overwriting.
      return null
    }
  }
}
