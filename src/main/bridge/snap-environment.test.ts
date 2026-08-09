import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isElectronSelfUpdateSupported,
  isLegacySnapDefaultSaveDir,
  resolveBridgeDataDir,
  resolvePackagedLinuxSnapEnvironment,
} from './snap-environment'

const validSnapOptions = {
  platform: 'linux' as const,
  isPackaged: true,
  resourcesPath: '/snap/motrix/current/resources',
  env: {
    SNAP: '/snap/motrix/current',
    SNAP_REAL_HOME: '/home/user',
    SNAP_INSTANCE_NAME: 'motrix',
    SNAP_NAME: 'motrix',
  },
}

describe('resolvePackagedLinuxSnapEnvironment', () => {
  it('resolves the real home and instance for a packaged Linux Snap', () => {
    expect(resolvePackagedLinuxSnapEnvironment(validSnapOptions)).toEqual({
      installRoot: '/snap/motrix/current',
      realHome: '/home/user',
      instanceName: 'motrix',
    })
  })

  it('supports parallel instances and the SNAP_NAME fallback', () => {
    expect(
      resolvePackagedLinuxSnapEnvironment({
        ...validSnapOptions,
        resourcesPath: '/snap/motrix/current/resources',
        env: {
          SNAP: '/snap/motrix/current',
          SNAP_REAL_HOME: '/home/user',
          SNAP_INSTANCE_NAME: 'motrix_work',
          SNAP_NAME: 'motrix',
        },
      })
    ).toMatchObject({ instanceName: 'motrix_work' })

    expect(
      resolvePackagedLinuxSnapEnvironment({
        ...validSnapOptions,
        env: {
          SNAP: '/snap/motrix/current',
          SNAP_REAL_HOME: '/home/user',
          SNAP_NAME: 'motrix',
        },
      })
    ).toMatchObject({ instanceName: 'motrix' })
  })

  it('ignores Snap-looking variables outside a packaged Linux app', () => {
    const hostileEnv = {
      SNAP: '../not-a-snap',
      SNAP_REAL_HOME: '/',
      SNAP_INSTANCE_NAME: '../../escape',
    }
    expect(
      resolvePackagedLinuxSnapEnvironment({
        ...validSnapOptions,
        isPackaged: false,
        env: hostileEnv,
      })
    ).toBeNull()
    expect(
      resolvePackagedLinuxSnapEnvironment({
        ...validSnapOptions,
        platform: 'darwin',
        env: hostileEnv,
      })
    ).toBeNull()
  })

  it('treats a missing SNAP variable as a non-Snap package', () => {
    expect(
      resolvePackagedLinuxSnapEnvironment({
        ...validSnapOptions,
        env: {
          SNAP_REAL_HOME: '/home/user',
          SNAP_INSTANCE_NAME: 'motrix',
        },
      })
    ).toBeNull()
  })

  it.each([
    {
      name: 'missing real home',
      env: { SNAP: '/snap/motrix/current', SNAP_INSTANCE_NAME: 'motrix' },
    },
    {
      name: 'relative real home',
      env: {
        SNAP: '/snap/motrix/current',
        SNAP_REAL_HOME: '../home',
        SNAP_INSTANCE_NAME: 'motrix',
      },
    },
    {
      name: 'root real home',
      env: {
        SNAP: '/snap/motrix/current',
        SNAP_REAL_HOME: '/',
        SNAP_INSTANCE_NAME: 'motrix',
      },
    },
    {
      name: 'traversing install root',
      env: {
        SNAP: '/snap/motrix/../other/current',
        SNAP_REAL_HOME: '/home/user',
        SNAP_INSTANCE_NAME: 'motrix',
      },
    },
    {
      name: 'host path injection',
      env: {
        SNAP: '/snap/motrix/current',
        SNAP_REAL_HOME: '/home/user',
        SNAP_INSTANCE_NAME: '../../escape',
      },
    },
    {
      name: 'mismatched instance mount',
      env: {
        SNAP: '/snap/other/current',
        SNAP_REAL_HOME: '/home/user',
        SNAP_INSTANCE_NAME: 'motrix',
      },
    },
    {
      name: 'mismatched snap and instance names',
      env: {
        SNAP: '/snap/other/current',
        SNAP_REAL_HOME: '/home/user',
        SNAP_INSTANCE_NAME: 'motrix_work',
        SNAP_NAME: 'other',
      },
    },
  ])('rejects a malformed partial Snap environment: $name', ({ env }) => {
    expect(() =>
      resolvePackagedLinuxSnapEnvironment({ ...validSnapOptions, env })
    ).toThrow()
  })

  it('rejects resources outside the declared Snap mount', () => {
    expect(() =>
      resolvePackagedLinuxSnapEnvironment({
        ...validSnapOptions,
        resourcesPath: '/opt/Motrix/resources',
      })
    ).toThrow('process.resourcesPath must be inside SNAP')
  })
})

