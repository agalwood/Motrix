import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeManifestPaths,
  computeRegistryEntries,
  NativeMessagingInstaller,
  type RegistryEntry,
  type RegistryView,
} from './native-messaging-installer'

describe('computeManifestPaths', () => {
  it('returns correct macOS Chrome path', () => {
    const paths = computeManifestPaths('darwin', '/Users/me')
    expect(paths.chrome).toContain(
      '/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.motrix.bridge.json'
    )
    expect(paths.firefox).toContain(
      '/Users/me/Library/Application Support/Mozilla/NativeMessagingHosts/app.motrix.bridge.json'
    )
    expect(paths.chromium).toBeUndefined()
  })

  it('returns correct Linux paths', () => {
    const paths = computeManifestPaths('linux', '/home/me')
    expect(paths.chrome).toContain(
      '/home/me/.config/google-chrome/NativeMessagingHosts/app.motrix.bridge.json'
    )
    expect(paths.chromium).toContain(
      '/home/me/.config/chromium/NativeMessagingHosts/app.motrix.bridge.json'
    )
    expect(paths.firefox).toContain(
      '/home/me/.mozilla/native-messaging-hosts/app.motrix.bridge.json'
    )
  })
})

describe('NativeMessagingInstaller.syncManifests', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-nm-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes Chrome manifest with correct allowed_origins', async () => {
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: '/path/to/motrix-bridge-host',
      manifestRoot: dir,
      platform: 'darwin',
    })
    await installer.syncManifests({
      chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
      firefox: ['motrix-extension@motrix.app'],
    })
    const chromeContent = JSON.parse(
      await readFile(
        join(
          dir,
          'Library/Application Support/Google/Chrome/NativeMessagingHosts/app.motrix.bridge.json'
        ),
        'utf-8'
      )
    )
    expect(chromeContent.name).toBe('app.motrix.bridge')
    expect(chromeContent.path).toBe('/path/to/motrix-bridge-host')
    expect(chromeContent.allowed_origins).toContain(
      'chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/'
    )
  })

  it('writes the chromium-family manifest to the Debian Chromium path on Linux', async () => {
    const hostBinaryPath = '/opt/Motrix/resources/bin/motrix-native-host'
    const installer = new NativeMessagingInstaller({
      hostBinaryPath,
      manifestRoot: dir,
      platform: 'linux',
    })
    await installer.syncManifests({
      chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
      firefox: ['motrix-extension@motrix.app'],
    })
    const chromium = JSON.parse(
      await readFile(
        join(
          dir,
          '.config/chromium/NativeMessagingHosts/app.motrix.bridge.json'
        ),
        'utf-8'
      )
    )
    expect(chromium.name).toBe('app.motrix.bridge')
    expect(chromium.path).toBe(hostBinaryPath)
    expect(chromium.allowed_origins).toEqual([
      'chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/',
    ])
  })

  it('writes Firefox manifest with allowed_extensions', async () => {
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: '/path/to/motrix-bridge-host',
      manifestRoot: dir,
      platform: 'darwin',
    })
    await installer.syncManifests({
      chromium: [],
      firefox: ['motrix-extension@motrix.app'],
    })
    const ff = JSON.parse(
      await readFile(
        join(
          dir,
          'Library/Application Support/Mozilla/NativeMessagingHosts/app.motrix.bridge.json'
        ),
        'utf-8'
      )
    )
    expect(ff.allowed_extensions).toEqual(['motrix-extension@motrix.app'])
  })

  it('leaves host-side manifests to an external Flatpak companion', async () => {
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: '/app/bin/motrix-native-host',
      manifestRoot: dir,
      platform: 'linux',
      registrationMode: 'external',
    })
    const paths = computeManifestPaths('linux', dir)
    const chromiumSentinel = Buffer.from('companion-owned-chromium')
    const firefoxSentinel = Buffer.from('companion-owned-firefox')
    await mkdir(dirname(paths.chrome), { recursive: true })
    await mkdir(dirname(paths.firefox), { recursive: true })
    await writeFile(paths.chrome, chromiumSentinel)
    await writeFile(paths.firefox, firefoxSentinel)

    await installer.syncManifests({
      chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
      firefox: ['motrix-extension@motrix.app'],
    })
    await installer.unregister()

    expect(await readFile(paths.chrome)).toEqual(chromiumSentinel)
    expect(await readFile(paths.firefox)).toEqual(firefoxSentinel)
  })

  it('does not replace manifests owned by an installed Flatpak companion', async () => {
    const paths = computeManifestPaths('linux', dir)
    const flatpakManifest = {
      name: 'app.motrix.bridge',
      description: 'Motrix browser download bridge',
      path: `${dir}/.local/share/motrix/native-messaging/motrix-flatpak-native-host`,
      type: 'stdio',
      allowed_origins: ['chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/'],
    }
    await mkdir(dirname(paths.chrome), { recursive: true })
    await writeFile(paths.chrome, JSON.stringify(flatpakManifest))

    const installer = new NativeMessagingInstaller({
      hostBinaryPath: '/opt/Motrix/resources/bin/motrix-native-host',
      manifestRoot: dir,
      platform: 'linux',
    })
    await installer.syncManifests({
      chromium: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      firefox: ['motrix-extension@motrix.app'],
    })

    expect(JSON.parse(await readFile(paths.chrome, 'utf-8'))).toEqual(
      flatpakManifest
    )
    await installer.unregister()
    expect(JSON.parse(await readFile(paths.chrome, 'utf-8'))).toEqual(
      flatpakManifest
    )
  })

  it('repairs a stale file that only resembles a companion manifest', async () => {
    const paths = computeManifestPaths('linux', dir)
    await mkdir(dirname(paths.chrome), { recursive: true })
    await writeFile(
      paths.chrome,
      JSON.stringify({
        name: 'app.motrix.bridge',
        path: '/tmp/motrix-flatpak-native-host',
      })
    )

    const hostBinaryPath = '/opt/Motrix/resources/bin/motrix-native-host'
    const installer = new NativeMessagingInstaller({
      hostBinaryPath,
      manifestRoot: dir,
      platform: 'linux',
    })
    await installer.syncManifests({
      chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
      firefox: ['motrix-extension@motrix.app'],
    })

    expect(JSON.parse(await readFile(paths.chrome, 'utf-8')).path).toBe(
      hostBinaryPath
    )
  })

  it('unregisters only manifests that still point to its own host', async () => {
    const paths = computeManifestPaths('linux', dir)
    const hostBinaryPath = '/opt/Motrix/resources/bin/motrix-native-host'
    const installer = new NativeMessagingInstaller({
      hostBinaryPath,
      manifestRoot: dir,
      platform: 'linux',
    })
    await installer.syncManifests({
      chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
      firefox: ['motrix-extension@motrix.app'],
    })

    const replacement = {
      name: 'app.motrix.bridge',
      path: `${dir}/.local/share/motrix/native-messaging/motrix-flatpak-native-host`,
    }
    await writeFile(paths.chrome, JSON.stringify(replacement))
    await installer.unregister()

    expect(JSON.parse(await readFile(paths.chrome, 'utf-8'))).toEqual(
      replacement
    )
    await expect(readFile(paths.chromium!, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(paths.firefox, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('computeManifestPaths (win32)', () => {
  it('returns private-folder JSON paths for Chrome, Edge, and Firefox', () => {
    const paths = computeManifestPaths('win32', 'C:/Users/me')
    expect(paths.chrome).toBe(
      'C:/Users/me/AppData/Roaming/Motrix/bridge/manifests/chrome.json'
    )
    expect(paths.edge).toBe(
      'C:/Users/me/AppData/Roaming/Motrix/bridge/manifests/edge.json'
    )
    expect(paths.firefox).toBe(
      'C:/Users/me/AppData/Roaming/Motrix/bridge/manifests/firefox.json'
    )
  })

  it('uses the resolved Roaming AppData folder when it is redirected', () => {
    const paths = computeManifestPaths(
      'win32',
      'C:/Users/me',
      'Z:/Profiles/me/Roaming'
    )

    expect(paths.chrome).toBe(
      'Z:/Profiles/me/Roaming/Motrix/bridge/manifests/chrome.json'
    )
    expect(paths.edge).toBe(
      'Z:/Profiles/me/Roaming/Motrix/bridge/manifests/edge.json'
    )
    expect(paths.firefox).toBe(
      'Z:/Profiles/me/Roaming/Motrix/bridge/manifests/firefox.json'
    )
  })
})

describe('computeRegistryEntries', () => {
  it('returns no entries on non-Windows platforms', () => {
    const paths = computeManifestPaths('darwin', '/Users/me')
    expect(computeRegistryEntries('darwin', paths)).toEqual([])
    expect(
      computeRegistryEntries('linux', computeManifestPaths('linux', '/home/me'))
    ).toEqual([])
  })

  it('registers Chrome and Edge under their own HKCU keys pointing at the JSON files', () => {
    const paths = computeManifestPaths('win32', 'C:/Users/me')
    const entries = computeRegistryEntries('win32', paths)

    expect(entries).toContainEqual({
      hive: 'HKCU',
      keyPath:
        'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\app.motrix.bridge',
      value: 'C:/Users/me/AppData/Roaming/Motrix/bridge/manifests/chrome.json',
    })
    expect(entries).toContainEqual({
      hive: 'HKCU',
      keyPath:
        'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\app.motrix.bridge',
      value: 'C:/Users/me/AppData/Roaming/Motrix/bridge/manifests/edge.json',
    })
  })

  it('also registers the Firefox host under the Mozilla key', () => {
    const paths = computeManifestPaths('win32', 'C:/Users/me')
    const entries = computeRegistryEntries('win32', paths)
    expect(entries).toContainEqual({
      hive: 'HKCU',
      keyPath: 'SOFTWARE\\Mozilla\\NativeMessagingHosts\\app.motrix.bridge',
      value: 'C:/Users/me/AppData/Roaming/Motrix/bridge/manifests/firefox.json',
    })
  })
})

describe('NativeMessagingInstaller.syncManifests (win32)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'motrix-nm-win-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the Edge manifest with both store IDs in allowed_origins', async () => {
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: 'C:/Program Files/Motrix/motrix-bridge-host.exe',
      manifestRoot: dir,
      platform: 'win32',
      registryWriter: async () => {},
    })
    await installer.syncManifests({
      chromium: [
        'chromewebstoreidaaaaaaaaaaaaaaaa',
        'edgeaddonsidbbbbbbbbbbbbbbbbbbbb',
      ],
      firefox: ['motrix-extension@motrix.app'],
    })
    const edge = JSON.parse(
      await readFile(
        join(dir, 'AppData/Roaming/Motrix/bridge/manifests/edge.json'),
        'utf-8'
      )
    )
    expect(edge.name).toBe('app.motrix.bridge')
    expect(edge.allowed_origins).toEqual([
      'chrome-extension://chromewebstoreidaaaaaaaaaaaaaaaa/',
      'chrome-extension://edgeaddonsidbbbbbbbbbbbbbbbbbbbb/',
    ])
  })

  it('registers Chrome and Edge native-messaging hosts in the registry', async () => {
    const written: Array<{ entry: RegistryEntry; view: RegistryView }> = []
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: 'C:/Program Files/Motrix/motrix-bridge-host.exe',
      manifestRoot: dir,
      platform: 'win32',
      registryWriter: async (entry, view) => {
        written.push({ entry, view })
      },
    })
    await installer.syncManifests({
      chromium: [
        'chromewebstoreidaaaaaaaaaaaaaaaa',
        'edgeaddonsidbbbbbbbbbbbbbbbbbbbb',
      ],
      firefox: ['motrix-extension@motrix.app'],
    })

    const keyPaths = written.map(({ entry }) => entry.keyPath)
    expect(keyPaths).toContain(
      'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\app.motrix.bridge'
    )
    expect(keyPaths).toContain(
      'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\app.motrix.bridge'
    )
    expect(written.every(({ entry }) => entry.hive === 'HKCU')).toBe(true)
    expect(
      written
        .filter(({ entry }) =>
          entry.keyPath.includes('Google\\Chrome\\NativeMessagingHosts')
        )
        .map(({ view }) => view)
    ).toEqual(['32', '64'])
  })

  it('does not touch the registry on macOS', async () => {
    const written: RegistryEntry[] = []
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: '/path/to/motrix-bridge-host',
      manifestRoot: dir,
      platform: 'darwin',
      registryWriter: async (entry) => {
        written.push(entry)
      },
    })
    await installer.syncManifests({
      chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
      firefox: ['motrix-extension@motrix.app'],
    })
    expect(written).toEqual([])
  })

  it('unregisters all Windows hosts and removes their manifests', async () => {
    const deleted: Array<{ entry: RegistryEntry; view: RegistryView }> = []
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: 'C:/Program Files/Motrix/motrix-bridge-host.exe',
      manifestRoot: dir,
      platform: 'win32',
      registryWriter: async () => {},
      registryDeleter: async (entry, view) => {
        deleted.push({ entry, view })
      },
    })
    await installer.syncManifests({
      chromium: ['chromewebstoreidaaaaaaaaaaaaaaaa'],
      firefox: ['motrix-extension@motrix.app'],
    })

    await installer.unregister()

    expect(
      deleted.map(({ entry, view }) => `${view}:${entry.keyPath}`)
    ).toEqual([
      '32:SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\app.motrix.bridge',
      '64:SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\app.motrix.bridge',
      '32:SOFTWARE\\Mozilla\\NativeMessagingHosts\\app.motrix.bridge',
      '64:SOFTWARE\\Mozilla\\NativeMessagingHosts\\app.motrix.bridge',
      '32:SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\app.motrix.bridge',
      '64:SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\app.motrix.bridge',
    ])
    await expect(
      readFile(
        join(dir, 'AppData/Roaming/Motrix/bridge/manifests/chrome.json'),
        'utf-8'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(
        join(dir, 'AppData/Roaming/Motrix/bridge/manifests/edge.json'),
        'utf-8'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(
        join(dir, 'AppData/Roaming/Motrix/bridge/manifests/firefox.json'),
        'utf-8'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can unregister repeatedly when manifests are already absent', async () => {
    const installer = new NativeMessagingInstaller({
      hostBinaryPath: 'C:/Program Files/Motrix/motrix-bridge-host.exe',
      manifestRoot: dir,
      platform: 'win32',
      registryDeleter: async () => {},
    })

    await installer.unregister()
    await installer.unregister()
  })
})
