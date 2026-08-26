import { describe, expect, it, vi } from 'vitest'
import {
  buildWindowsDefaultAppsSettingsUrl,
  getWindowsDefaultAssociations,
  readWindowsUserChoice,
  resolveWindowsDefaultAppsSettingsUrl,
  supportsRegisteredAppDefaultAppsQuery,
  WINDOWS_DEFAULT_APPS_SETTINGS_URL,
  WINDOWS_REGISTERED_APP_NAME,
} from './windows-default-apps'

describe('Windows Default Apps settings', () => {
  it('builds scope-correct registered-app URLs', () => {
    expect(WINDOWS_REGISTERED_APP_NAME).toBe('Motrix')
    expect(buildWindowsDefaultAppsSettingsUrl('user')).toBe(
      'ms-settings:defaultapps?registeredAppUser=Motrix'
    )
    expect(buildWindowsDefaultAppsSettingsUrl('machine')).toBe(
      'ms-settings:defaultapps?registeredAppMachine=Motrix'
    )
    expect(buildWindowsDefaultAppsSettingsUrl(null)).toBe(
      WINDOWS_DEFAULT_APPS_SETTINGS_URL
    )
  })

  it.each([
    ['10.0.19045.5737', false],
    ['10.0.22000.1816', false],
    ['10.0.22000.1817', true],
    ['10.0.22621.1554', false],
    ['10.0.22621.1555', true],
    ['10.0.22631.0', true],
    ['10.0.26100.1', true],
    ['invalid', false],
  ])('detects registered-app query support for %s', (version, expected) => {
    expect(supportsRegisteredAppDefaultAppsQuery(version)).toBe(expected)
  })

  it('prefers a per-user registration because HKCU shadows HKLM', async () => {
    const hasRegistration = vi.fn().mockResolvedValue(true)

    await expect(
      resolveWindowsDefaultAppsSettingsUrl({
        osRelease: '10.0.22631.0',
        hasRegistration,
      })
    ).resolves.toBe('ms-settings:defaultapps?registeredAppUser=Motrix')
    expect(hasRegistration).toHaveBeenCalledOnce()
    expect(hasRegistration).toHaveBeenCalledWith('user')
  })

  it('uses the machine query for an all-users installation', async () => {
    const hasRegistration = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(
      resolveWindowsDefaultAppsSettingsUrl({
        osRelease: '10.0.22631.0',
        hasRegistration,
      })
    ).resolves.toBe('ms-settings:defaultapps?registeredAppMachine=Motrix')
    expect(hasRegistration.mock.calls).toEqual([['user'], ['machine']])
  })

  it('uses the generic page on Windows 10 without probing the registry', async () => {
    const hasRegistration = vi.fn()

    await expect(
      resolveWindowsDefaultAppsSettingsUrl({
        osRelease: '10.0.19045.5737',
        hasRegistration,
      })
    ).resolves.toBe(WINDOWS_DEFAULT_APPS_SETTINGS_URL)
    expect(hasRegistration).not.toHaveBeenCalled()
  })

  it('uses the generic page when the portable ZIP has no registration', async () => {
    const hasRegistration = vi.fn().mockResolvedValue(false)

    await expect(
      resolveWindowsDefaultAppsSettingsUrl({
        osRelease: '10.0.26100.1',
        hasRegistration,
      })
    ).resolves.toBe(WINDOWS_DEFAULT_APPS_SETTINGS_URL)
    expect(hasRegistration).toHaveBeenCalledTimes(2)
  })

  it('reports unsupported association status outside Windows', async () => {
    const hasRegistration = vi.fn()
    const readUserChoice = vi.fn()

    await expect(
      getWindowsDefaultAssociations({
        platform: 'linux',
        hasRegistration,
        readUserChoice,
      })
    ).resolves.toEqual({
      supported: false,
      registered: false,
      scope: null,
      torrent: false,
      magnet: false,
    })
    expect(hasRegistration).not.toHaveBeenCalled()
    expect(readUserChoice).not.toHaveBeenCalled()
  })

  it('uses Windows 11 UserChoiceLatest instead of a stale legacy value', async () => {
    const queryProgId = vi.fn(async (key: string) => {
      if (key.endsWith('UserChoiceLatest\\ProgId')) {
        return key.includes('FileExts')
          ? 'Motrix.File.Torrent'
          : 'Motrix.Url.Magnet'
      }
      return 'Other.Stale.Handler'
    })
    const readUserChoice = (association: 'torrent' | 'magnet') =>
      readWindowsUserChoice(association, { queryProgId })

    await expect(
      getWindowsDefaultAssociations({
        platform: 'win32',
        hasRegistration: vi.fn().mockResolvedValue(true),
        readUserChoice,
      })
    ).resolves.toMatchObject({ torrent: true, magnet: true })
    expect(queryProgId.mock.calls).toEqual([
      [
        'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.torrent\\UserChoiceLatest\\ProgId',
      ],
      [
        'Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\magnet\\UserChoiceLatest\\ProgId',
      ],
    ])
  })

  it('reports current defaults for an all-users installation', async () => {
    const hasRegistration = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const readUserChoice = vi.fn(async (association: string) => ({
      ok: true,
      progId:
        association === 'torrent' ? 'motrix.file.torrent' : 'Other.Url.Handler',
    }))

    await expect(
      getWindowsDefaultAssociations({
        platform: 'win32',
        hasRegistration,
        readUserChoice,
      })
    ).resolves.toEqual({
      supported: true,
      registered: true,
      scope: 'machine',
      torrent: true,
      magnet: false,
    })
    expect(hasRegistration.mock.calls).toEqual([['user'], ['machine']])
    expect(readUserChoice.mock.calls).toEqual([['torrent'], ['magnet']])
  })

  it('does not probe the machine scope when HKCU owns registration', async () => {
    const hasRegistration = vi.fn().mockResolvedValue(true)
    const readUserChoice = vi.fn().mockResolvedValue({
      ok: true,
      progId: 'Motrix.Url.Magnet',
    })

    await expect(
      getWindowsDefaultAssociations({
        platform: 'win32',
        hasRegistration,
        readUserChoice,
      })
    ).resolves.toMatchObject({
      registered: true,
      scope: 'user',
      torrent: false,
      magnet: true,
    })
    expect(hasRegistration).toHaveBeenCalledOnce()
  })

  it('reports registry query failures as unverifiable', async () => {
    await expect(
      getWindowsDefaultAssociations({
        platform: 'win32',
        hasRegistration: vi.fn().mockResolvedValue(null),
        readUserChoice: vi.fn().mockResolvedValue({
          ok: false,
          progId: null,
        }),
      })
    ).resolves.toEqual({
      supported: true,
      registered: null,
      scope: null,
      torrent: null,
      magnet: null,
    })
  })
})