describe('isElectronSelfUpdateSupported', () => {
  it('keeps snapd as the only application update authority', () => {
    expect(
      isElectronSelfUpdateSupported({
        hasUpdateMetadata: true,
        isPackaged: true,
        snapEnvironment: {
          installRoot: '/snap/motrix/current',
          instanceName: 'motrix',
          realHome: '/home/user',
        },
      })
    ).toBe(false)
  })

  it('preserves self-updates for packaged non-Snap distributions', () => {
    expect(
      isElectronSelfUpdateSupported({
        hasUpdateMetadata: true,
        isPackaged: true,
        snapEnvironment: null,
      })
    ).toBe(true)
    expect(
      isElectronSelfUpdateSupported({
        hasUpdateMetadata: false,
        isPackaged: true,
        snapEnvironment: null,
      })
    ).toBe(false)
  })
})

describe('isLegacySnapDefaultSaveDir', () => {
  const snap = {
    instanceName: 'motrix',
    realHome: '/home/user',
  }

  it.each([
    '/home/user/snap/motrix/123/Downloads',
    '/home/user/snap/motrix/current/Downloads',
  ])('recognizes the historical revision-scoped default: %s', (value) => {
    expect(isLegacySnapDefaultSaveDir(value, snap)).toBe(true)
  })

  it('supports the exact parallel-instance data directory', () => {
    expect(
      isLegacySnapDefaultSaveDir('/home/user/snap/motrix_work/42/Downloads', {
        instanceName: 'motrix_work',
        realHome: '/home/user',
      })
    ).toBe(true)
  })

  it.each([
    '/home/user/Downloads',
    '/mnt/downloads',
    '/home/user/snap/motrix/123/custom',
    '/home/user/snap/motrix/0/Downloads',
    '/home/user/snap/motrix_work/42/Downloads',
    '/home/user/snap/motrix/123/../Downloads',
  ])('preserves non-default and malformed paths: %s', (value) => {
    expect(isLegacySnapDefaultSaveDir(value, snap)).toBe(false)
  })
})

describe('resolveBridgeDataDir', () => {
  it('preserves the userData bridge path when no override exists', () => {
    expect(resolveBridgeDataDir('/home/user/.config/motrix', undefined)).toBe(
      join('/home/user/.config/motrix', 'bridge')
    )
  })

  it('uses an absolute revision-independent bridge directory verbatim', () => {
    const bridgeDir =
      process.platform === 'win32'
        ? String.raw`C:\Users\user\snap\motrix\common\bridge`
        : '/home/user/snap/motrix/common/bridge'
    expect(
      resolveBridgeDataDir(
        join('home', 'user', 'snap', 'motrix', 'current', '.config', 'motrix'),
        bridgeDir
      )
    ).toBe(bridgeDir)
  })

  it.each([
    '',
    ' ',
    'relative/bridge',
    '/',
    '/home/user/common/../escape',
    '/home/user/common/bridge ',
    '/home/user/common/\0bridge',
  ])('rejects a malformed bridge override: %j', (override) => {
    expect(() => resolveBridgeDataDir('/fallback', override)).toThrow(
      'MOTRIX_BRIDGE_DATA_DIR must be a canonical absolute directory'
    )
  })
})
