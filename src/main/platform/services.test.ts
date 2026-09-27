import { RunHost } from '@shared/platform/services'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalResourcesPath = Object.getOwnPropertyDescriptor(
  process,
  'resourcesPath'
)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalWindowsStore = Object.getOwnPropertyDescriptor(
  process,
  'windowsStore'
)

const mocks = vi.hoisted(() => {
  const state = {
    isPackaged: false,
    paths: { userData: '/fake/Motrix' } as Record<string, string>,
    operations: [] as string[],
  }

  return {
    state,
    mkdirSync: vi.fn((directory: string) => {
      state.operations.push(`mkdir:${directory}`)
    }),
    getPath: vi.fn((name: string) => state.paths[name] ?? `/fake/${name}`),
    setPath: vi.fn((name: string, value: string) => {
      state.operations.push(`setPath:${name}:${value}`)
      state.paths[name] = value
    }),
  }
})

vi.mock('node:fs', () => ({
  default: { mkdirSync: mocks.mkdirSync },
  mkdirSync: mocks.mkdirSync,
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.state.isPackaged
    },
    getPath: mocks.getPath,
    setPath: mocks.setPath,
  },
}))

import { createElectronPlatformServices } from './services'

describe('createElectronPlatformServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.isPackaged = false
    mocks.state.paths = { userData: '/fake/Motrix' }
    mocks.state.operations = []
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/fake/resources',
    })
    Object.defineProperty(process, 'windowsStore', {
      configurable: true,
      value: false,
    })
    delete process.env.MOTRIX_USER_DATA
    vi.stubEnv('MOTRIX_BRIDGE_DATA_DIR', undefined)
  })

  afterEach(() => {
    delete process.env.MOTRIX_USER_DATA
    vi.unstubAllEnvs()
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalWindowsStore) {
      Object.defineProperty(process, 'windowsStore', originalWindowsStore)
    } else {
      Reflect.deleteProperty(process, 'windowsStore')
    }
  })

  it('uses a sibling development profile by default', () => {
    const svc = createElectronPlatformServices()

    expect(svc.host).toBe(RunHost.Electron)
    expect(svc.userDataDir).toBe('/fake/Motrix-dev')
    expect(svc.isDev).toBe(true)
    expect(
      svc.aria2BinaryPath.endsWith(
        process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
      )
    ).toBe(true)
    expect(svc.extraResourceDir).toMatch(/extra$/)
  })

  it('gives MOTRIX_USER_DATA priority in development', () => {
    process.env.MOTRIX_USER_DATA = '/tmp/motrix-custom'

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/tmp/motrix-custom')
  })

  it('ignores an empty MOTRIX_USER_DATA value', () => {
    process.env.MOTRIX_USER_DATA = ''

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/fake/Motrix-dev')
  })

  it('keeps the Electron user data directory unchanged when packaged', () => {
    mocks.state.isPackaged = true

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/fake/Motrix')
    expect(svc.isDev).toBe(false)
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.setPath).not.toHaveBeenCalled()
  })

  it('honors MOTRIX_USER_DATA when packaged', () => {
    mocks.state.isPackaged = true
    process.env.MOTRIX_USER_DATA = '/tmp/motrix-packaged'

    const svc = createElectronPlatformServices()

    expect(svc.userDataDir).toBe('/tmp/motrix-packaged')
    expect(mocks.mkdirSync).toHaveBeenCalledWith('/tmp/motrix-packaged', {
      recursive: true,
    })
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      1,
      'userData',
      '/tmp/motrix-packaged'
    )
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      2,
      'sessionData',
      '/tmp/motrix-packaged'
    )
  })

  it.each([false, true])(
    'preserves bridge directory overrides outside Windows packages (packaged=%s)',
    (isPackaged) => {
      mocks.state.isPackaged = isPackaged
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32',
      })
      Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: !isPackaged,
      })
      process.env.MOTRIX_BRIDGE_DATA_DIR = '/tmp/shared-bridge'

      expect(() => createElectronPlatformServices()).not.toThrow()
      expect(process.env.MOTRIX_BRIDGE_DATA_DIR).toBe('/tmp/shared-bridge')
    }
  )

  it('rejects a relative MOTRIX_USER_DATA before creating it', () => {
    process.env.MOTRIX_USER_DATA = 'relative/profile'

    expect(() => createElectronPlatformServices()).toThrow(
      'MOTRIX_USER_DATA must be an absolute path'
    )
    expect(mocks.mkdirSync).not.toHaveBeenCalled()
    expect(mocks.setPath).not.toHaveBeenCalled()
  })

  it('creates the selected directory before setting both Electron paths', () => {
    createElectronPlatformServices()

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/fake/Motrix-dev', {
      recursive: true,
    })
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      1,
      'userData',
      '/fake/Motrix-dev'
    )
    expect(mocks.setPath).toHaveBeenNthCalledWith(
      2,
      'sessionData',
      '/fake/Motrix-dev'
    )
    expect(mocks.state.operations).toEqual([
      'mkdir:/fake/Motrix-dev',
      'setPath:userData:/fake/Motrix-dev',
      'setPath:sessionData:/fake/Motrix-dev',
    ])
  })

  describe('Windows package profile', () => {
    const appData = 'C:\\Users\\Test User\\AppData\\Roaming'
    const storeProfile = `${appData}\\Motrix-Store`

    beforeEach(() => {
      mocks.state.isPackaged = true
      mocks.state.paths = {
        appData,
        userData: `${appData}\\Motrix`,
        sessionData: `${appData}\\Motrix`,
      }
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32',
      })
      Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: true,
      })
    })

    it('selects a separate root without reading the direct-install profile', () => {
      const svc = createElectronPlatformServices()

      expect(svc.userDataDir).toBe(storeProfile)
      expect(svc.isDev).toBe(false)
      expect(mocks.getPath.mock.calls).toEqual([['appData']])
      expect(mocks.state.paths.userData).toBe(storeProfile)
      expect(mocks.state.paths.sessionData).toBe(storeProfile)
    })

    it('sets both paths before returning services to persistent consumers', () => {
      const svc = createElectronPlatformServices()
      mocks.state.operations.push(`persistent-service:${svc.userDataDir}`)

      expect(mocks.state.operations).toEqual([
        `mkdir:${storeProfile}`,
        `setPath:userData:${storeProfile}`,
        `setPath:sessionData:${storeProfile}`,
        `persistent-service:${storeProfile}`,
      ])
    })

    it.each([
      'C:\\Users\\Test User\\AppData\\Roaming\\Motrix',
      'C:\\isolated-but-unverified',
      'relative/profile',
      ' ',
    ])('rejects nonempty overrides before any path access: %s', (override) => {
      process.env.MOTRIX_USER_DATA = override

      expect(() => createElectronPlatformServices()).toThrow(
        'MOTRIX_USER_DATA is unsupported for Windows packages'
      )
      expect(mocks.getPath).not.toHaveBeenCalled()
      expect(mocks.mkdirSync).not.toHaveBeenCalled()
      expect(mocks.setPath).not.toHaveBeenCalled()
    })

    it('treats an empty override as absent and still isolates the profile', () => {
      process.env.MOTRIX_USER_DATA = ''

      expect(createElectronPlatformServices().userDataDir).toBe(storeProfile)
    })

    it.each([
      'C:\\Users\\Test User\\AppData\\Roaming\\Motrix\\bridge',
      'C:\\isolated-but-unverified\\bridge',
      'relative/bridge',
      ' ',
    ])(
      'rejects nonempty bridge overrides before path access: %s',
      (override) => {
        process.env.MOTRIX_BRIDGE_DATA_DIR = override

        expect(() => createElectronPlatformServices()).toThrow(
          'MOTRIX_BRIDGE_DATA_DIR is unsupported for Windows packages'
        )
        expect(mocks.getPath).not.toHaveBeenCalled()
        expect(mocks.mkdirSync).not.toHaveBeenCalled()
        expect(mocks.setPath).not.toHaveBeenCalled()
      }
    )

    it('ignores an empty bridge override and keeps the isolated profile', () => {
      process.env.MOTRIX_BRIDGE_DATA_DIR = ''

      expect(createElectronPlatformServices().userDataDir).toBe(storeProfile)
    })

    it.each([
      [
        'C:\\Users\\测试 用户\\AppData\\Roaming',
        'C:\\Users\\测试 用户\\AppData\\Roaming\\Motrix-Store',
      ],
      [
        '\\\\server\\profiles\\tester',
        '\\\\server\\profiles\\tester\\Motrix-Store',
      ],
    ])(
      'preserves the AppData root selected by Electron: %s',
      (base, expected) => {
        mocks.state.paths.appData = base

        expect(createElectronPlatformServices().userDataDir).toBe(expected)
      }
    )

    it('rejects a relative AppData root before changing paths', () => {
      mocks.state.paths.appData = 'relative/appdata'

      expect(() => createElectronPlatformServices()).toThrow(
        'Windows package AppData must be an absolute path'
      )
      expect(mocks.mkdirSync).not.toHaveBeenCalled()
      expect(mocks.setPath).not.toHaveBeenCalled()
    })

    it('does not fall back to a direct profile when directory creation fails', () => {
      mocks.mkdirSync.mockImplementationOnce(() => {
        throw new Error('access denied')
      })

      expect(() => createElectronPlatformServices()).toThrow('access denied')
      expect(mocks.getPath.mock.calls).toEqual([['appData']])
      expect(mocks.setPath).not.toHaveBeenCalled()
    })

    it('accepts the same resolved context used by main startup', () => {
      Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: false,
      })

      expect(
        createElectronPlatformServices({
          distribution: 'windows-package',
          isWindowsPackage: true,
        }).userDataDir
      ).toBe(storeProfile)
    })

    it('preserves the direct Windows profile when the package flag is absent', () => {
      Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: undefined,
      })

      expect(createElectronPlatformServices().userDataDir).toBe(
        `${appData}\\Motrix`
      )
      expect(mocks.getPath.mock.calls).toEqual([['userData']])
      expect(mocks.setPath).not.toHaveBeenCalled()
    })

    it('honors direct Windows absolute overrides without package isolation', () => {
      Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: false,
      })
      process.env.MOTRIX_USER_DATA = 'D:\\test-profile'

      expect(createElectronPlatformServices().userDataDir).toBe(
        'D:\\test-profile'
      )
      expect(mocks.setPath).toHaveBeenCalledWith(
        'sessionData',
        'D:\\test-profile'
      )
    })

    it('uses the existing development override even if windowsStore is true', () => {
      mocks.state.isPackaged = false
      process.env.MOTRIX_USER_DATA = 'D:\\development-profile'

      const svc = createElectronPlatformServices()

      expect(svc.isDev).toBe(true)
      expect(svc.userDataDir).toBe('D:\\development-profile')
      expect(mocks.getPath.mock.calls).toEqual([['userData']])
    })
  })
})
