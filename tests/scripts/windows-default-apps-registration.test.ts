import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_DEFAULT_APPS_SETTINGS_URL,
  WINDOWS_REGISTERED_APP_NAME,
} from '../../src/main/platform/windows-default-apps'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
)

const TORRENT_ASSOCIATION = {
  ext: 'torrent',
  mimeType: 'application/x-bittorrent',
  name: 'Torrent',
  role: 'Viewer',
}

interface BuilderConfig {
  fileAssociations?: unknown
  linux?: { fileAssociations?: unknown }
  mac?: { fileAssociations?: unknown }
  nsis?: {
    allowToChangeInstallationDirectory?: boolean
    include?: string
    perMachine?: boolean
  }
  win?: { fileAssociations?: unknown }
}

async function readJson(relativePath: string): Promise<BuilderConfig> {
  return JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8')
  ) as BuilderConfig
}

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8')
}

function nsisDefine(source: string, name: string): string | undefined {
  return new RegExp(`^!define ${name} "([^"]+)"$`, 'm').exec(source)?.[1]
}

function nsisMacro(source: string, name: string): string {
  const body = new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(
    source
  )?.[1]
  if (!body) throw new Error(`missing NSIS macro: ${name}`)
  return body
}

describe('Windows Default Apps registration', () => {
  it('keeps Windows associations installer-owned and other platforms unchanged', async () => {
    const config = await readJson('electron-builder.json')
    const signingConfig = await readJson('electron-builder.signing.json')

    expect(config.fileAssociations).toBeUndefined()
    expect(config.win?.fileAssociations).toBeUndefined()
    expect(config.mac?.fileAssociations).toEqual([TORRENT_ASSOCIATION])
    expect(config.linux?.fileAssociations).toEqual([TORRENT_ASSOCIATION])
    expect(config.nsis).toMatchObject({
      allowToChangeInstallationDirectory: true,
      include: 'build/installer.nsh',
      perMachine: false,
    })

    expect(signingConfig.fileAssociations).toBeUndefined()
    expect(signingConfig.win?.fileAssociations).toBeUndefined()
    expect(signingConfig.mac?.fileAssociations).toEqual([TORRENT_ASSOCIATION])
    expect(signingConfig.nsis).toMatchObject({
      allowToChangeInstallationDirectory: true,
      include: 'trusted/installer.nsh',
      perMachine: false,
    })
  })

  it('advertises app-specific torrent and magnet ProgIDs without changing UserChoice', async () => {
    const installer = await readText('build/installer.nsh')
    const register = nsisMacro(installer, 'registerMotrixDefaultApps')

    expect(nsisDefine(installer, 'MOTRIX_REGISTERED_APP_NAME')).toBe(
      WINDOWS_REGISTERED_APP_NAME
    )
    expect(nsisDefine(installer, 'MOTRIX_CAPABILITIES_KEY')).toBe(
      'Software\\Motrix\\Capabilities'
    )
    expect(nsisDefine(installer, 'MOTRIX_TORRENT_PROGID')).toBe(
      'Motrix.File.Torrent'
    )
    expect(nsisDefine(installer, 'MOTRIX_MAGNET_PROGID')).toBe(
      'Motrix.Url.Magnet'
    )
    expect(nsisDefine(installer, 'MOTRIX_PROTOCOL')).toBe('motrix')

    expect(register).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\RegisteredApplications"'
    )
    expect(register).toContain(
      `"\${MOTRIX_CAPABILITIES_KEY}" "ApplicationDescription" "\${APP_DESCRIPTION}"`
    )
    expect(register).toContain(
      `"\${MOTRIX_CAPABILITIES_KEY}" "ApplicationName" "\${MOTRIX_REGISTERED_APP_NAME}"`
    )
    expect(register).toContain(
      `"\${MOTRIX_CAPABILITIES_KEY}\\FileAssociations" ".torrent" "\${MOTRIX_TORRENT_PROGID}"`
    )
    expect(register).toContain(
      `"\${MOTRIX_CAPABILITIES_KEY}\\UrlAssociations" "magnet" "\${MOTRIX_MAGNET_PROGID}"`
    )
    expect(register).toContain(
      `"Software\\Classes\\\${MOTRIX_TORRENT_PROGID}\\shell\\open\\command"`
    )
    expect(register).toContain(
      `"Software\\Classes\\\${MOTRIX_MAGNET_PROGID}\\shell\\open\\command"`
    )
    expect(register).toContain(
      `"Software\\Classes\\\${MOTRIX_PROTOCOL}\\shell\\open\\command"`
    )
    expect(register.match(/'"\$appExe" "%1"'/gu)).toHaveLength(3)
    expect(register).toContain(
      `"Software\\Classes\\.torrent\\OpenWithProgids" "\${MOTRIX_TORRENT_PROGID}"`
    )
    expect(register).toContain('shell32::SHChangeNotify')
    expect(installer).not.toContain('UserChoice')
  })

  it('cleans the old scope on updates and only Motrix-owned keys', async () => {
    const installer = await readText('build/installer.nsh')
    const install = nsisMacro(installer, 'customInstall')
    const uninstall = nsisMacro(installer, 'customUnInstall')
    const remove = nsisMacro(installer, 'deleteMotrixDefaultApps')
    const legacyCleanup = nsisMacro(
      installer,
      'deleteLegacyMotrixProtocolHandlers'
    )

    expect(install).toContain('!insertmacro deleteLegacyMotrixProtocolHandlers')
    expect(install).toContain('!insertmacro registerMotrixDefaultApps')
    expect(
      uninstall.indexOf('!insertmacro deleteMotrixDefaultApps')
    ).toBeLessThan(uninstall.search(/\$\{ifNot\} \$\{isUpdated\}/u))
    expect(legacyCleanup).toContain(
      String.raw`DeleteRegKey HKCU "Software\Classes\${MOTRIX_PROTOCOL}"`
    )
    expect(legacyCleanup).toContain(
      'ReadRegStr $0 HKCU "Software\\Classes\\magnet\\shell\\open\\command"'
    )
    expect(legacyCleanup).toContain(String.raw`'\${APP_EXECUTABLE_FILENAME}"'`)
    expect(remove).toContain(
      'DeleteRegValue SHELL_CONTEXT "Software\\RegisteredApplications"'
    )
    expect(remove).toContain(
      `DeleteRegKey SHELL_CONTEXT "Software\\Classes\\\${MOTRIX_TORRENT_PROGID}"`
    )
    expect(remove).toContain(
      `DeleteRegKey SHELL_CONTEXT "Software\\Classes\\\${MOTRIX_MAGNET_PROGID}"`
    )
    expect(remove).toContain(
      `DeleteRegKey SHELL_CONTEXT "Software\\Classes\\\${MOTRIX_PROTOCOL}"`
    )
    expect(remove).not.toContain(
      'DeleteRegKey SHELL_CONTEXT "Software\\Classes\\.torrent"'
    )
    expect(remove).not.toContain(
      'DeleteRegKey SHELL_CONTEXT "Software\\Classes\\magnet"'
    )
  })

  it('keeps a generic settings fallback for Windows 10 and portable ZIPs', () => {
    expect(WINDOWS_DEFAULT_APPS_SETTINGS_URL).toBe('ms-settings:defaultapps')
  })
})
