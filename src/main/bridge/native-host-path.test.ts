import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  nativeHostBinaryName,
  resolveNativeHostBinaryPath,
} from './native-host-path'
import { NativeMessagingInstaller } from './native-messaging-installer'
import { resolvePackagedLinuxSnapEnvironment } from './snap-environment'

describe('resolveNativeHostBinaryPath', () => {
  it.each([
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ] as const)('resolves the packaged %s-%s binary', (platform, arch) => {
    const resourcesPath = join('/app', 'Motrix', 'resources')
    const binaryName = nativeHostBinaryName(platform)

    expect(
      resolveNativeHostBinaryPath({
        platform,
        arch,
        isPackaged: true,
        resourcesPath,
        cwd: '/workspace',
      })
    ).toBe(join(resourcesPath, 'bin', binaryName))
  })

  it.each([
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ] as const)('resolves the development %s-%s binary', (platform, arch) => {
    const cwd = join('/workspace', 'motrix-turbo')
    const binaryName = nativeHostBinaryName(platform)

    expect(
      resolveNativeHostBinaryPath({
        platform,
        arch,
        isPackaged: false,
        resourcesPath: '/unused',
        cwd,
      })
    ).toBe(
      join(
        cwd,
        'packages',
        'native-host',
        'dist',
        `${platform}-${arch}`,
        binaryName
      )
    )
  })

  it('uses MOTRIX_BRIDGE_HOST_BIN semantics only in development', () => {
    const devOverride = join('/tmp', 'custom-native-host')
    const common = {
      platform: 'darwin' as const,
      arch: 'arm64',
      resourcesPath: join('/app', 'resources'),
      cwd: '/workspace',
      devOverride,
    }

    expect(resolveNativeHostBinaryPath({ ...common, isPackaged: false })).toBe(
      devOverride
    )
    expect(resolveNativeHostBinaryPath({ ...common, isPackaged: true })).toBe(
      join(common.resourcesPath, 'bin', 'motrix-native-host')
    )
  })

  it('uses the stable snapd command wrapper for packaged Linux', () => {
    expect(
      resolveNativeHostBinaryPath({
        platform: 'linux',
        arch: 'arm64',
        isPackaged: true,
        resourcesPath: '/snap/motrix_work/current/resources',
        cwd: '/unused',
        devOverride: '/tmp/ignored',
        snapInstanceName: 'motrix_work',
      })
    ).toBe('/snap/bin/motrix_work.native-host')
  })

  it('rejects an injected Snap instance name', () => {
    expect(() =>
      resolveNativeHostBinaryPath({
        platform: 'linux',
        arch: 'x64',
        isPackaged: true,
        resourcesPath: '/snap/motrix/current/resources',
        cwd: '/unused',
        snapInstanceName: '../../escape',
      })
    ).toThrow('Invalid Snap native-host instance name')
  })

  it('rejects unsupported architectures instead of falling back to x64', () => {
    expect(() =>
      resolveNativeHostBinaryPath({
        platform: 'linux',
        arch: 'ia32',
        isPackaged: false,
        resourcesPath: '/unused',
        cwd: '/workspace',
      })
    ).toThrow('Unsupported native-host architecture: ia32')
  })

  it('writes the Windows arm64 executable path into browser manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motrix-native-host-path-'))
    try {
      const resourcesPath = join(root, 'Motrix', 'resources')
      const windowsRoamingAppData = join(root, 'Roaming')
      const hostBinaryPath = resolveNativeHostBinaryPath({
        platform: 'win32',
        arch: 'arm64',
        isPackaged: true,
        resourcesPath,
        cwd: '/unused',
      })
      const installer = new NativeMessagingInstaller({
        hostBinaryPath,
        manifestRoot: root,
        platform: 'win32',
        windowsRoamingAppData,
        registryWriter: async () => {},
      })

      await installer.syncManifests({
        chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
        firefox: ['motrix-extension@motrix.app'],
      })

      const manifest = JSON.parse(
        await readFile(
          join(windowsRoamingAppData, 'Motrix/bridge/manifests/chrome.json'),
          'utf8'
        )
      )
      expect(hostBinaryPath).toBe(
        join(resourcesPath, 'bin', 'motrix-native-host.exe')
      )
      expect(manifest.path).toBe(hostBinaryPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'writes Snap manifests into SNAP_REAL_HOME with the snapd wrapper',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'motrix-snap-manifest-'))
      try {
        const snap = resolvePackagedLinuxSnapEnvironment({
          platform: 'linux',
          isPackaged: true,
          resourcesPath: '/snap/motrix/current/resources',
          env: {
            SNAP: '/snap/motrix/current',
            SNAP_REAL_HOME: root,
            SNAP_INSTANCE_NAME: 'motrix',
          },
        })
        expect(snap).not.toBeNull()
        const hostBinaryPath = resolveNativeHostBinaryPath({
          platform: 'linux',
          arch: 'x64',
          isPackaged: true,
          resourcesPath: '/snap/motrix/current/resources',
          cwd: '/unused',
          snapInstanceName: snap?.instanceName,
        })
        const installer = new NativeMessagingInstaller({
          hostBinaryPath,
          manifestRoot: snap?.realHome ?? '/unreachable',
          platform: 'linux',
        })

        await installer.syncManifests({
          chromium: ['ibpkjhgpbidfmbmomagmldcdlpbmchgi'],
          firefox: ['motrix-extension@motrix.app'],
        })

        const manifest = JSON.parse(
          await readFile(
            join(
              root,
              '.config/google-chrome/NativeMessagingHosts/app.motrix.bridge.json'
            ),
            'utf8'
          )
        )
        expect(manifest.path).toBe('/snap/bin/motrix.native-host')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
